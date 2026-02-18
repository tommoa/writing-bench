import { readdir } from "fs/promises";
import { join } from "path";
import type { PromptConfig, ProviderName } from "../types.js";
import { hashPromptContent, modelKey, judgmentPairHash } from "./sample-cache.js";
import { safeReaddir, safeReadJson } from "./fs-utils.js";

// ── Types ───────────────────────────────────────────

export interface AnalyzeCacheOpts {
  prompts: PromptConfig[];
  outputsPerModel: number;
  /** Optional writer modelKey filter — auto-discovers from cache if absent. */
  writerKeys?: string[];
  /** Judge modelKeys — equals writerKeys if absent. */
  judgeKeys?: string[];
  cacheDir?: string;
}

export interface StageCounts {
  have: number;
  need: number;
}

/** Pipeline stage keys present on both CellCoverage and the summary object. */
const STAGE_KEYS = [
  "writes",
  "initialJudgments",
  "feedback",
  "revisions",
  "improvementJudgments",
  "revisedJudgments",
] as const;

type StageKey = (typeof STAGE_KEYS)[number];

/** StageCounts for each pipeline stage. */
type StageMap = Record<StageKey, StageCounts>;

// Per-prompt stages are identical across writers (judgments depend on the
// full writer set, not an individual writer). Per-writer stages vary.
const PER_PROMPT_STAGES: readonly StageKey[] = [
  "initialJudgments",
  "revisedJudgments",
];
const PER_WRITER_STAGES: readonly StageKey[] = STAGE_KEYS.filter(
  (k) => !PER_PROMPT_STAGES.includes(k)
);

/** Accumulate source counts into target. */
function addCounts(target: StageCounts, source: StageCounts): void {
  target.have += source.have;
  target.need += source.need;
}

export interface CellCoverage extends StageMap {
  /** Total writes available on disk (not capped by N). */
  maxWrites: number;
  writeCacheIds: string[];
  complete: boolean;
}

export interface Covering {
  writerKeys: string[];
  promptIds: string[];
  judgeKeys: string[];
  outputsPerModel: number;
}

export interface CacheStatusResult {
  outputsPerModel: number;
  writerKeys: string[];
  judgeKeys: string[];
  /** True when no --judges flag was passed and no judgment dirs exist on disk. */
  judgesDefaultToWriters: boolean;
  prompts: PromptConfig[];
  /** writerKey → promptId → coverage */
  matrix: Map<string, Map<string, CellCoverage>>;
  coverings: Covering[];
  summary: StageMap;
}

// ── Known providers for reverse-mapping ─────────────

// Record<ProviderName, true> ensures a compile error if a new provider is
// added to the ProviderName union but omitted here.
const ALL_PROVIDERS: Record<ProviderName, true> = {
  openai: true,
  anthropic: true,
  google: true,
  "google-vertex": true,
  "google-vertex-anthropic": true,
  openrouter: true,
  opencode: true,
  ollama: true,
};

// Sorted by length descending so longer prefixes match first
// (e.g. "google-vertex-anthropic" before "google-vertex" before "google").
const KNOWN_PROVIDERS = (Object.keys(ALL_PROVIDERS) as ProviderName[]).sort(
  (a, b) => b.length - a.length
);

/**
 * Best-effort reverse-map a cache directory name back to "provider:model".
 * Returns null if no known provider prefix matches.
 *
 * Note: `modelKey()` replaces both `:` and `/` with `_`, so the round-trip
 * is lossy for models whose names contain slashes (e.g. "openrouter:openai/gpt-4o"
 * and "openrouter:openai_gpt-4o" produce the same key). Display names derived
 * from this function may not exactly match the original model spec.
 */
export function reverseModelKey(dirName: string): string | null {
  for (const provider of KNOWN_PROVIDERS) {
    const prefix = provider + "_";
    if (dirName.startsWith(prefix)) {
      const modelPart = dirName.slice(prefix.length);
      if (modelPart.length === 0) continue;
      return `${provider}:${modelPart}`;
    }
  }
  return null;
}

// ── Directory listing helpers ───────────────────────

async function safeDirSet(dir: string): Promise<Set<string>> {
  return new Set(await safeReaddir(dir));
}

/** Check if a cache file exists in the pre-loaded set, read it, return its cacheId. */
async function readCacheId(
  dir: string,
  fileSet: Set<string>,
  id: string
): Promise<string | null> {
  const fname = `${id}.json`;
  if (!fileSet.has(fname)) return null;
  const entry = await safeReadJson<{ cacheId: string }>(join(dir, fname));
  return entry?.cacheId ?? null;
}

// ── Core analysis ───────────────────────────────────

const DEFAULT_CACHE_DIR = join(process.cwd(), "data", "cache");

/**
 * Analyze the on-disk cache and compute coverage for each
 * (writer, prompt) cell across all pipeline stages.
 */
