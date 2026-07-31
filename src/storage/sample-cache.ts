import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir, rename, unlink, rm } from "fs/promises";
import { join, basename, dirname } from "path";
import { createHash, randomBytes } from "crypto";
import type { TokenUsage, CostBreakdown } from "../types.js";
import { safeReaddir, safeReadJson, removeIfEmpty } from "./fs-utils.js";
import { listRuns, loadRun } from "./run-store.js";

// ── Cached entry types ──────────────────────────────

export interface CachedWrite {
  cacheId: string; // Stable ID across runs (original nanoid)
  text: string;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
  createdAt: string;
}

export interface CachedFeedback {
  cacheId: string;
  writeCacheId: string; // Which cached write this feedback is for
  sourceModel: string; // Feedback provider label at time of generation
  text: string;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
  createdAt: string;
}

export interface CachedRevision {
  cacheId: string;
  feedbackCacheId: string; // Which cached feedback this revision used
  text: string;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
  createdAt: string;
}

export interface CachedJudgment {
  cacheId: string;
  /** Winner relative to sorted (first, second) cache ID order */
  winner: "A" | "B" | "tie";
  reasoning: string;
  stage: "initial" | "revised" | "improvement";
  /** Sorted cache ID pair used by this judgment. */
  firstCacheId?: string;
  /** Sorted cache ID pair used by this judgment. */
  secondCacheId?: string;
  /** Position swap state from the original API call. undefined for legacy cache entries. */
  positionSwapped?: boolean;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
  createdAt: string;
}

export type CacheArtifactCategory = "writes" | "feedback" | "revisions" | "judgments";

export interface CacheArtifactSummary {
  category: CacheArtifactCategory;
  /** Unique key within a category for later detail lookup. */
  artifactKey: string;
  modelKey: string;
  cacheId?: string;
  createdAt?: string;
  promptHash?: string;
  outputIndex?: number;
  stage?: string;
  comparisonLabel?: string;
  comparedCacheIds?: [string, string];
  preview: string;
}

export interface CacheArtifactDetail {
  category: CacheArtifactCategory;
  artifactKey: string;
  modelKey: string;
  payload: unknown;
}

interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
}

interface CostLike {
  total?: number;
  totalUncached?: number;
}

interface CachedOutputLocator {
  category: "writes" | "revisions";
  modelKey: string;
  path: string;
  promptHash?: string;
  outputIndex?: number;
}

export interface JudgmentComparedOutput {
  cacheId: string;
  category: "writes" | "revisions";
  modelKey: string;
  promptHash?: string;
  outputIndex?: number;
  text: string;
}

export interface JudgmentComparedPair {
  first: JudgmentComparedOutput;
  second: JudgmentComparedOutput;
}

interface RunOutputLocator {
  category: "writes" | "revisions";
  modelKey: string;
  outputIndex?: number;
  text: string;
}

// ── Helpers ─────────────────────────────────────────

/**
 * Hash prompt content to create a stable cache key that auto-invalidates
 * when the prompt text changes. Uses first 16 hex chars of SHA-256.
 */
export function hashPromptContent(promptText: string): string {
  const normalized = promptText.trim().replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Convert a model identity to a filesystem-safe cache path.
 * Uses URL encoding for a lossless round-trip.
 */
export function modelKey(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}__${encodeURIComponent(model)}`;
}

/**
 * Reverse a modelKey path back to a "provider:model" spec.
 * Expects the current lossless format only.
 */
export function specFromModelKey(key: string): string | null {
  const sep = key.indexOf("__");
  if (sep > 0 && sep < key.length - 2) {
    const provider = decodeURIComponent(key.slice(0, sep));
    const model = decodeURIComponent(key.slice(sep + 2));
    return `${provider}:${model}`;
  }
  return null;
}

function modelKeyFromRegistryId(registryId?: string, fallbackLabel?: string): string {
  if (!registryId || !registryId.includes(":")) {
    return fallbackLabel ?? "unknown";
  }
  const splitAt = registryId.indexOf(":");
  if (splitAt <= 0 || splitAt >= registryId.length - 1) {
    return fallbackLabel ?? registryId;
  }
  const provider = registryId.slice(0, splitAt);
  const model = registryId.slice(splitAt + 1);
  return modelKey(provider, model);
}

async function buildRunOutputLocatorIndex(): Promise<Map<string, RunOutputLocator>> {
  const index = new Map<string, RunOutputLocator>();
  const runIds = await listRuns();

  for (const runId of runIds) {
    let run;
    try {
      run = await loadRun(runId);
    } catch {
      continue;
    }

    for (const sample of run.samples) {
      if (index.has(sample.id)) {
        continue;
      }
      index.set(sample.id, {
        category: sample.stage === "initial" ? "writes" : "revisions",
        modelKey: modelKeyFromRegistryId(sample.registryId, sample.model),
        outputIndex: sample.outputIndex,
        text: sample.text,
      });
    }
  }

  return index;
}

async function getRunOutputLocatorIndex(): Promise<Map<string, RunOutputLocator>> {
  return buildRunOutputLocatorIndex();
}

/**
 * List all model keys in a cache category directory, handling both flat
 * (provider_model/) and nested (provider_namespace/model/) layouts.
 */
export async function discoverModelKeys(categoryDir: string): Promise<string[]> {
  const topLevel = await safeReaddir(categoryDir);
  const discovered = await Promise.all(topLevel.map((entry) => discoverModelKeysInDir(categoryDir, entry)));
  return discovered.flat();
}

async function discoverModelKeysInDir(categoryDir: string, relativeDir: string): Promise<string[]> {
  const children = await safeReaddir(join(categoryDir, relativeDir));
  if (children.length === 0) {
    return [relativeDir];
  }

  const isModelDir = children.some((child) => child.endsWith(".json") || /^[0-9a-f]{16}$/.test(child));
  if (isModelDir) {
    return [relativeDir];
  }

  const discovered = await Promise.all(children.map((child) => discoverModelKeysInDir(categoryDir, `${relativeDir}/${child}`)));
  return discovered.flat();
}

/**
 * Hash a judgment pair key (stage + two sorted cache IDs) into a
 * filesystem-safe name.
 */
export function judgmentPairHash(
  stage: string,
  cacheIdA: string,
  cacheIdB: string
): string {
  const sorted = [cacheIdA, cacheIdB].sort();
  const input = `${stage}:${sorted[0]}:${sorted[1]}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Flip a winner value: A↔B, tie stays tie.
 */
function flipWinner(winner: "A" | "B" | "tie"): "A" | "B" | "tie" {
  if (winner === "A") return "B";
  if (winner === "B") return "A";
  return "tie";
}

/** Flip a positionSwapped flag, preserving undefined for legacy entries. */
function flipPositionSwapped(swapped?: boolean): boolean | undefined {
  return swapped != null ? !swapped : undefined;
}

function compactPreview(value: unknown, maxLen: number = 96): string {
  if (typeof value !== "string") {
    return "";
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) {
    return compact;
  }
  return compact.slice(0, maxLen - 3) + "...";
}

function allPairs<T>(items: T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push([items[i], items[j]]);
    }
  }
  return pairs;
}

