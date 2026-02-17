import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir, rename } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import type { TokenUsage, CostBreakdown } from "../types.js";

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
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
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
    entry: CachedWrite
  ): Promise<void> {
    const dir = this.writesDir(provider, model, hashPromptContent(promptText));
    await mkdir(dir, { recursive: true });

    const files = await readdir(dir);
    const nextIndex = files.filter((f) => f.endsWith(".json")).length;
    const filePath = join(dir, `sample_${nextIndex}.json`);
    const tmpPath = filePath + ".tmp";

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
    const tmpPath = filePath + ".tmp";

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
    const tmpPath = filePath + ".tmp";

    await writeFile(tmpPath, JSON.stringify(entry, null, 2));
    await rename(tmpPath, filePath);
  }
  // ── Judgments ──────────────────────────────────────

  private judgmentsDir(provider: string, model: string): string {
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

      // Winner is stored relative to sorted order.
      // If the caller's A sorts first, the winner matches.
      // Otherwise flip it.
      const [sortedFirst] = [cacheIdA, cacheIdB].sort();
      if (cacheIdA !== sortedFirst) {
        return { ...entry, winner: flipWinner(entry.winner) };
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

    // Normalize winner to sorted order
    const [sortedFirst] = [cacheIdA, cacheIdB].sort();
    const normalized: CachedJudgment =
      cacheIdA === sortedFirst
        ? entry
        : { ...entry, winner: flipWinner(entry.winner) };

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