export async function analyzeCacheStatus(
  opts: AnalyzeCacheOpts
): Promise<CacheStatusResult> {
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  let N = opts.outputsPerModel;
  const { prompts } = opts;

  // ── 1. Build prompt hash lookup ───────────────────
  const promptHashById = new Map<string, string>();
  for (const p of prompts) {
    promptHashById.set(p.id, hashPromptContent(p.prompt));
  }

  // ── 2. Discover or filter writers ─────────────────
  const writesBase = join(cacheDir, "writes");
  const discoveredKeys = await safeReaddir(writesBase);
  const writerKeys = opts.writerKeys
    ? opts.writerKeys.filter((k) => discoveredKeys.includes(k))
    : discoveredKeys;

  // ── 3. Determine judges ───────────────────────────
  const judgesFixed = !!opts.judgeKeys;
  const judgementsBase = join(cacheDir, "judgments");
  const discoveredJudgeKeys = await safeReaddir(judgementsBase);

  // When --judges is specified, use exactly those. Otherwise auto-discover
  // all potential judges from the judgments cache directory.
  const judgeKeys = opts.judgeKeys ?? discoveredJudgeKeys;
  const judgesDefaultToWriters = !opts.judgeKeys && judgeKeys.length === 0;

  // ── 4. Pre-load directory listings for perf ───────
  // Instead of thousands of existsSync calls, read each model dir once.
  const feedbackFileSets = new Map<string, Set<string>>();
  const revisionFileSets = new Map<string, Set<string>>();
  const judgmentFileSets = new Map<string, Set<string>>();

  // Feedback/revisions are keyed by writer; judgments by judge.
  await Promise.all([
    ...writerKeys.map(async (mk) => {
      feedbackFileSets.set(mk, await safeDirSet(join(cacheDir, "feedback", mk)));
      revisionFileSets.set(mk, await safeDirSet(join(cacheDir, "revisions", mk)));
    }),
    ...judgeKeys.map(async (mk) => {
      judgmentFileSets.set(mk, await safeDirSet(join(cacheDir, "judgments", mk)));
    }),
  ]);

  // ── 5. Phase 1: Writes — read cache IDs ──────────
  // writerKey → promptId → cacheId[]
  const writeCacheIds = new Map<string, Map<string, string[]>>();

  await Promise.all(
    writerKeys.map(async (wk) => {
      const byPrompt = new Map<string, string[]>();
      await Promise.all(
        prompts.map(async (p) => {
          const hash = promptHashById.get(p.id)!;
          const dir = join(writesBase, wk, hash);
          const files = (await safeReaddir(dir))
            .filter((f) => f.endsWith(".json"))
            .sort();
          const ids: string[] = [];
          for (const f of files) {
            const entry = await safeReadJson<{ cacheId: string }>(join(dir, f));
            if (entry?.cacheId) ids.push(entry.cacheId);
          }
          byPrompt.set(p.id, ids);
        })
      );
      writeCacheIds.set(wk, byPrompt);
    })
  );

  // ── 5b. Auto-detect N from cache if not specified ──
  if (N <= 0) {
    let maxFound = 0;
    for (const byPrompt of writeCacheIds.values()) {
      for (const ids of byPrompt.values()) {
        if (ids.length > maxFound) maxFound = ids.length;
      }
    }
    N = Math.max(maxFound, 1);
  }

  // ── 6. Phase 2: Feedback — read cache IDs ────────
  // Key: "fbWriterKey:writeCacheId" → feedbackCacheId
  const feedbackCacheIdMap = new Map<string, string>();

  // Flatten all write cacheIds (capped to N) across writers/prompts.
  const allWriteCids: string[] = [];
  for (const byPrompt of writeCacheIds.values()) {
    for (const ids of byPrompt.values()) {
      for (const wCid of ids.slice(0, N)) allWriteCids.push(wCid);
    }
  }

  await Promise.all(
    writerKeys.map(async (fbWk) => {
      const fileSet = feedbackFileSets.get(fbWk) ?? new Set();
      const fbDir = join(cacheDir, "feedback", fbWk);
      for (const wCid of allWriteCids) {
        const fbCid = await readCacheId(fbDir, fileSet, wCid);
        if (fbCid) feedbackCacheIdMap.set(`${fbWk}:${wCid}`, fbCid);
      }
    })
  );

  // ── 7. Phase 3: Revisions — read cache IDs ───────
  // Key: "writerKey:feedbackCacheId" → revisionCacheId
  const revisionCacheIdMap = new Map<string, string>();

  await Promise.all(
    writerKeys.map(async (wk) => {
      const fileSet = revisionFileSets.get(wk) ?? new Set();
      const revDir = join(cacheDir, "revisions", wk);
      // Revisions are done by the original writer, not the feedback giver.
      // We check all feedbackCacheIds for each writer.
      for (const [, fbCid] of feedbackCacheIdMap) {
        const revCid = await readCacheId(revDir, fileSet, fbCid);
        if (revCid) revisionCacheIdMap.set(`${wk}:${fbCid}`, revCid);
      }
    })
  );

  // ── 8. Build per-cell coverage matrix ─────────────
  const matrix = new Map<string, Map<string, CellCoverage>>();

  for (const wk of writerKeys) {
    const byPrompt = new Map<string, CellCoverage>();

    for (const p of prompts) {
      const allIds = writeCacheIds.get(wk)?.get(p.id) ?? [];
      const usableIds = allIds.slice(0, N);

      // Expected downstream counts for this cell based on formula,
      // regardless of whether upstream stages are cached. This gives
      // honest "need" numbers even when writes are missing.
      const W = writerKeys.length;
      const J = judgeKeys.length;
      const expectedFb = N * W;       // Every writer gives feedback on each sample
      const expectedRev = N * W;      // Original writer revises with each feedback
      const expectedImp = N * W * J;  // Each revision vs original, by each judge

      // ── Feedback for this cell ──────────────
      // Every writer gives feedback on each of this writer's samples
      let fbHave = 0;
      const cellFeedbackCids = new Map<string, string>();
      for (const wCid of usableIds) {
        for (const fbWk of writerKeys) {
          const fbKey = `${fbWk}:${wCid}`;
          const fbCid = feedbackCacheIdMap.get(fbKey);
          if (fbCid) {
            fbHave++;
            cellFeedbackCids.set(fbKey, fbCid);
          }
        }
      }

      // ── Revisions for this cell ─────────────
      // Original writer revises with each feedback
      let revHave = 0;
      const cellRevisionCids = new Map<string, string>();
      for (const [fbKey, fbCid] of cellFeedbackCids) {
        const revKey = `${wk}:${fbCid}`;
        const revCid = revisionCacheIdMap.get(revKey);
        if (revCid) {
          revHave++;
          cellRevisionCids.set(revKey, revCid);
        }
      }

      // ── Improvement judgments for this cell ──
      let impHave = 0;
      for (const wCid of usableIds) {
        for (const fbWk of writerKeys) {
          const fbKey = `${fbWk}:${wCid}`;
          const fbCid = feedbackCacheIdMap.get(fbKey);
          if (!fbCid) continue;
          const revKey = `${wk}:${fbCid}`;
          const revCid = revisionCacheIdMap.get(revKey);
          if (!revCid) continue;
          for (const jk of judgeKeys) {
            const hash = judgmentPairHash("improvement", wCid, revCid);
            const jFiles = judgmentFileSets.get(jk) ?? new Set();
            if (jFiles.has(`${hash}.json`)) {
              impHave++;
            }
          }
        }
      }

      // Initial and revised judgments are cross-writer (per-prompt),
      // so we compute them later. Store placeholder counts.
      const cell: CellCoverage = {
        writes: { have: usableIds.length, need: N },
        maxWrites: allIds.length,
        writeCacheIds: usableIds,
        initialJudgments: { have: 0, need: 0 },
        feedback: { have: fbHave, need: expectedFb },
        revisions: { have: revHave, need: expectedRev },
        improvementJudgments: { have: impHave, need: expectedImp },
        revisedJudgments: { have: 0, need: 0 },
        complete: false,
      };
      byPrompt.set(p.id, cell);
    }
    matrix.set(wk, byPrompt);
  }

  // ── 9. Cross-writer judgments (initial + revised) ─
  for (const p of prompts) {
    // Gather all write cacheIds across all writers for this prompt
    const allWriteCids: { writerKey: string; cacheId: string }[] = [];
    for (const wk of writerKeys) {
      const cell = matrix.get(wk)?.get(p.id);
      if (cell) {
        for (const cid of cell.writeCacheIds) {
          allWriteCids.push({ writerKey: wk, cacheId: cid });
        }
      }
    }

    // Initial judgments: all pairs of write cacheIds
    const initialPairs = allPairs(allWriteCids.map((e) => e.cacheId));

    // Check each pair × judge and count per-prompt
    let ijHave = 0;
    let ijNeed = 0;
    for (const [cidA, cidB] of initialPairs) {
      for (const jk of judgeKeys) {
        ijNeed++;
        const hash = judgmentPairHash("initial", cidA, cidB);
        const jFiles = judgmentFileSets.get(jk) ?? new Set();
        if (jFiles.has(`${hash}.json`)) {
          ijHave++;
        }
      }
    }

    // Distribute initial judgment counts across cells for this prompt
    // Each cell gets the full prompt-level counts (since initial judgments
    // are a prompt-level concern, not per-writer)
    for (const wk of writerKeys) {
      const cell = matrix.get(wk)?.get(p.id);
      if (cell) {
        cell.initialJudgments = { have: ijHave, need: ijNeed };
      }
    }

    // Revised judgments: group revisions by feedback source, pair within group
    let rjHave = 0;
    let rjNeed = 0;
    for (const fbWk of writerKeys) {
      // Collect revision cacheIds for this prompt × feedback source
      const revCids: string[] = [];
      for (const wk of writerKeys) {
        const cell = matrix.get(wk)?.get(p.id);
        if (!cell) continue;
        for (const wCid of cell.writeCacheIds) {
          const fbKey = `${fbWk}:${wCid}`;
          const fbCid = feedbackCacheIdMap.get(fbKey);
          if (!fbCid) continue;
          const revKey = `${wk}:${fbCid}`;
          const revCid = revisionCacheIdMap.get(revKey);
          if (revCid) revCids.push(revCid);
        }
      }

      const revPairs = allPairs(revCids);
      for (const [rCidA, rCidB] of revPairs) {
        for (const jk of judgeKeys) {
          rjNeed++;
          const hash = judgmentPairHash("revised", rCidA, rCidB);
          const jFiles = judgmentFileSets.get(jk) ?? new Set();
          if (jFiles.has(`${hash}.json`)) {
            rjHave++;
          }
        }
      }
    }

    // Also account for revised judgment pairs that WOULD exist if
    // all revisions were cached. For each feedback group, we need
    // C(W*N, 2) revision pairs. If revisions are missing, those
    // judgments are also missing.
    const expectedRevsPerGroup = writerKeys.length * N;
    const expectedPairsPerGroup =
      (expectedRevsPerGroup * (expectedRevsPerGroup - 1)) / 2;
    const expectedRjNeed =
      writerKeys.length * expectedPairsPerGroup * judgeKeys.length;

    // Use the max of computed need vs expected need
    rjNeed = Math.max(rjNeed, expectedRjNeed);

    for (const wk of writerKeys) {
      const cell = matrix.get(wk)?.get(p.id);
      if (cell) {
        cell.revisedJudgments = { have: rjHave, need: rjNeed };
      }
    }
  }

  // ── 10. Mark cells complete ───────────────────────
  for (const wk of writerKeys) {
    for (const p of prompts) {
      const cell = matrix.get(wk)?.get(p.id);
      if (!cell) continue;
      cell.complete = STAGE_KEYS.every(
        (k) => cell[k].have >= cell[k].need
      );
    }
  }

  // ── 11. Compute summary ───────────────────────────
  const summary = {
    writes: { have: 0, need: 0 },
    initialJudgments: { have: 0, need: 0 },
    feedback: { have: 0, need: 0 },
    revisions: { have: 0, need: 0 },
    improvementJudgments: { have: 0, need: 0 },
    revisedJudgments: { have: 0, need: 0 },
  };
  // Per-prompt stages (initial/revised judgments) — identical across writers,
  // so read from the first writer's cell only.
  for (const p of prompts) {
    const cell = matrix.get(writerKeys[0])?.get(p.id);
    if (!cell) continue;
    for (const k of PER_PROMPT_STAGES) addCounts(summary[k], cell[k]);
  }
  // Per-writer stages — sum across all writers × prompts.
  for (const wk of writerKeys) {
    for (const p of prompts) {
      const cell = matrix.get(wk)?.get(p.id);
      if (!cell) continue;
      for (const k of PER_WRITER_STAGES) addCounts(summary[k], cell[k]);
    }
  }

  // ── 12. Find maximal coverings ────────────────────
  const coverings = findMaximalCoverings(writerKeys, prompts, N, {
    writeCacheIds,
    feedbackCacheIdMap,
    revisionCacheIdMap,
    judgmentFileSets,
    candidateJudges: judgeKeys,
    judgesFixed,
  });

  return {
    outputsPerModel: N,
    writerKeys,
    judgeKeys,
    judgesDefaultToWriters,
    prompts,
    matrix,
    coverings,
    summary,
  };
}