// ── Sample Cache ────────────────────────────────────

const DEFAULT_CACHE_DIR = join(process.cwd(), "data", "cache");

export class SampleCache {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_CACHE_DIR;
  }

  // ── Writes ──────────────────────────────────────

  private writesDir(provider: string, model: string, promptHash: string): string {
    return join(this.baseDir, "writes", modelKey(provider, model), promptHash);
  }

  async getCachedWrites(
    provider: string,
    model: string,
    promptText: string
  ): Promise<CachedWrite[]> {
    const dir = this.writesDir(provider, model, hashPromptContent(promptText));
    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
        const nb = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
        return na - nb;
      });
    const results: CachedWrite[] = [];

    for (const f of jsonFiles) {
      try {
        const raw = await readFile(join(dir, f), "utf-8");
        results.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }

    return results;
  }

  async addCachedWrite(
    provider: string,
    model: string,
    promptText: string,
    entry: CachedWrite,
    outputIndex: number,
  ): Promise<void> {
    const dir = this.writesDir(provider, model, hashPromptContent(promptText));
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, `sample_${outputIndex}.json`);
    const tmpPath = filePath + `.tmp.${randomBytes(4).toString("hex")}`;

    await writeFile(tmpPath, JSON.stringify(entry, null, 2));
    await rename(tmpPath, filePath);
  }

  // ── Feedback ────────────────────────────────────

  private feedbackDir(provider: string, model: string): string {
    return join(this.baseDir, "feedback", modelKey(provider, model));
  }

  private feedbackPath(
    provider: string,
    model: string,
    writeCacheId: string
  ): string {
    return join(this.feedbackDir(provider, model), `${writeCacheId}.json`);
  }

  async getCachedFeedback(
    fbProvider: string,
    fbModel: string,
    writeCacheId: string
  ): Promise<CachedFeedback | null> {
    const path = this.feedbackPath(fbProvider, fbModel, writeCacheId);
    if (!existsSync(path)) return null;

    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async addCachedFeedback(
    fbProvider: string,
    fbModel: string,
    writeCacheId: string,
    entry: CachedFeedback
  ): Promise<void> {
    const dir = this.feedbackDir(fbProvider, fbModel);
    await mkdir(dir, { recursive: true });

    const filePath = this.feedbackPath(fbProvider, fbModel, writeCacheId);
    const tmpPath = filePath + `.tmp.${randomBytes(4).toString("hex")}`;

    await writeFile(tmpPath, JSON.stringify(entry, null, 2));
    await rename(tmpPath, filePath);
  }

  // ── Revisions ───────────────────────────────────

  private revisionsDir(provider: string, model: string): string {
    return join(this.baseDir, "revisions", modelKey(provider, model));
  }

  private revisionPath(
    provider: string,
    model: string,
    feedbackCacheId: string
  ): string {
    return join(this.revisionsDir(provider, model), `${feedbackCacheId}.json`);
  }

  async getCachedRevision(
    writerProvider: string,
    writerModel: string,
    feedbackCacheId: string
  ): Promise<CachedRevision | null> {
    const path = this.revisionPath(writerProvider, writerModel, feedbackCacheId);
    if (!existsSync(path)) return null;

    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async addCachedRevision(
    writerProvider: string,
    writerModel: string,
    feedbackCacheId: string,
    entry: CachedRevision
  ): Promise<void> {
    const dir = this.revisionsDir(writerProvider, writerModel);
    await mkdir(dir, { recursive: true });

    const filePath = this.revisionPath(writerProvider, writerModel, feedbackCacheId);
    const tmpPath = filePath + `.tmp.${randomBytes(4).toString("hex")}`;

    await writeFile(tmpPath, JSON.stringify(entry, null, 2));
    await rename(tmpPath, filePath);
  }
  // ── Judgments ──────────────────────────────────────

  /** Path to a judge model's cache directory. */
  judgmentsDir(provider: string, model: string): string {
    return join(this.baseDir, "judgments", modelKey(provider, model));
  }

  private judgmentPath(
    provider: string,
    model: string,
    stage: string,
    cacheIdA: string,
    cacheIdB: string
  ): string {
    const hash = judgmentPairHash(stage, cacheIdA, cacheIdB);
    return join(this.judgmentsDir(provider, model), `${hash}.json`);
  }

  /**
   * Look up a cached judgment. Returns the entry with the winner
   * adjusted to match the caller's A/B ordering (not the stored
   * sorted order).
   */
  async getCachedJudgment(
    judgeProvider: string,
    judgeModel: string,
    stage: string,
    cacheIdA: string,
    cacheIdB: string
  ): Promise<CachedJudgment | null> {
    const path = this.judgmentPath(
      judgeProvider,
      judgeModel,
      stage,
      cacheIdA,
      cacheIdB
    );
    if (!existsSync(path)) return null;

    try {
      const raw = await readFile(path, "utf-8");
      const entry: CachedJudgment = JSON.parse(raw);

      // Winner and positionSwapped are stored relative to sorted order.
      // If the caller's A sorts first, they match. Otherwise flip both.
      const [sortedFirst] = [cacheIdA, cacheIdB].sort();
      if (cacheIdA !== sortedFirst) {
        return {
          ...entry,
          winner: flipWinner(entry.winner),
          positionSwapped: flipPositionSwapped(entry.positionSwapped),
        };
      }
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Store a judgment. The winner is normalized to sorted cache ID
   * order so lookups with swapped A/B still hit the same entry.
   */
  async addCachedJudgment(
    judgeProvider: string,
    judgeModel: string,
    stage: string,
    cacheIdA: string,
    cacheIdB: string,
    entry: CachedJudgment
  ): Promise<void> {
    const dir = this.judgmentsDir(judgeProvider, judgeModel);
    await mkdir(dir, { recursive: true });

    // Normalize winner and positionSwapped to sorted order
    const [sortedFirst, sortedSecond] = [cacheIdA, cacheIdB].sort();
    const normalized: CachedJudgment =
      cacheIdA === sortedFirst
        ? {
            ...entry,
            firstCacheId: sortedFirst,
            secondCacheId: sortedSecond,
          }
        : {
            ...entry,
            winner: flipWinner(entry.winner),
            positionSwapped: flipPositionSwapped(entry.positionSwapped),
            firstCacheId: sortedFirst,
            secondCacheId: sortedSecond,
          };

    const filePath = this.judgmentPath(
      judgeProvider,
      judgeModel,
      stage,
      cacheIdA,
      cacheIdB
    );
    const tmpPath = filePath + ".tmp";

    await writeFile(tmpPath, JSON.stringify(normalized, null, 2));
    await rename(tmpPath, filePath);
  }
}

async function buildCachedOutputLocatorIndex(
  cacheDir: string
): Promise<Map<string, CachedOutputLocator>> {
  const index = new Map<string, CachedOutputLocator>();

  const writeBase = join(cacheDir, "writes");
  const writeModelKeys = await discoverModelKeys(writeBase);
  for (const writeModelKey of writeModelKeys) {
    const promptHashes = await safeReaddir(join(writeBase, writeModelKey));
    for (const promptHash of promptHashes) {
      const promptDir = join(writeBase, writeModelKey, promptHash);
      const files = (await safeReaddir(promptDir)).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const path = join(promptDir, file);
        const entry = await safeReadJson<CachedWrite>(path);
        if (!entry || index.has(entry.cacheId)) {
          continue;
        }
        const outputIndex = parseInt(file.match(/\d+/)?.[0] ?? "0", 10);
        index.set(entry.cacheId, {
          category: "writes",
          modelKey: writeModelKey,
          path,
          promptHash,
          outputIndex,
        });
      }
    }
  }

  const revisionBase = join(cacheDir, "revisions");
  const revisionModelKeys = await discoverModelKeys(revisionBase);
  for (const revisionModelKey of revisionModelKeys) {
    const files = (await safeReaddir(join(revisionBase, revisionModelKey)))
      .filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const path = join(revisionBase, revisionModelKey, file);
      const entry = await safeReadJson<CachedRevision>(path);
      if (!entry || index.has(entry.cacheId)) {
        continue;
      }
      index.set(entry.cacheId, {
        category: "revisions",
        modelKey: revisionModelKey,
        path,
      });
    }
  }

  return index;
}

function comparisonModelLabel(
  cacheId: string,
  index: Map<string, CachedOutputLocator>
): string {
  const locator = index.get(cacheId);
  if (!locator) {
    return cacheId;
  }
  const spec = specFromModelKey(locator.modelKey) ?? locator.modelKey;
  const suffix = locator.category === "writes"
    ? `#${locator.outputIndex ?? 0}`
    : "(rev)";
  return `${spec} ${suffix}`;
}

function addJudgmentHashPair(
  map: Map<string, [string, string]>,
  stage: "initial" | "revised" | "improvement",
  cacheIdA: string,
  cacheIdB: string,
): void {
  const [first, second] = [cacheIdA, cacheIdB].sort();
  const hash = judgmentPairHash(stage, first, second);
  if (!map.has(hash)) {
    map.set(hash, [first, second]);
  }
}

function judgmentHashFromArtifactKey(artifactKey: string): string {
  const fileName = basename(artifactKey);
  return fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
}

async function buildLegacyJudgmentPairIndex(
  cacheDir: string,
  outputLocatorIndex: Map<string, CachedOutputLocator>,
  includeRuns: boolean = false,
): Promise<Map<string, [string, string]>> {
  const hashToPair = new Map<string, [string, string]>();
  const writesByPromptOutput = new Map<string, string[]>();
  const writeLocatorByCacheId = new Map<string, CachedOutputLocator>();

  for (const [cacheId, locator] of outputLocatorIndex.entries()) {
    if (locator.category !== "writes") {
      continue;
    }
    writeLocatorByCacheId.set(cacheId, locator);
    const promptHash = locator.promptHash ?? "-";
    const outputIndex = locator.outputIndex ?? 0;
    const key = `${promptHash}:${outputIndex}`;
    const existing = writesByPromptOutput.get(key) ?? [];
    existing.push(cacheId);
    writesByPromptOutput.set(key, existing);
  }

  for (const cacheIds of writesByPromptOutput.values()) {
    const uniq = [...new Set(cacheIds)];
    for (const [cacheIdA, cacheIdB] of allPairs(uniq)) {
      addJudgmentHashPair(hashToPair, "initial", cacheIdA, cacheIdB);
    }
  }

  const feedbackByWriteCacheId = new Map<string, Array<{ feedbackCacheId: string; feedbackModelKey: string }>>();
  const feedbackBase = join(cacheDir, "feedback");
  const feedbackModelKeys = await discoverModelKeys(feedbackBase);
  for (const feedbackModelKey of feedbackModelKeys) {
    const feedbackDir = join(feedbackBase, feedbackModelKey);
    const files = (await safeReaddir(feedbackDir)).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const entry = await safeReadJson<CachedFeedback>(join(feedbackDir, file));
      if (!entry) {
        continue;
      }
      const links = feedbackByWriteCacheId.get(entry.writeCacheId) ?? [];
      links.push({
        feedbackCacheId: entry.cacheId,
        feedbackModelKey,
      });
      feedbackByWriteCacheId.set(entry.writeCacheId, links);
    }
  }

  const revisionByWriterFeedback = new Map<string, string>();
  for (const [cacheId, locator] of outputLocatorIndex.entries()) {
    if (locator.category !== "revisions") {
      continue;
    }
    const entry = await safeReadJson<CachedRevision>(locator.path);
    if (!entry) {
      continue;
    }
    revisionByWriterFeedback.set(`${locator.modelKey}:${entry.feedbackCacheId}`, cacheId);
  }

  const revisedGroups = new Map<string, string[]>();

  for (const [writeCacheId, writeLocator] of writeLocatorByCacheId.entries()) {
    const feedbackLinks = feedbackByWriteCacheId.get(writeCacheId) ?? [];
    for (const link of feedbackLinks) {
      const revisionCacheId = revisionByWriterFeedback.get(
        `${writeLocator.modelKey}:${link.feedbackCacheId}`
      );
      if (!revisionCacheId) {
        continue;
      }

      addJudgmentHashPair(hashToPair, "improvement", writeCacheId, revisionCacheId);

      const promptHash = writeLocator.promptHash ?? "-";
      const outputIndex = writeLocator.outputIndex ?? 0;
      const groupKey = `${promptHash}:${outputIndex}:${link.feedbackModelKey}`;
      const revisions = revisedGroups.get(groupKey) ?? [];
      revisions.push(revisionCacheId);
      revisedGroups.set(groupKey, revisions);
    }
  }

  for (const revisionCacheIds of revisedGroups.values()) {
    const uniq = [...new Set(revisionCacheIds)];
    for (const [cacheIdA, cacheIdB] of allPairs(uniq)) {
      addJudgmentHashPair(hashToPair, "revised", cacheIdA, cacheIdB);
    }
  }

  if (includeRuns) {
    const runIds = await listRuns();
    for (const runId of runIds) {
      let run;
      try {
        run = await loadRun(runId);
      } catch {
        continue;
      }
      for (const judgment of run.judgments) {
        addJudgmentHashPair(hashToPair, judgment.stage, judgment.sampleA, judgment.sampleB);
      }
    }
  }

  return hashToPair;
}

