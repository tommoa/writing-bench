import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir, rename, unlink } from "fs/promises";
import { join, basename } from "path";
import { createHash, randomBytes } from "crypto";
import type { TokenUsage, CostBreakdown } from "../types.js";
import { safeReaddir, safeReadJson, removeIfEmpty } from "./fs-utils.js";

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
  /** Position swap state from the original API call. undefined for legacy cache entries. */
  positionSwapped?: boolean;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
  createdAt: string;
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
 * Convert a model identity string to a filesystem-safe directory name.
 * e.g., "openai:gpt-4o" -> "openai_gpt-4o"
 */
export function modelKey(provider: string, model: string): string {
  return `${provider}_${model}`.replace(/[:/\\]/g, "_");
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
    const [sortedFirst] = [cacheIdA, cacheIdB].sort();
    const normalized: CachedJudgment =
      cacheIdA === sortedFirst
        ? entry
        : {
            ...entry,
            winner: flipWinner(entry.winner),
            positionSwapped: flipPositionSwapped(entry.positionSwapped),
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
  const judgmentsBase = join(cacheDir, "judgments");

  // ── Phase 1: Trim writes ──────────────────────────

  const promptHashes = await safeReaddir(writesBase);
  const totalPrompts = promptHashes.length;
  let promptsAffected = 0;

  const deletedWriteIds: string[] = [];
  const survivingWriteIds: string[] = [];

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
      const filePath = join(promptDir, files[i]);
      const entry = await safeReadJson<{ cacheId: string }>(filePath);
      if (i < keepCount) {
        if (entry?.cacheId) survivingWriteIds.push(entry.cacheId);
      } else {
        if (entry?.cacheId) deletedWriteIds.push(entry.cacheId);
        await unlink(filePath);
      }
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

  const deletedFeedbackIds: string[] = [];
  const deletedRevisionIds: string[] = [];
  let feedbackDeleted = 0;
  let revisionsDeleted = 0;

  const feedbackModelDirs = await safeReaddir(feedbackBase);
  const revisionModelDirs = await safeReaddir(revisionsBase);

  for (const writeCacheId of deletedWriteIds) {
    for (const fbModelDir of feedbackModelDirs) {
      const fbPath = join(feedbackBase, fbModelDir, `${writeCacheId}.json`);
      const fbEntry = await safeReadJson<{ cacheId: string }>(fbPath);
      if (!fbEntry?.cacheId) continue;

      deletedFeedbackIds.push(fbEntry.cacheId);
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

  const deletedIds = new Set<string>([
    ...deletedWriteIds,
    ...deletedFeedbackIds,
    ...deletedRevisionIds,
  ]);

  // Build inventory of ALL known write + revision cacheIds across
  // the cache (needed to compute judgment pair hashes). Feedback IDs
  // are not used in judgment hashes so they are skipped. Deleted IDs
  // are already in `deletedIds` and matched from that side of the
  // pairing, so only surviving write IDs are seeded here.
  const allKnownIds = new Set<string>([
    ...survivingWriteIds,
  ]);

  // Writes from OTHER models (Phase 1 only covers the trimmed model)
  const allWriteModelDirs = await safeReaddir(join(cacheDir, "writes"));
  for (const wModelDir of allWriteModelDirs) {
    if (wModelDir === mk) continue; // already collected
    const prompts = await safeReaddir(join(cacheDir, "writes", wModelDir));
    for (const ph of prompts) {
      const samples = (await safeReaddir(join(cacheDir, "writes", wModelDir, ph)))
        .filter((f) => f.endsWith(".json"));
      for (const sf of samples) {
        const entry = await safeReadJson<{ cacheId: string }>(
          join(cacheDir, "writes", wModelDir, ph, sf),
        );
        if (entry?.cacheId) allKnownIds.add(entry.cacheId);
      }
    }
  }

  // Revisions from ALL models (needed for revised/improvement judgment hashes)
  for (const revDir of revisionModelDirs) {
    const files = (await safeReaddir(join(revisionsBase, revDir)))
      .filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const entry = await safeReadJson<{ cacheId: string }>(
        join(revisionsBase, revDir, f),
      );
      if (entry?.cacheId) allKnownIds.add(entry.cacheId);
    }
  }

  // Compute all stale judgment hashes: every (deletedId, otherId) pair
  // across all three stages. Invalid stage+type combos simply won't
  // match any file on disk -- harmless extra hash computations.
  const STAGES = ["initial", "improvement", "revised"] as const;
  const staleHashes = new Set<string>();

  const allKnownArr = Array.from(allKnownIds);
  for (const deletedId of deletedIds) {
    for (const otherId of allKnownArr) {
      if (deletedId === otherId) continue;
      for (const stage of STAGES) {
        staleHashes.add(judgmentPairHash(stage, deletedId, otherId));
      }
    }
  }

  // Scan judgment directories and delete matching files
  let judgmentsDeleted = 0;
  const judgeModelDirs = await safeReaddir(judgmentsBase);
  for (const judgeDir of judgeModelDirs) {
    const judgeDirPath = join(judgmentsBase, judgeDir);
    const files = (await safeReaddir(judgeDirPath))
      .filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const hash = basename(f, ".json");
      if (staleHashes.has(hash)) {
        await unlink(join(judgeDirPath, f));
        judgmentsDeleted++;
      }
    }
    await removeIfEmpty(judgeDirPath);
  }

  // Clean up empty directories
  await removeIfEmpty(join(cacheDir, "writes", mk));
  for (const fbDir of feedbackModelDirs) {
    await removeIfEmpty(join(feedbackBase, fbDir));
  }
  for (const revDir of revisionModelDirs) {
    await removeIfEmpty(join(revisionsBase, revDir));
  }
  await removeIfEmpty(judgmentsBase);

  return {
    promptsAffected,
    totalPrompts,
    writesDeleted: deletedWriteIds.length,
    feedbackDeleted,
    revisionsDeleted,
    judgmentsDeleted,
  };
}