// ── Covering context ────────────────────────────────

/** Shared cache data threaded through the covering search. */
export interface CoveringContext {
  writeCacheIds: Map<string, Map<string, string[]>>;
  feedbackCacheIdMap: Map<string, string>;
  revisionCacheIdMap: Map<string, string>;
  judgmentFileSets: Map<string, Set<string>>;
  candidateJudges: string[];
  judgesFixed: boolean;
}

// ── Maximal coverings ───────────────────────────────

/**
 * Find diverse, non-dominated (writerSubset × promptSubset × judgeSubset × N)
 * coverings where the entire pipeline is cached. Tries multiple N levels
 * (from maxN down to 1) and diverse starting points to find overlapping
 * coverings that represent different trade-offs (e.g. more writers with
 * fewer prompts, or higher N with a smaller subset).
 */
export function findMaximalCoverings(
  allWriters: string[],
  allPrompts: PromptConfig[],
  maxN: number,
  ctx: CoveringContext
): Covering[] {
  const allPromptIds = allPrompts.map((p) => p.id);
  const rawCoverings: Covering[] = [];

  for (let n = maxN; n >= 1; n--) {
    const coverings = findDiverseCoveringsAtN(allWriters, allPromptIds, n, ctx);
    rawCoverings.push(...coverings);
  }

  const unique = deduplicateCoverings(rawCoverings);
  const nonDominated = filterDominated(unique);

  // Sort by value (writers × prompts × N × judges), descending
  nonDominated.sort((a, b) => {
    const aVal = a.writerKeys.length * a.promptIds.length * a.outputsPerModel * a.judgeKeys.length;
    const bVal = b.writerKeys.length * b.promptIds.length * b.outputsPerModel * b.judgeKeys.length;
    return bVal - aVal;
  });

  return nonDominated;
}