/**
 * List cache artifacts for a model key across all cache categories.
 */
export async function listModelCacheArtifacts(
  cacheDir: string,
  modelDirKey: string
): Promise<CacheArtifactSummary[]> {
  const results: CacheArtifactSummary[] = [];

  const writesBase = join(cacheDir, "writes", modelDirKey);
  for (const promptHash of await safeReaddir(writesBase)) {
    const promptDir = join(writesBase, promptHash);
    const writeFiles = (await safeReaddir(promptDir))
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
        const nb = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
        return na - nb;
      });

    for (const file of writeFiles) {
      const entry = await safeReadJson<CachedWrite>(join(promptDir, file));
      if (!entry) continue;
      const outputIndex = parseInt(file.match(/\d+/)?.[0] ?? "0", 10);
      results.push({
        category: "writes",
        artifactKey: `${promptHash}/${file}`,
        modelKey: modelDirKey,
        cacheId: entry.cacheId,
        createdAt: entry.createdAt,
        promptHash,
        outputIndex,
        preview: compactPreview(entry.text),
      });
    }
  }

  const categoryDirs: Array<[CacheArtifactCategory, string]> = [
    ["feedback", join(cacheDir, "feedback", modelDirKey)],
    ["revisions", join(cacheDir, "revisions", modelDirKey)],
    ["judgments", join(cacheDir, "judgments", modelDirKey)],
  ];

  let outputLocatorIndex: Map<string, CachedOutputLocator> | null = null;
  let legacyJudgmentPairIndex: Map<string, [string, string]> | null = null;

  for (const [category, dir] of categoryDirs) {
    const files = (await safeReaddir(dir))
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const file of files) {
      const artifactKey = file;
      if (category === "feedback") {
        const entry = await safeReadJson<CachedFeedback>(join(dir, file));
        if (!entry) continue;
        results.push({
          category,
          artifactKey,
          modelKey: modelDirKey,
          cacheId: entry.cacheId,
          createdAt: entry.createdAt,
          preview: compactPreview(entry.text),
        });
      } else if (category === "revisions") {
        const entry = await safeReadJson<CachedRevision>(join(dir, file));
        if (!entry) continue;
        results.push({
          category,
          artifactKey,
          modelKey: modelDirKey,
          cacheId: entry.cacheId,
          createdAt: entry.createdAt,
          preview: compactPreview(entry.text),
        });
      } else {
        const entry = await safeReadJson<CachedJudgment>(join(dir, file));
        if (!entry) continue;

        let comparedPair: [string, string] | null = null;
        if (typeof entry.firstCacheId === "string" && typeof entry.secondCacheId === "string") {
          comparedPair = [entry.firstCacheId, entry.secondCacheId];
        } else {
          if (!outputLocatorIndex) {
            outputLocatorIndex = await buildCachedOutputLocatorIndex(cacheDir);
          }
          if (!legacyJudgmentPairIndex) {
            legacyJudgmentPairIndex = await buildLegacyJudgmentPairIndex(cacheDir, outputLocatorIndex);
          }
          comparedPair = legacyJudgmentPairIndex.get(judgmentHashFromArtifactKey(file)) ?? null;
        }

        let comparisonLabel: string | undefined;
        let comparedCacheIds: [string, string] | undefined;
        if (comparedPair) {
          if (!outputLocatorIndex) {
            outputLocatorIndex = await buildCachedOutputLocatorIndex(cacheDir);
          }
          comparedCacheIds = comparedPair;
          comparisonLabel = `${comparisonModelLabel(comparedPair[0], outputLocatorIndex)} vs ${comparisonModelLabel(comparedPair[1], outputLocatorIndex)}`;
        }
        results.push({
          category,
          artifactKey,
          modelKey: modelDirKey,
          cacheId: entry.cacheId,
          createdAt: entry.createdAt,
          stage: entry.stage,
          comparisonLabel,
          comparedCacheIds,
          preview: compactPreview(entry.reasoning),
        });
      }
    }
  }

  results.sort((a, b) => {
    const aTime = a.createdAt ?? "";
    const bTime = b.createdAt ?? "";
    if (aTime !== bTime) {
      return bTime.localeCompare(aTime);
    }
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }
    return a.artifactKey.localeCompare(b.artifactKey);
  });

  return results;
}