/**
 * Find diverse coverings at a single N level by running the greedy
 * search from multiple starting points (full set, single-item removals,
 * and complementary sets from the first covering found).
 */
function findDiverseCoveringsAtN(
  allWriters: string[],
  allPromptIds: string[],
  N: number,
  ctx: CoveringContext
): Covering[] {
  const results: Covering[] = [];

  const run = (writers: string[], prompts: string[]) =>
    findLargestCovering(writers, prompts, N, ctx);

  // 1. Try from full set
  const full = run(allWriters, allPromptIds);
  if (full) results.push(full);

  // 2. Try removing each writer (explore "more prompts, fewer writers")
  if (allWriters.length > 2) {
    for (const w of allWriters) {
      const remaining = allWriters.filter((x) => x !== w);
      const covering = run(remaining, allPromptIds);
      if (covering) results.push(covering);
    }
  }

  // 3. Try removing each prompt (explore "more writers, fewer prompts")
  if (allPromptIds.length > 1) {
    for (const pid of allPromptIds) {
      const remaining = allPromptIds.filter((x) => x !== pid);
      const covering = run(allWriters, remaining);
      if (covering) results.push(covering);
    }
  }

  // 4. Try complementary sets from the first covering found
  if (full) {
    const compWriters = allWriters.filter((w) => !full.writerKeys.includes(w));
    if (compWriters.length >= 2) {
      const covering = run(compWriters, allPromptIds);
      if (covering) results.push(covering);
    }

    const compPrompts = allPromptIds.filter((p) => !full.promptIds.includes(p));
    if (compPrompts.length >= 1) {
      const covering = run(allWriters, compPrompts);
      if (covering) results.push(covering);
    }

    // 5. For each writer excluded by the first covering, constrain prompts
    //    to what that writer can handle, then try with all writers. This
    //    finds coverings that trade fewer prompts for more writers.
    for (const w of allWriters) {
      if (full.writerKeys.includes(w)) continue;
      const wPrompts = allPromptIds.filter((pid) =>
        (ctx.writeCacheIds.get(w)?.get(pid) ?? []).length >= N
      );
      if (wPrompts.length >= 1) {
        const covering = run(allWriters, wPrompts);
        if (covering) results.push(covering);
      }
    }
  }

  return results;
}