/**
 * Load one cache artifact payload by category and artifact key.
 */
export async function loadModelCacheArtifact(
  cacheDir: string,
  modelDirKey: string,
  category: CacheArtifactCategory,
  artifactKey: string
): Promise<CacheArtifactDetail | null> {
  let path: string;
  if (category === "writes") {
    const slash = artifactKey.indexOf("/");
    if (slash <= 0 || slash >= artifactKey.length - 1) {
      return null;
    }
    const promptHash = artifactKey.slice(0, slash);
    const fileName = artifactKey.slice(slash + 1);
    if (!fileName.endsWith(".json")) {
      return null;
    }
    path = join(cacheDir, category, modelDirKey, promptHash, fileName);
  } else {
    const fileName = basename(artifactKey);
    if (!fileName.endsWith(".json")) {
      return null;
    }
    path = join(cacheDir, category, modelDirKey, fileName);
  }

  const payload = await safeReadJson<unknown>(path);
  if (!payload) {
    return null;
  }

  return {
    category,
    artifactKey,
    modelKey: modelDirKey,
    payload,
  };
}

/**
 * Resolve and load the two cached outputs referenced by a judgment detail.
 */
export async function loadJudgmentComparedOutputs(
  cacheDir: string,
  detail: CacheArtifactDetail
): Promise<JudgmentComparedPair | null> {
  if (detail.category !== "judgments") {
    return null;
  }
  const payload = asObject(detail.payload);
  if (!payload) {
    return null;
  }

  const outputLocatorIndex = await buildCachedOutputLocatorIndex(cacheDir);
  let comparedPair: [string, string] | null = null;

  if (typeof payload.firstCacheId === "string" && typeof payload.secondCacheId === "string") {
    comparedPair = [payload.firstCacheId, payload.secondCacheId];
  } else {
    const legacyPairIndex = await buildLegacyJudgmentPairIndex(cacheDir, outputLocatorIndex, true);
    comparedPair = legacyPairIndex.get(judgmentHashFromArtifactKey(detail.artifactKey)) ?? null;
  }

  if (!comparedPair) {
    return null;
  }

  const firstFromCache = outputLocatorIndex.get(comparedPair[0]);
  const secondFromCache = outputLocatorIndex.get(comparedPair[1]);

  let first = await resolveComparedOutput(comparedPair[0], firstFromCache, undefined);
  let second = await resolveComparedOutput(comparedPair[1], secondFromCache, undefined);

  if (!first || !second) {
    const runOutputLocatorIndex = await getRunOutputLocatorIndex();
    if (!first) {
      first = await resolveComparedOutput(
        comparedPair[0],
        firstFromCache,
        runOutputLocatorIndex.get(comparedPair[0])
      );
    }
    if (!second) {
      second = await resolveComparedOutput(
        comparedPair[1],
        secondFromCache,
        runOutputLocatorIndex.get(comparedPair[1])
      );
    }
  }

  if (!first || !second) {
    return null;
  }

  return { first, second };
}

async function resolveComparedOutput(
  cacheId: string,
  cacheLocator: CachedOutputLocator | undefined,
  runLocator: RunOutputLocator | undefined,
): Promise<JudgmentComparedOutput | null> {
  if (cacheLocator) {
    const payload = await safeReadJson<CachedWrite | CachedRevision>(cacheLocator.path);
    if (payload && typeof payload.text === "string") {
      return {
        cacheId,
        category: cacheLocator.category,
        modelKey: cacheLocator.modelKey,
        promptHash: cacheLocator.promptHash,
        outputIndex: cacheLocator.outputIndex,
        text: payload.text,
      };
    }
  }

  if (runLocator) {
    return {
      cacheId,
      category: runLocator.category,
      modelKey: runLocator.modelKey,
      outputIndex: runLocator.outputIndex,
      text: runLocator.text,
    };
  }

  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function usageSummary(value: unknown): string {
  const usage = asObject(value) as UsageLike | null;
  if (!usage) {
    return "-";
  }
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return `${input} in / ${output} out`;
}

function costSummary(value: unknown): string {
  const cost = asObject(value) as CostLike | null;
  if (!cost) {
    return "-";
  }
  const total = typeof cost.total === "number" ? cost.total.toFixed(6) : "-";
  const uncached = typeof cost.totalUncached === "number"
    ? cost.totalUncached.toFixed(6)
    : "-";
  return `$${total} (uncached $${uncached})`;
}

function parseOutputIndex(artifactKey: string): number | null {
  const fileName = basename(artifactKey);
  const match = fileName.match(/\d+/);
  if (!match) {
    return null;
  }
  return parseInt(match[0], 10);
}

/**
 * Format one cache artifact detail for human-readable TUI display.
 */
export function formatCacheArtifactDetail(detail: CacheArtifactDetail): string {
  const payload = asObject(detail.payload);
  if (!payload) {
    return JSON.stringify(detail.payload, null, 2);
  }

  const spec = specFromModelKey(detail.modelKey) ?? detail.modelKey;

  if (detail.category === "writes" && typeof payload.text === "string") {
    const outputIndex = parseOutputIndex(detail.artifactKey);
    const slash = detail.artifactKey.indexOf("/");
    const promptHash = slash > 0 ? detail.artifactKey.slice(0, slash) : "-";
    const lines = [
      `Type: write`,
      `Model: ${spec}`,
      `Cache ID: ${String(payload.cacheId ?? "-")}`,
      `Prompt Hash: ${promptHash}`,
      `Output Index: ${outputIndex ?? "-"}`,
      `Created: ${String(payload.createdAt ?? "-")}`,
      `Latency: ${String(payload.latencyMs ?? "-")} ms`,
      `Usage: ${usageSummary(payload.usage)}`,
      `Cost: ${costSummary(payload.cost)}`,
      "",
      "Text:",
      payload.text,
    ];
    return lines.join("\n");
  }

  if (detail.category === "feedback" && typeof payload.text === "string") {
    const lines = [
      `Type: feedback`,
      `Model: ${spec}`,
      `Cache ID: ${String(payload.cacheId ?? "-")}`,
      `Write Cache ID: ${String(payload.writeCacheId ?? "-")}`,
      `Source Model: ${String(payload.sourceModel ?? "-")}`,
      `Created: ${String(payload.createdAt ?? "-")}`,
      `Latency: ${String(payload.latencyMs ?? "-")} ms`,
      `Usage: ${usageSummary(payload.usage)}`,
      `Cost: ${costSummary(payload.cost)}`,
      "",
      "Text:",
      payload.text,
    ];
    return lines.join("\n");
  }

  if (detail.category === "revisions" && typeof payload.text === "string") {
    const lines = [
      `Type: revision`,
      `Model: ${spec}`,
      `Cache ID: ${String(payload.cacheId ?? "-")}`,
      `Feedback Cache ID: ${String(payload.feedbackCacheId ?? "-")}`,
      `Created: ${String(payload.createdAt ?? "-")}`,
      `Latency: ${String(payload.latencyMs ?? "-")} ms`,
      `Usage: ${usageSummary(payload.usage)}`,
      `Cost: ${costSummary(payload.cost)}`,
      "",
      "Text:",
      payload.text,
    ];
    return lines.join("\n");
  }

  if (detail.category === "judgments" && typeof payload.reasoning === "string") {
    const lines = [
      `Type: judgment`,
      `Model: ${spec}`,
      `Cache ID: ${String(payload.cacheId ?? "-")}`,
      `Stage: ${String(payload.stage ?? "-")}`,
      `Winner: ${String(payload.winner ?? "-")}`,
      `First Cache ID: ${String(payload.firstCacheId ?? "-")}`,
      `Second Cache ID: ${String(payload.secondCacheId ?? "-")}`,
      `Position Swapped: ${String(payload.positionSwapped ?? "-")}`,
      `Created: ${String(payload.createdAt ?? "-")}`,
      `Latency: ${String(payload.latencyMs ?? "-")} ms`,
      `Usage: ${usageSummary(payload.usage)}`,
      `Cost: ${costSummary(payload.cost)}`,
      "",
      "Reasoning:",
      payload.reasoning,
    ];
    return lines.join("\n");
  }

  return JSON.stringify(detail.payload, null, 2);
}

/**
 * Randomly select `count` items from an array without replacement.
 * Returns the items in random order.
 */
export function randomSample<T>(arr: T[], count: number): T[] {
  if (count >= arr.length) return [...arr];
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return result;
}

// ── Cache Trimming ──────────────────────────────────

export interface TrimResult {
  promptsAffected: number;
  totalPrompts: number;
  writesDeleted: number;
  feedbackDeleted: number;
  revisionsDeleted: number;
  judgmentsDeleted: number;
}

export interface ClearModelCacheResult {
  writesDeleted: number;
  feedbackDeleted: number;
  revisionsDeleted: number;
  judgmentsDeleted: number;
}

interface CachedFileEntry {
  path: string;
  dependencyId: string;
  cacheId?: string;
}

async function listFlatCacheEntries(dir: string): Promise<CachedFileEntry[]> {
  const entries: CachedFileEntry[] = [];
  const files = (await safeReaddir(dir)).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    const path = join(dir, file);
    const cached = await safeReadJson<{ cacheId?: string }>(path);
    entries.push({
      path,
      dependencyId: basename(file, ".json"),
      cacheId: cached?.cacheId,
    });
  }
  return entries;
}