// ── Covering dedup / dominance ──────────────────────

function coveringKey(c: Covering): string {
  return [
    c.outputsPerModel,
    [...c.writerKeys].sort().join(","),
    [...c.promptIds].sort().join(","),
    [...c.judgeKeys].sort().join(","),
  ].join("|");
}

function deduplicateCoverings(coverings: Covering[]): Covering[] {
  const seen = new Set<string>();
  const result: Covering[] = [];
  for (const c of coverings) {
    const key = coveringKey(c);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }
  return result;
}

function isSubsetOf(small: string[], large: string[]): boolean {
  const set = new Set(large);
  return small.every((x) => set.has(x));
}

/**
 * Remove coverings that are strictly dominated by another covering.
 * A covering C1 dominates C2 if C1 is a superset in all dimensions
 * (writers, prompts, judges, N) with at least one strict improvement.
 */
export function filterDominated(coverings: Covering[]): Covering[] {
  return coverings.filter((a) =>
    !coverings.some((b) =>
      a !== b &&
      b.outputsPerModel >= a.outputsPerModel &&
      isSubsetOf(a.writerKeys, b.writerKeys) &&
      isSubsetOf(a.promptIds, b.promptIds) &&
      isSubsetOf(a.judgeKeys, b.judgeKeys) &&
      (b.outputsPerModel > a.outputsPerModel ||
        b.writerKeys.length > a.writerKeys.length ||
        b.promptIds.length > a.promptIds.length ||
        b.judgeKeys.length > a.judgeKeys.length)
    )
  );
}

/**
 * Greedy search: start with all writers × prompts, iteratively
 * remove entities until we find a valid covering with ≥1 valid judge.
 */