async function listWriteCacheEntries(dir: string): Promise<CachedFileEntry[]> {
  const entries: CachedFileEntry[] = [];
  for (const promptHash of await safeReaddir(dir)) {
    entries.push(...await listFlatCacheEntries(join(dir, promptHash)));
  }
  return entries;
}

async function removeModelCacheDir(dir: string, categoryDir: string): Promise<void> {
  if (!existsSync(dir)) return;
  await rm(dir, { recursive: true });
  await removeIfEmpty(dirname(dir), categoryDir);
}

async function collectOutputCacheIds(cacheDir: string): Promise<Set<string>> {
  const cacheIds = new Set<string>();
  const writesDir = join(cacheDir, "writes");
  for (const modelDir of await discoverModelKeys(writesDir)) {
    for (const entry of await listWriteCacheEntries(join(writesDir, modelDir))) {
      if (entry.cacheId) cacheIds.add(entry.cacheId);
    }
  }

  const revisionsDir = join(cacheDir, "revisions");
  for (const modelDir of await discoverModelKeys(revisionsDir)) {
    for (const entry of await listFlatCacheEntries(join(revisionsDir, modelDir))) {
      if (entry.cacheId) cacheIds.add(entry.cacheId);
    }
  }
  return cacheIds;
}

async function deleteAffectedJudgments(
  cacheDir: string,
  deletedOutputIds: Set<string>,
  judgeModelKey?: string,
): Promise<number> {
  const judgmentsDir = join(cacheDir, "judgments");
  let deleted = 0;

  if (judgeModelKey) {
    const judgeDir = join(judgmentsDir, judgeModelKey);
    deleted += (await safeReaddir(judgeDir)).filter((file) => file.endsWith(".json")).length;
    await removeModelCacheDir(judgeDir, judgmentsDir);
  }

  if (deletedOutputIds.size === 0) return deleted;

  const allOutputIds = await collectOutputCacheIds(cacheDir);
  for (const id of deletedOutputIds) allOutputIds.add(id);

  const staleHashes = new Set<string>();
  for (const deletedId of deletedOutputIds) {
    for (const otherId of allOutputIds) {
      if (deletedId === otherId) continue;
      for (const stage of ["initial", "improvement", "revised"] as const) {
        staleHashes.add(judgmentPairHash(stage, deletedId, otherId));
      }
    }
  }

  for (const modelDir of await discoverModelKeys(judgmentsDir)) {
    if (modelDir === judgeModelKey) continue;
    const modelPath = join(judgmentsDir, modelDir);
    for (const entry of await listFlatCacheEntries(modelPath)) {
      const judgment = await safeReadJson<Pick<CachedJudgment, "firstCacheId" | "secondCacheId">>(entry.path);
      const referencesDeletedOutput =
        (judgment?.firstCacheId != null && deletedOutputIds.has(judgment.firstCacheId))
        || (judgment?.secondCacheId != null && deletedOutputIds.has(judgment.secondCacheId));
      if (!referencesDeletedOutput && !staleHashes.has(entry.dependencyId)) continue;
      await unlink(entry.path);
      deleted++;
    }
    await removeIfEmpty(modelPath, judgmentsDir);
  }
  await removeIfEmpty(judgmentsDir);
  return deleted;
}

/**
 * Clear artifacts produced by a model and every artifact that depends on
 * those outputs, while preserving unrelated cache entries.
 */
export async function clearModelCache(
  cacheDir: string,
  mk: string,
  judgmentsOnly: boolean = false,
): Promise<ClearModelCacheResult> {
  const result: ClearModelCacheResult = {
    writesDeleted: 0,
    feedbackDeleted: 0,
    revisionsDeleted: 0,
    judgmentsDeleted: 0,
  };

  if (judgmentsOnly) {
    result.judgmentsDeleted = await deleteAffectedJudgments(cacheDir, new Set(), mk);
    return result;
  }

  const writesDir = join(cacheDir, "writes");
  const feedbackDir = join(cacheDir, "feedback");
  const revisionsDir = join(cacheDir, "revisions");
  const modelWritesDir = join(writesDir, mk);
  const modelFeedbackDir = join(feedbackDir, mk);
  const modelRevisionsDir = join(revisionsDir, mk);

  const modelWrites = await listWriteCacheEntries(modelWritesDir);
  const modelFeedback = await listFlatCacheEntries(modelFeedbackDir);
  const modelRevisions = await listFlatCacheEntries(modelRevisionsDir);
  const deletedWriteIds = new Set(modelWrites.flatMap((entry) => entry.cacheId ? [entry.cacheId] : []));
  const deletedFeedbackIds = new Set(modelFeedback.flatMap((entry) => entry.cacheId ? [entry.cacheId] : []));
  const deletedRevisionIds = new Set(modelRevisions.flatMap((entry) => entry.cacheId ? [entry.cacheId] : []));

  result.writesDeleted = modelWrites.length;
  result.feedbackDeleted = modelFeedback.length;
  result.revisionsDeleted = modelRevisions.length;
  await removeModelCacheDir(modelWritesDir, writesDir);
  await removeModelCacheDir(modelFeedbackDir, feedbackDir);
  await removeModelCacheDir(modelRevisionsDir, revisionsDir);

  // Feedback filenames identify their source write, so malformed payloads can
  // still be removed safely. Valid cache IDs extend the dependency cascade.
  for (const modelDir of await discoverModelKeys(feedbackDir)) {
    const modelPath = join(feedbackDir, modelDir);
    for (const entry of await listFlatCacheEntries(modelPath)) {
      if (!deletedWriteIds.has(entry.dependencyId)) continue;
      if (entry.cacheId) deletedFeedbackIds.add(entry.cacheId);
      await unlink(entry.path);
      result.feedbackDeleted++;
    }
    await removeIfEmpty(modelPath, feedbackDir);
  }

  // Revision filenames identify their source feedback cache ID.
  for (const modelDir of await discoverModelKeys(revisionsDir)) {
    const modelPath = join(revisionsDir, modelDir);
    for (const entry of await listFlatCacheEntries(modelPath)) {
      if (!deletedFeedbackIds.has(entry.dependencyId)) continue;
      if (entry.cacheId) deletedRevisionIds.add(entry.cacheId);
      await unlink(entry.path);
      result.revisionsDeleted++;
    }
    await removeIfEmpty(modelPath, revisionsDir);
  }

  result.judgmentsDeleted = await deleteAffectedJudgments(
    cacheDir,
    new Set([...deletedWriteIds, ...deletedRevisionIds]),
    mk,
  );

  return result;
}