function findLargestCovering(
  writers: string[],
  promptIds: string[],
  N: number,
  ctx: CoveringContext
): Covering | null {
  const { writeCacheIds, candidateJudges, judgesFixed } = ctx;
  let currentWriters = [...writers];
  let currentPrompts = [...promptIds];

  const writes = (w: string, pid: string) =>
    (writeCacheIds.get(w)?.get(pid) ?? []).length;

  // First, prune writers/prompts with insufficient writes
  currentWriters = currentWriters.filter((w) =>
    currentPrompts.some((pid) => writes(w, pid) >= N)
  );
  currentPrompts = currentPrompts.filter((pid) =>
    currentWriters.some((w) => writes(w, pid) >= N)
  );

  while (currentWriters.length >= 2 && currentPrompts.length >= 1) {
    // Remove writers that are missing writes for ANY current prompt
    const writersWithFullWrites = currentWriters.filter((w) =>
      currentPrompts.every((pid) => writes(w, pid) >= N)
    );

    if (writersWithFullWrites.length < currentWriters.length) {
      if (writersWithFullWrites.length < 2) {
        const promptFailCounts = new Map<string, number>();
        for (const pid of currentPrompts) {
          let fails = 0;
          for (const w of currentWriters) {
            if (writes(w, pid) < N) fails++;
          }
          promptFailCounts.set(pid, fails);
        }
        let worstPid = "";
        let worstCount = -1;
        for (const [pid, c] of promptFailCounts) {
          if (c > worstCount) { worstPid = pid; worstCount = c; }
        }
        if (worstCount <= 0 || currentPrompts.length <= 1) break;
        currentPrompts = currentPrompts.filter((p) => p !== worstPid);
        continue;
      }
      currentWriters = writersWithFullWrites;
      continue;
    }

    // All current writers have writes for all current prompts.
    // Check prerequisites (judge-independent) and find valid judges.
    const validJudges = findValidJudges(currentWriters, currentPrompts, N, ctx);

    if (judgesFixed) {
      if (validJudges.length === candidateJudges.length) {
        return { writerKeys: currentWriters, promptIds: currentPrompts, judgeKeys: validJudges, outputsPerModel: N };
      }
    } else {
      if (validJudges.length > 0) {
        return { writerKeys: currentWriters, promptIds: currentPrompts, judgeKeys: validJudges, outputsPerModel: N };
      }
    }

    // Try each single removal and pick the one that yields the best result.
    type Candidate = { type: "writer" | "prompt"; key: string };
    const candidates: Candidate[] = [
      ...(currentWriters.length > 2
        ? currentWriters.map((w) => ({ type: "writer" as const, key: w }))
        : []),
      ...(currentPrompts.length > 1
        ? currentPrompts.map((p) => ({ type: "prompt" as const, key: p }))
        : []),
    ];

    let best: Candidate | null = null;
    let bestArea = -1;
    let bestJudgeCount = -1;
    let bestValid = false;

    for (const c of candidates) {
      const remWriters = c.type === "writer"
        ? currentWriters.filter((x) => x !== c.key)
        : currentWriters;
      const remPrompts = c.type === "prompt"
        ? currentPrompts.filter((x) => x !== c.key)
        : currentPrompts;
      const area = remWriters.length * remPrompts.length;
      const judges = findValidJudges(remWriters, remPrompts, N, ctx);
      const valid = judgesFixed
        ? judges.length === candidateJudges.length
        : judges.length > 0;
      if (valid && (!bestValid || area > bestArea || (area === bestArea && judges.length > bestJudgeCount))) {
        best = c;
        bestArea = area;
        bestJudgeCount = judges.length;
        bestValid = true;
      } else if (!bestValid && area > bestArea) {
        best = c;
        bestArea = area;
      }
    }

    if (!best) break;

    if (best.type === "writer") {
      currentWriters = currentWriters.filter((w) => w !== best!.key);
    } else {
      currentPrompts = currentPrompts.filter((p) => p !== best!.key);
    }
  }

  return null;
}

// ── Pipeline verification ───────────────────────────

/**
 * Check judge-independent prerequisites (writes, feedback, revisions)
 * for a given (writers × prompts) combination. Returns the judgment
 * hashes needed so per-judge checks can run without recomputing them.
 *
 * Returns null if prerequisites fail (missing writes/feedback/revisions).
 */
export function checkPrerequisites(
  writers: string[],
  promptIds: string[],
  N: number,
  writeCacheIds: Map<string, Map<string, string[]>>,
  feedbackCacheIdMap: Map<string, string>,
  revisionCacheIdMap: Map<string, string>
): { judgmentHashes: string[] } | null {
  const hashes: string[] = [];

  for (const pid of promptIds) {
    const promptWriteCids: { writerKey: string; cacheId: string }[] = [];
    for (const wk of writers) {
      const ids = writeCacheIds.get(wk)?.get(pid) ?? [];
      if (ids.length < N) return null;
      for (let i = 0; i < N; i++) {
        promptWriteCids.push({ writerKey: wk, cacheId: ids[i] });
      }
    }

    // Feedback
    for (const { cacheId: wCid } of promptWriteCids) {
      for (const fbWk of writers) {
        if (!feedbackCacheIdMap.has(`${fbWk}:${wCid}`)) return null;
      }
    }

    // Revisions
    for (const { writerKey: wk, cacheId: wCid } of promptWriteCids) {
      for (const fbWk of writers) {
        const fbCid = feedbackCacheIdMap.get(`${fbWk}:${wCid}`);
        if (!fbCid) return null;
        if (!revisionCacheIdMap.has(`${wk}:${fbCid}`)) return null;
      }
    }

    // Collect all judgment hashes needed (initial + improvement + revised)
    const writeCidList = promptWriteCids.map((e) => e.cacheId);
    for (const [cidA, cidB] of allPairs(writeCidList)) {
      hashes.push(judgmentPairHash("initial", cidA, cidB));
    }

    for (const { writerKey: wk, cacheId: wCid } of promptWriteCids) {
      for (const fbWk of writers) {
        const fbCid = feedbackCacheIdMap.get(`${fbWk}:${wCid}`)!;
        const revCid = revisionCacheIdMap.get(`${wk}:${fbCid}`)!;
        hashes.push(judgmentPairHash("improvement", wCid, revCid));
      }
    }

    for (const fbWk of writers) {
      const revCids: string[] = [];
      for (const { writerKey: wk, cacheId: wCid } of promptWriteCids) {
        const fbCid = feedbackCacheIdMap.get(`${fbWk}:${wCid}`)!;
        const revCid = revisionCacheIdMap.get(`${wk}:${fbCid}`)!;
        revCids.push(revCid);
      }
      for (const [rCidA, rCidB] of allPairs(revCids)) {
        hashes.push(judgmentPairHash("revised", rCidA, rCidB));
      }
    }
  }

  return { judgmentHashes: hashes };
}

/**
 * Check if a single judge has all required judgment files.
 */
export function checkJudgeCoverage(
  judgeKey: string,
  judgmentHashes: string[],
  judgmentFileSets: Map<string, Set<string>>
): boolean {
  const fileSet = judgmentFileSets.get(judgeKey) ?? new Set();
  for (const hash of judgmentHashes) {
    if (!fileSet.has(`${hash}.json`)) return false;
  }
  return true;
}

/**
 * Find which candidate judges have full coverage for a given
 * (writers × prompts) combination.
 */
export function findValidJudges(
  writers: string[],
  promptIds: string[],
  N: number,
  ctx: Pick<CoveringContext, "writeCacheIds" | "feedbackCacheIdMap" | "revisionCacheIdMap" | "judgmentFileSets" | "candidateJudges">
): string[] {
  const prereqs = checkPrerequisites(
    writers, promptIds, N,
    ctx.writeCacheIds, ctx.feedbackCacheIdMap, ctx.revisionCacheIdMap
  );
  if (!prereqs) return [];

  return ctx.candidateJudges.filter((jk) =>
    checkJudgeCoverage(jk, prereqs.judgmentHashes, ctx.judgmentFileSets)
  );
}

// ── Utility ─────────────────────────────────────────

/** Generate all unique pairs from an array. */
export function allPairs<T>(items: T[]): [T, T][] {
  const result: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      result.push([items[i], items[j]]);
    }
  }
  return result;
}

// ── Display formatting ──────────────────────────────

/**
 * Format cache status as a human-readable table string.
 */