/**
 * Trim cached outputs for a model to at most `maxOutputs` per prompt.
 * Cascades to linked feedback, revisions, and surgically removes only
 * the judgment files that reference deleted artifacts.
 */
export async function trimModelOutputs(
  cacheDir: string,
  mk: string,
  maxOutputs: number,
): Promise<TrimResult> {
  const writesBase = join(cacheDir, "writes", mk);
  const feedbackBase = join(cacheDir, "feedback");
  const revisionsBase = join(cacheDir, "revisions");

  // ── Phase 1: Trim writes ──────────────────────────

  const promptHashes = await safeReaddir(writesBase);
  const totalPrompts = promptHashes.length;
  let promptsAffected = 0;

  const deletedWriteIds: string[] = [];

  for (const promptHash of promptHashes) {
    const promptDir = join(writesBase, promptHash);
    const files = (await safeReaddir(promptDir))
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
        const nb = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
        return na - nb;
      });

    const keepCount = Math.min(files.length, maxOutputs);
    if (keepCount < files.length) promptsAffected++;

    for (let i = 0; i < files.length; i++) {
      if (i < keepCount) continue;
      const filePath = join(promptDir, files[i]);
      const entry = await safeReadJson<{ cacheId: string }>(filePath);
      if (entry?.cacheId) deletedWriteIds.push(entry.cacheId);
      await unlink(filePath);
    }

    if (keepCount === 0) await removeIfEmpty(promptDir);
  }

  if (deletedWriteIds.length === 0) {
    return {
      promptsAffected: 0,
      totalPrompts,
      writesDeleted: 0,
      feedbackDeleted: 0,
      revisionsDeleted: 0,
      judgmentsDeleted: 0,
    };
  }

  // ── Phase 2: Cascade delete feedback + revisions ──

  const deletedRevisionIds: string[] = [];
  let feedbackDeleted = 0;
  let revisionsDeleted = 0;

  const feedbackModelDirs = await discoverModelKeys(feedbackBase);
  const revisionModelDirs = await discoverModelKeys(revisionsBase);

  for (const writeCacheId of deletedWriteIds) {
    for (const fbModelDir of feedbackModelDirs) {
      const fbPath = join(feedbackBase, fbModelDir, `${writeCacheId}.json`);
      const fbEntry = await safeReadJson<{ cacheId: string }>(fbPath);
      if (!fbEntry?.cacheId) continue;

      await unlink(fbPath);
      feedbackDeleted++;

      for (const revModelDir of revisionModelDirs) {
        const revPath = join(revisionsBase, revModelDir, `${fbEntry.cacheId}.json`);
        const revEntry = await safeReadJson<{ cacheId: string }>(revPath);
        if (!revEntry?.cacheId) continue;

        deletedRevisionIds.push(revEntry.cacheId);
        await unlink(revPath);
        revisionsDeleted++;
      }
    }
  }

  // ── Phase 3: Surgical judgment cleanup ────────────

  const judgmentsDeleted = await deleteAffectedJudgments(cacheDir, new Set([
    ...deletedWriteIds,
    ...deletedRevisionIds,
  ]));

  // Clean up empty directories (stopAt ensures namespace parents are removed too)
  await removeIfEmpty(join(cacheDir, "writes", mk), join(cacheDir, "writes"));
  for (const fbDir of feedbackModelDirs) {
    await removeIfEmpty(join(feedbackBase, fbDir), feedbackBase);
  }
  for (const revDir of revisionModelDirs) {
    await removeIfEmpty(join(revisionsBase, revDir), revisionsBase);
  }

  return {
    promptsAffected,
    totalPrompts,
    writesDeleted: deletedWriteIds.length,
    feedbackDeleted,
    revisionsDeleted,
    judgmentsDeleted,
  };
}

// ── Cache Combining ─────────────────────────────────

export interface CombineResult {
  writesMoved: number;
  feedbackMoved: number;
  feedbackDeduped: number;
  feedbackConflicts: number;
  revisionsMoved: number;
  revisionsRekeyed: number;
  revisionsConflicts: number;
  judgmentsMoved: number;
  judgmentsConflicts: number;
}

async function filesConflict(pathA: string, pathB: string): Promise<boolean> {
  try {
    const [aRaw, bRaw] = await Promise.all([
      readFile(pathA, "utf-8"),
      readFile(pathB, "utf-8"),
    ]);
    try {
      const aJson = JSON.parse(aRaw);
      const bJson = JSON.parse(bRaw);
      return JSON.stringify(aJson) !== JSON.stringify(bJson);
    } catch {
      return aRaw !== bRaw;
    }
  } catch {
    return false;
  }
}

/**
 * Combine cache data from one model key into another.
 * Writes are renumbered to avoid filename conflicts; feedback, revisions,
 * and judgments are copied by cacheId/hash (skipping duplicates).
 * Source directories are removed after the merge.
 */