export function formatCacheStatusTable(result: CacheStatusResult): string {
  const lines: string[] = [];
  const { writerKeys, prompts, matrix, coverings, summary } = result;

  // Header
  const judgeNote = result.judgesDefaultToWriters
    ? "judges=writers"
    : `${result.judgeKeys.length} candidate judges`;
  lines.push(
    `Cache Status (${prompts.length} prompts, ${writerKeys.length} writers, ${judgeNote})`
  );
  lines.push("=".repeat(70));
  lines.push("");

  const displayKey = (k: string) => reverseModelKey(k) ?? k;

  // ── Coverings (primary output) ────────────────
  if (coverings.length > 0) {
    lines.push("Fully Cached Runs (0 API calls needed)");
    lines.push("-".repeat(70));
    for (let i = 0; i < coverings.length; i++) {
      const c = coverings[i];
      const writerNames = c.writerKeys.map(displayKey);
      const judgeNames = c.judgeKeys.map(displayKey);
      lines.push(
        `${i + 1}. ${c.writerKeys.length} writers \u00d7 ${c.promptIds.length} prompts \u00d7 ${c.judgeKeys.length} judges (N=${c.outputsPerModel})`
      );
      lines.push(`   Writers: ${writerNames.join(", ")}`);
      lines.push(`   Prompts: ${c.promptIds.join(", ")}`);
      lines.push(`   Judges:  ${judgeNames.join(", ")}`);
      lines.push("");
    }
  } else {
    lines.push("No fully cached runs found.");
    lines.push("");
  }

  // ── Write availability ────────────────────────
  // Compact per-writer summary: how many prompts have sufficient writes
  // at each N level. Chunked into groups to avoid overly wide output.
  const maxN = result.outputsPerModel;
  const nLevels = Array.from({ length: maxN }, (_, i) => i + 1);
  const promptIds = prompts.map((p) => p.id);

  lines.push("Write Availability (prompts with sufficient writes at each N)");
  lines.push("-".repeat(70));

  const nameColWidth = Math.max(
    ...writerKeys.map((wk) => displayKey(wk).length),
    5
  );

  // Pre-compute counts: writerKey → n → count of prompts with >= n writes
  const writeCounts = new Map<string, Map<number, number>>();
  for (const wk of writerKeys) {
    const byN = new Map<number, number>();
    for (const n of nLevels) {
      let count = 0;
      for (const pid of promptIds) {
        const cell = matrix.get(wk)?.get(pid);
        if (cell && cell.maxWrites >= n) count++;
      }
      byN.set(n, count);
    }
    writeCounts.set(wk, byN);
  }

  const MAX_N_COLS = 10;
  for (let chunkStart = 0; chunkStart < nLevels.length; chunkStart += MAX_N_COLS) {
    const chunk = nLevels.slice(chunkStart, chunkStart + MAX_N_COLS);

    // Header row for this chunk
    const nHeaders = chunk.map((n) => `N=${n}`.padStart(7)).join("");
    lines.push("".padEnd(nameColWidth + 2) + nHeaders);

    for (const wk of writerKeys) {
      const name = displayKey(wk).padEnd(nameColWidth + 2);
      const cols = chunk.map((n) => {
        const count = writeCounts.get(wk)?.get(n) ?? 0;
        const total = promptIds.length;
        const label = count === 0 ? "\u00b7" : count === total ? `${total}/${total}` : `${count}/${total}`;
        return label.padStart(7);
      });
      lines.push(name + cols.join(""));
    }

    // Blank line between chunks (but not after the last one)
    if (chunkStart + MAX_N_COLS < nLevels.length) {
      lines.push("");
    }
  }
  lines.push("");

  // ── Summary ───────────────────────────────────
  const totalHave = STAGE_KEYS.reduce((s, k) => s + summary[k].have, 0);
  const totalNeed = STAGE_KEYS.reduce((s, k) => s + summary[k].need, 0);
  const pct = totalNeed > 0 ? ((totalHave / totalNeed) * 100).toFixed(1) : "0.0";

  lines.push("Summary");
  lines.push("-".repeat(70));
  lines.push(`Total cached: ${totalHave}/${totalNeed} pipeline artifacts (${pct}%)`);
  lines.push(
    `  Writes: ${summary.writes.have}/${summary.writes.need}` +
    `  Initial judging: ${summary.initialJudgments.have}/${summary.initialJudgments.need}`
  );
  lines.push(
    `  Feedback: ${summary.feedback.have}/${summary.feedback.need}` +
    `  Revisions: ${summary.revisions.have}/${summary.revisions.need}`
  );
  lines.push(
    `  Improvement judging: ${summary.improvementJudgments.have}/${summary.improvementJudgments.need}` +
    `  Revised judging: ${summary.revisedJudgments.have}/${summary.revisedJudgments.need}`
  );

  return lines.join("\n");
}

/**
 * Format cache status as JSON.
 */
export function formatCacheStatusJson(result: CacheStatusResult): string {
  const displayKey = (k: string) => reverseModelKey(k) ?? k;

  const matrixObj: Record<string, Record<string, object>> = {};
  for (const [wk, byPrompt] of result.matrix) {
    matrixObj[displayKey(wk)] = {};
    for (const [pid, cell] of byPrompt) {
      matrixObj[displayKey(wk)][pid] = {
        writes: cell.writes,
        maxWrites: cell.maxWrites,
        initialJudgments: cell.initialJudgments,
        feedback: cell.feedback,
        revisions: cell.revisions,
        improvementJudgments: cell.improvementJudgments,
        revisedJudgments: cell.revisedJudgments,
        complete: cell.complete,
      };
    }
  }

  const coveringsObj = result.coverings.map((c) => ({
    writers: c.writerKeys.map(displayKey),
    prompts: c.promptIds,
    judges: c.judgeKeys.map(displayKey),
    outputsPerModel: c.outputsPerModel,
    cells: c.writerKeys.length * c.promptIds.length,
  }));

  return JSON.stringify(
    {
      config: {
        outputsPerModel: result.outputsPerModel,
        prompts: result.prompts.map((p) => p.id),
        writers: result.writerKeys.map(displayKey),
        judges: result.judgeKeys.map(displayKey),
        judgesDefaultToWriters: result.judgesDefaultToWriters,
      },
      matrix: matrixObj,
      coverings: coveringsObj,
      summary: result.summary,
    },
    null,
    2
  );
}