export async function combineModelCaches(
  cacheDir: string,
  sourceKey: string,
  targetKey: string,
): Promise<CombineResult> {
  const result: CombineResult = {
    writesMoved: 0,
    feedbackMoved: 0,
    feedbackDeduped: 0,
    feedbackConflicts: 0,
    revisionsMoved: 0,
    revisionsRekeyed: 0,
    revisionsConflicts: 0,
    judgmentsMoved: 0,
    judgmentsConflicts: 0,
  };

  // ── Writes ──────────────────────────────────────────
  const srcWritesBase = join(cacheDir, "writes", sourceKey);
  const tgtWritesBase = join(cacheDir, "writes", targetKey);

  const srcPromptHashes = await safeReaddir(srcWritesBase);
  for (const promptHash of srcPromptHashes) {
    const srcDir = join(srcWritesBase, promptHash);
    const tgtDir = join(tgtWritesBase, promptHash);
    await mkdir(tgtDir, { recursive: true });

    // Collect existing cacheIds in target to skip duplicates
    const existingFiles = (await safeReaddir(tgtDir)).filter((f) => f.endsWith(".json"));
    const existingCacheIds = new Set<string>();
    let nextIdx = 0;
    for (const f of existingFiles) {
      const n = parseInt(f.match(/\d+/)?.[0] ?? "0", 10);
      if (n >= nextIdx) nextIdx = n + 1;
      const entry = await safeReadJson<{ cacheId: string }>(join(tgtDir, f));
      if (entry?.cacheId) existingCacheIds.add(entry.cacheId);
    }

    // Copy source samples with renumbered indices, skipping duplicates
    const srcFiles = (await safeReaddir(srcDir))
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
        const nb = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
        return na - nb;
      });

    for (const f of srcFiles) {
      const content = await readFile(join(srcDir, f), "utf-8");
      const parsed = JSON.parse(content) as { cacheId?: string };
      if (parsed.cacheId && existingCacheIds.has(parsed.cacheId)) continue;
      const newPath = join(tgtDir, `sample_${nextIdx}.json`);
      await writeFile(newPath, content);
      if (parsed.cacheId) existingCacheIds.add(parsed.cacheId);
      nextIdx++;
      result.writesMoved++;
    }
  }

  // ── Feedback (with cacheId mapping for deduped entries) ──
  // When source and target both have feedback for the same writeCacheId
  // (same filename), we keep the target's copy. But the source's feedback
  // has a different cacheId that downstream revisions reference. We track
  // this mapping so we can re-key those revisions.
  const fbCacheIdMap = new Map<string, string>(); // skippedFbId → keptFbId

  const srcFbBase = join(cacheDir, "feedback", sourceKey);
  const tgtFbBase = join(cacheDir, "feedback", targetKey);
  const srcFbFiles = await safeReaddir(srcFbBase);

  if (srcFbFiles.length > 0) {
    await mkdir(tgtFbBase, { recursive: true });

    for (const f of srcFbFiles) {
      if (!f.endsWith(".json")) continue;
      const tgtPath = join(tgtFbBase, f);
      if (existsSync(tgtPath)) {
        if (await filesConflict(join(srcFbBase, f), tgtPath)) {
          result.feedbackConflicts++;
        }
        // Duplicate: both endpoints gave feedback on the same write.
        // Keep target's copy, but record the cacheId mapping for revisions.
        const srcEntry = await safeReadJson<{ cacheId: string }>(join(srcFbBase, f));
        const tgtEntry = await safeReadJson<{ cacheId: string }>(tgtPath);
        if (srcEntry?.cacheId && tgtEntry?.cacheId && srcEntry.cacheId !== tgtEntry.cacheId) {
          fbCacheIdMap.set(srcEntry.cacheId, tgtEntry.cacheId);
        }
        result.feedbackDeduped++;
        continue;
      }
      const content = await readFile(join(srcFbBase, f), "utf-8");
      await writeFile(tgtPath, content);
      result.feedbackMoved++;
    }
  }

  // ── Revisions (with re-keying for orphaned entries) ──
  // Revisions are filed by feedbackCacheId. When feedback was deduped above,
  // revisions referencing the discarded feedback's cacheId become orphaned.
  // We must re-key them across ALL writer model directories, not just source/target.
  const srcRevBase = join(cacheDir, "revisions", sourceKey);
  const tgtRevBase = join(cacheDir, "revisions", targetKey);
  const srcRevFiles = await safeReaddir(srcRevBase);

  if (srcRevFiles.length > 0) {
    await mkdir(tgtRevBase, { recursive: true });

    for (const f of srcRevFiles) {
      if (!f.endsWith(".json")) continue;
      const tgtPath = join(tgtRevBase, f);
      if (existsSync(tgtPath)) {
        if (await filesConflict(join(srcRevBase, f), tgtPath)) {
          result.revisionsConflicts++;
        }
        continue;
      }
      const content = await readFile(join(srcRevBase, f), "utf-8");
      await writeFile(tgtPath, content);
      result.revisionsMoved++;
    }
  }

  if (fbCacheIdMap.size > 0) {
    const revisionsBase = join(cacheDir, "revisions");
    const revModelDirs = await discoverModelKeys(revisionsBase);
    for (const revModelDir of revModelDirs) {
      const revDirPath = join(revisionsBase, revModelDir);
      for (const [skippedId, keptId] of fbCacheIdMap) {
        const orphanPath = join(revDirPath, `${skippedId}.json`);
        if (!existsSync(orphanPath)) continue;
        const keptPath = join(revDirPath, `${keptId}.json`);
        if (existsSync(keptPath)) {
          // Both feedbacks had revisions; keep the one matching the kept feedback
          await unlink(orphanPath);
        } else {
          // Re-key: update feedbackCacheId and rename to the kept feedback's cacheId
          const rev = JSON.parse(await readFile(orphanPath, "utf-8"));
          rev.feedbackCacheId = keptId;
          await writeFile(keptPath, JSON.stringify(rev, null, 2));
          await unlink(orphanPath);
        }
        result.revisionsRekeyed++;
      }
    }
  }

  // ── Judgments (flat copy, skip existing) ──
  const srcJudgBase = join(cacheDir, "judgments", sourceKey);
  const tgtJudgBase = join(cacheDir, "judgments", targetKey);
  const srcJudgFiles = await safeReaddir(srcJudgBase);

  if (srcJudgFiles.length > 0) {
    await mkdir(tgtJudgBase, { recursive: true });

    for (const f of srcJudgFiles) {
      if (!f.endsWith(".json")) continue;
      const tgtPath = join(tgtJudgBase, f);
      if (existsSync(tgtPath)) {
        if (await filesConflict(join(srcJudgBase, f), tgtPath)) {
          result.judgmentsConflicts++;
        }
        continue;
      }
      const content = await readFile(join(srcJudgBase, f), "utf-8");
      await writeFile(tgtPath, content);
      result.judgmentsMoved++;
    }
  }

  // ── Clean up source directories ─────────────────────
  for (const category of ["writes", "feedback", "revisions", "judgments"]) {
    const srcDir = join(cacheDir, category, sourceKey);
    if (existsSync(srcDir)) {
      await rm(srcDir, { recursive: true });
      await removeIfEmpty(dirname(srcDir), join(cacheDir, category));
    }
  }

  return result;
}
