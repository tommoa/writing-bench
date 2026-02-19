import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { rm, mkdir, writeFile, readdir, readFile } from "fs/promises";
import { join } from "path";
import type { CacheStatusResult, Covering, CacheDiskSize } from "./cache-status.js";
import {
  reverseModelKey,
  allPairs,
  findMaximalCoverings,
  filterDominated,
  analyzeCacheStatus,
  formatCacheStatusTable,
  formatCacheStatusJson,
  formatBytes,
  computeCacheDiskSize,
} from "./cache-status.js";
import { hashPromptContent, modelKey, judgmentPairHash } from "./sample-cache.js";
import type { PromptConfig } from "../types.js";

// ── Helpers ─────────────────────────────────────────

const TEST_CACHE_DIR = join(process.cwd(), "data", "test-cache-status");

function makePrompt(id: string, text?: string): PromptConfig {
  return {
    id,
    name: `Prompt: ${id}`,
    tags: ["test"],
    description: `Test prompt ${id}`,
    prompt: text ?? `Write something about ${id}.`,
    judgingCriteria: ["quality"],
  };
}

async function writeJson(path: string, data: object): Promise<void> {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

/**
 * Populate a synthetic cache directory for a set of writers, prompts,
 * and judges with complete pipeline coverage.
 *
 * Returns the cacheId mappings needed for verification.
 */
async function populateFullCache(opts: {
  cacheDir: string;
  writers: { provider: string; model: string }[];
  judges: { provider: string; model: string }[];
  prompts: PromptConfig[];
  N: number;
}): Promise<{
  writeCacheIds: Map<string, Map<string, string[]>>;
  feedbackCacheIds: Map<string, string>;
  revisionCacheIds: Map<string, string>;
}> {
  const { cacheDir, writers, judges, prompts, N } = opts;
  const writeCacheIds = new Map<string, Map<string, string[]>>();
  const feedbackCacheIds = new Map<string, string>();
  const revisionCacheIds = new Map<string, string>();

  // ── Stage 1: Writes ───────────────────────────
  let writeCounter = 0;
  for (const w of writers) {
    const mk = modelKey(w.provider, w.model);
    const byPrompt = new Map<string, string[]>();
    for (const p of prompts) {
      const hash = hashPromptContent(p.prompt);
      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const cacheId = `w-${mk}-${p.id}-${i}`;
        ids.push(cacheId);
        const dir = join(cacheDir, "writes", mk, hash);
        await writeJson(join(dir, `sample_${i}.json`), {
          cacheId,
          text: `Sample output ${writeCounter++}`,
          usage: { inputTokens: 100, outputTokens: 500 },
          cost: { input: 0.001, output: 0.005, total: 0.006, totalUncached: 0.006 },
          latencyMs: 1000,
          createdAt: "2026-01-01T00:00:00Z",
        });
      }
      byPrompt.set(p.id, ids);
    }
    writeCacheIds.set(mk, byPrompt);
  }

  // ── Stage 2: Initial judgments ─────────────────
  for (const p of prompts) {
    const allCids: string[] = [];
    for (const w of writers) {
      const mk = modelKey(w.provider, w.model);
      const ids = writeCacheIds.get(mk)!.get(p.id)!;
      allCids.push(...ids);
    }
    const pairs = allPairs(allCids);
    for (const [cidA, cidB] of pairs) {
      for (const j of judges) {
        const jk = modelKey(j.provider, j.model);
        const hash = judgmentPairHash("initial", cidA, cidB);
        await writeJson(join(cacheDir, "judgments", jk, `${hash}.json`), {
          cacheId: `ij-${hash}`,
          winner: "A",
          reasoning: "test",
          stage: "initial",
          usage: { inputTokens: 100, outputTokens: 50 },
          cost: { input: 0.001, output: 0.001, total: 0.002, totalUncached: 0.002 },
          latencyMs: 500,
          createdAt: "2026-01-01T00:00:00Z",
        });
      }
    }
  }

  // ── Stage 3: Feedback ─────────────────────────
  for (const w of writers) {
    const mk = modelKey(w.provider, w.model);
    for (const p of prompts) {
      const writeIds = writeCacheIds.get(mk)!.get(p.id)!;
      for (const wCid of writeIds) {
        for (const fbW of writers) {
          const fbMk = modelKey(fbW.provider, fbW.model);
          const fbCacheId = `fb-${fbMk}-${wCid}`;
          feedbackCacheIds.set(`${fbMk}:${wCid}`, fbCacheId);
          await writeJson(
            join(cacheDir, "feedback", fbMk, `${wCid}.json`),
            {
              cacheId: fbCacheId,
              writeCacheId: wCid,
              sourceModel: fbW.model,
              text: "Feedback text",
              usage: { inputTokens: 200, outputTokens: 100 },
              cost: { input: 0.002, output: 0.001, total: 0.003, totalUncached: 0.003 },
              latencyMs: 800,
              createdAt: "2026-01-01T00:00:00Z",
            }
          );
        }
      }
    }
  }

  // ── Stage 4: Revisions ────────────────────────
  for (const w of writers) {
    const mk = modelKey(w.provider, w.model);
    for (const p of prompts) {
      const writeIds = writeCacheIds.get(mk)!.get(p.id)!;
      for (const wCid of writeIds) {
        for (const fbW of writers) {
          const fbMk = modelKey(fbW.provider, fbW.model);
          const fbKey = `${fbMk}:${wCid}`;
          const fbCacheId = feedbackCacheIds.get(fbKey)!;
          const revCacheId = `rev-${mk}-${fbCacheId}`;
          revisionCacheIds.set(`${mk}:${fbCacheId}`, revCacheId);
          await writeJson(
            join(cacheDir, "revisions", mk, `${fbCacheId}.json`),
            {
              cacheId: revCacheId,
              feedbackCacheId: fbCacheId,
              text: "Revised output",
              usage: { inputTokens: 300, outputTokens: 600 },
              cost: { input: 0.003, output: 0.006, total: 0.009, totalUncached: 0.009 },
              latencyMs: 1500,
              createdAt: "2026-01-01T00:00:00Z",
            }
          );
        }
      }
    }
  }

  // ── Stage 5: Improvement judgments ─────────────
  for (const w of writers) {
    const mk = modelKey(w.provider, w.model);
    for (const p of prompts) {
      const writeIds = writeCacheIds.get(mk)!.get(p.id)!;
      for (const wCid of writeIds) {
        for (const fbW of writers) {
          const fbMk = modelKey(fbW.provider, fbW.model);
          const fbKey = `${fbMk}:${wCid}`;
          const fbCacheId = feedbackCacheIds.get(fbKey)!;
          const revKey = `${mk}:${fbCacheId}`;
          const revCacheId = revisionCacheIds.get(revKey)!;
          const hash = judgmentPairHash("improvement", wCid, revCacheId);
          for (const j of judges) {
            const jk = modelKey(j.provider, j.model);
            await writeJson(
              join(cacheDir, "judgments", jk, `${hash}.json`),
              {
                cacheId: `imp-${hash}`,
                winner: "B",
                reasoning: "revised is better",
                stage: "improvement",
                usage: { inputTokens: 100, outputTokens: 50 },
                cost: { input: 0.001, output: 0.001, total: 0.002, totalUncached: 0.002 },
                latencyMs: 500,
                createdAt: "2026-01-01T00:00:00Z",
              }
            );
          }
        }
      }
    }
  }

  // ── Stage 6: Revised judgments ─────────────────
  for (const p of prompts) {
    for (const fbW of writers) {
      const fbMk = modelKey(fbW.provider, fbW.model);
      // Collect revision cacheIds for this prompt + feedback source
      const revCids: string[] = [];
      for (const w of writers) {
        const mk = modelKey(w.provider, w.model);
        const writeIds = writeCacheIds.get(mk)!.get(p.id)!;
        for (const wCid of writeIds) {
          const fbKey = `${fbMk}:${wCid}`;
          const fbCacheId = feedbackCacheIds.get(fbKey)!;
          const revKey = `${mk}:${fbCacheId}`;
          const revCacheId = revisionCacheIds.get(revKey)!;
          revCids.push(revCacheId);
        }
      }

      const revPairs = allPairs(revCids);
      for (const [rCidA, rCidB] of revPairs) {
        const hash = judgmentPairHash("revised", rCidA, rCidB);
        for (const j of judges) {
          const jk = modelKey(j.provider, j.model);
          await writeJson(
            join(cacheDir, "judgments", jk, `${hash}.json`),
            {
              cacheId: `rj-${hash}`,
              winner: "A",
              reasoning: "test revised",
              stage: "revised",
              usage: { inputTokens: 100, outputTokens: 50 },
              cost: { input: 0.001, output: 0.001, total: 0.002, totalUncached: 0.002 },
              latencyMs: 500,
              createdAt: "2026-01-01T00:00:00Z",
            }
          );
        }
      }
    }
  }

  return { writeCacheIds, feedbackCacheIds, revisionCacheIds };
}

// ── reverseModelKey ─────────────────────────────────

describe("reverseModelKey", () => {
  it("reverses simple openai model", () => {
    expect(reverseModelKey("openai_gpt-4o")).toBe("openai:gpt-4o");
  });

  it("reverses anthropic model", () => {
    expect(reverseModelKey("anthropic_claude-sonnet-4-20250514")).toBe(
      "anthropic:claude-sonnet-4-20250514"
    );
  });

  it("reverses google-vertex model", () => {
    expect(reverseModelKey("google-vertex_gemini-2.5-flash")).toBe(
      "google-vertex:gemini-2.5-flash"
    );
  });

  it("reverses google-vertex-anthropic model", () => {
    expect(
      reverseModelKey("google-vertex-anthropic_claude-opus-4-6@default")
    ).toBe("google-vertex-anthropic:claude-opus-4-6@default");
  });

  it("prefers longer provider prefix over shorter one", () => {
    // google-vertex-anthropic should match before google-vertex or google
    const result = reverseModelKey("google-vertex-anthropic_some-model");
    expect(result).toBe("google-vertex-anthropic:some-model");
  });

  it("reverses openrouter model (model name may have underscores)", () => {
    expect(reverseModelKey("openrouter_openai_gpt-oss-120b")).toBe(
      "openrouter:openai_gpt-oss-120b"
    );
  });

  it("reverses opencode model", () => {
    expect(reverseModelKey("opencode_kimi-k2")).toBe("opencode:kimi-k2");
  });

  it("reverses ollama model", () => {
    expect(reverseModelKey("ollama_gemma3")).toBe("ollama:gemma3");
  });

  it("reverses google model", () => {
    expect(reverseModelKey("google_gemini-pro")).toBe("google:gemini-pro");
  });

  it("returns null for unknown provider", () => {
    expect(reverseModelKey("unknown_model-x")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(reverseModelKey("")).toBeNull();
  });

  it("returns null for string with no underscore", () => {
    expect(reverseModelKey("openai")).toBeNull();
  });

  it("returns null for provider prefix with empty model part", () => {
    // "openai_" has an empty model part -- should skip
    expect(reverseModelKey("openai_")).toBeNull();
  });
});

// ── allPairs ────────────────────────────────────────

describe("allPairs", () => {
  it("returns empty for empty array", () => {
    expect(allPairs([])).toEqual([]);
  });

  it("returns empty for single item", () => {
    expect(allPairs(["a"])).toEqual([]);
  });

  it("returns one pair for two items", () => {
    expect(allPairs(["a", "b"])).toEqual([["a", "b"]]);
  });

  it("returns C(3,2)=3 pairs for three items", () => {
    const result = allPairs(["a", "b", "c"]);
    expect(result).toHaveLength(3);
    expect(result).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
  });

  it("returns C(4,2)=6 pairs for four items", () => {
    const result = allPairs([1, 2, 3, 4]);
    expect(result).toHaveLength(6);
  });

  it("preserves item identity", () => {
    const result = allPairs(["x", "y"]);
    expect(result[0][0]).toBe("x");
    expect(result[0][1]).toBe("y");
  });
});

// ── findMaximalCoverings ────────────────────────────

describe("findMaximalCoverings", () => {
  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("finds a covering for a fully cached 2×1 setup", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    const { writeCacheIds, feedbackCacheIds, revisionCacheIds } =
      await populateFullCache({
        cacheDir: TEST_CACHE_DIR,
        writers,
        judges: writers,
        prompts,
        N: 1,
      });

    const judgmentFileSets = await buildJudgmentFileSets(TEST_CACHE_DIR, writers);

    const writerKeys = writers.map((w) => modelKey(w.provider, w.model));
    const coverings = findMaximalCoverings(writerKeys, prompts, 1, {
      writeCacheIds,
      feedbackCacheIdMap: feedbackCacheIds,
      revisionCacheIdMap: revisionCacheIds,
      judgmentFileSets,
      candidateJudges: writerKeys,
      judgesFixed: false,
    });

    expect(coverings.length).toBeGreaterThanOrEqual(1);
    expect(coverings[0].writerKeys).toHaveLength(2);
    expect(coverings[0].promptIds).toEqual(["p1"]);
    expect(coverings[0].judgeKeys.sort()).toEqual(writerKeys.sort());
  });

  it("finds a covering for a fully cached 2×2 setup", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1"), makePrompt("p2")];

    const { writeCacheIds, feedbackCacheIds, revisionCacheIds } =
      await populateFullCache({
        cacheDir: TEST_CACHE_DIR,
        writers,
        judges: writers,
        prompts,
        N: 1,
      });

    const judgmentFileSets = await buildJudgmentFileSets(TEST_CACHE_DIR, writers);

    const writerKeys = writers.map((w) => modelKey(w.provider, w.model));
    const coverings = findMaximalCoverings(writerKeys, prompts, 1, {
      writeCacheIds,
      feedbackCacheIdMap: feedbackCacheIds,
      revisionCacheIdMap: revisionCacheIds,
      judgmentFileSets,
      candidateJudges: writerKeys,
      judgesFixed: false,
    });

    expect(coverings.length).toBeGreaterThanOrEqual(1);
    expect(coverings[0].writerKeys).toHaveLength(2);
    expect(coverings[0].promptIds.sort()).toEqual(["p1", "p2"]);
    expect(coverings[0].judgeKeys).toHaveLength(2);
  });

  it("returns empty when nothing is cached", () => {
    const coverings = findMaximalCoverings(["openai_gpt-4o", "anthropic_claude"], [makePrompt("p1")], 1, {
      writeCacheIds: new Map(),
      feedbackCacheIdMap: new Map(),
      revisionCacheIdMap: new Map(),
      judgmentFileSets: new Map(),
      candidateJudges: ["openai_gpt-4o", "anthropic_claude"],
      judgesFixed: false,
    });

    expect(coverings).toEqual([]);
  });

  it("returns empty when only 1 writer exists (need >=2 for pairs)", () => {
    const writeCacheIds = new Map<string, Map<string, string[]>>();
    writeCacheIds.set("openai_gpt-4o", new Map([["p1", ["w1"]]]));

    const coverings = findMaximalCoverings(["openai_gpt-4o"], [makePrompt("p1")], 1, {
      writeCacheIds,
      feedbackCacheIdMap: new Map(),
      revisionCacheIdMap: new Map(),
      judgmentFileSets: new Map(),
      candidateJudges: ["openai_gpt-4o"],
      judgesFixed: false,
    });

    expect(coverings).toEqual([]);
  });

  it("finds a subset covering when extra writers lack downstream stages", async () => {
    // 2 writers fully cached + 1 extra writer with only writes (no judgments)
    const fullWriters = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const extraWriter = { provider: "google", model: "gemini" };
    const prompts = [makePrompt("p1")];

    // Populate full cache for the 2 core writers
    const { writeCacheIds, feedbackCacheIds, revisionCacheIds } =
      await populateFullCache({
        cacheDir: TEST_CACHE_DIR,
        writers: fullWriters,
        judges: fullWriters,
        prompts,
        N: 1,
      });

    // Add writes-only for the extra writer (no downstream stages)
    const extraMk = modelKey(extraWriter.provider, extraWriter.model);
    const hash = hashPromptContent(prompts[0].prompt);
    await writeJson(
      join(TEST_CACHE_DIR, "writes", extraMk, hash, "sample_0.json"),
      { cacheId: "extra-w1", text: "extra", usage: { inputTokens: 1, outputTokens: 1 }, cost: { input: 0, output: 0, total: 0, totalUncached: 0 }, latencyMs: 0, createdAt: "" }
    );
    writeCacheIds.set(extraMk, new Map([["p1", ["extra-w1"]]]));

    const judgmentFileSets = await buildJudgmentFileSets(TEST_CACHE_DIR, [...fullWriters, extraWriter]);

    const allWriterKeys = [
      ...fullWriters.map((w) => modelKey(w.provider, w.model)),
      extraMk,
    ];

    const coverings = findMaximalCoverings(allWriterKeys, prompts, 1, {
      writeCacheIds,
      feedbackCacheIdMap: feedbackCacheIds,
      revisionCacheIdMap: revisionCacheIds,
      judgmentFileSets,
      candidateJudges: allWriterKeys,
      judgesFixed: false,
    });

    // Should find the 2-writer subset, not fail because of the extra writer
    expect(coverings.length).toBeGreaterThanOrEqual(1);
    const found = coverings[0];
    expect(found.writerKeys.sort()).toEqual(
      fullWriters.map((w) => modelKey(w.provider, w.model)).sort()
    );
    expect(found.promptIds).toEqual(["p1"]);
    // Should discover the 2 core writers as valid judges
    expect(found.judgeKeys.sort()).toEqual(
      fullWriters.map((w) => modelKey(w.provider, w.model)).sort()
    );
  });
});

// ── analyzeCacheStatus (integration) ────────────────

describe("analyzeCacheStatus", () => {
  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("returns empty result for empty cache directory", async () => {
    const result = await analyzeCacheStatus({
      prompts: [makePrompt("p1")],
      outputsPerModel: 1,
      cacheDir: TEST_CACHE_DIR,
    });

    expect(result.writerKeys).toEqual([]);
    expect(result.coverings).toEqual([]);
  });

  it("discovers writers from cache directories", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers,
      judges: writers,
      prompts,
      N: 1,
    });

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 1,
      cacheDir: TEST_CACHE_DIR,
    });

    expect(result.writerKeys.sort()).toEqual(
      ["anthropic_claude", "openai_gpt-4o"].sort()
    );
  });

  it("filters to specified writerKeys", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers,
      judges: writers,
      prompts,
      N: 1,
    });

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 1,
      writerKeys: ["openai_gpt-4o"],
      cacheDir: TEST_CACHE_DIR,
    });

    expect(result.writerKeys).toEqual(["openai_gpt-4o"]);
  });

  it("correctly reports write coverage", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1"), makePrompt("p2")];

    // Only populate writes for p1 (not full pipeline), and p2 for one writer
    const mk1 = modelKey("openai", "gpt-4o");
    const mk2 = modelKey("anthropic", "claude");
    const hash1 = hashPromptContent(prompts[0].prompt);
    const hash2 = hashPromptContent(prompts[1].prompt);

    // openai has writes for both p1 and p2
    await writeJson(
      join(TEST_CACHE_DIR, "writes", mk1, hash1, "sample_0.json"),
      { cacheId: "w1", text: "t", usage: { inputTokens: 1, outputTokens: 1 }, cost: { input: 0, output: 0, total: 0, totalUncached: 0 }, latencyMs: 0, createdAt: "" }
    );
    await writeJson(
      join(TEST_CACHE_DIR, "writes", mk1, hash2, "sample_0.json"),
      { cacheId: "w2", text: "t", usage: { inputTokens: 1, outputTokens: 1 }, cost: { input: 0, output: 0, total: 0, totalUncached: 0 }, latencyMs: 0, createdAt: "" }
    );

    // anthropic only has writes for p1
    await writeJson(
      join(TEST_CACHE_DIR, "writes", mk2, hash1, "sample_0.json"),
      { cacheId: "w3", text: "t", usage: { inputTokens: 1, outputTokens: 1 }, cost: { input: 0, output: 0, total: 0, totalUncached: 0 }, latencyMs: 0, createdAt: "" }
    );

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 1,
      cacheDir: TEST_CACHE_DIR,
    });

    // openai has writes for both prompts
    const openaiP1 = result.matrix.get(mk1)?.get("p1");
    const openaiP2 = result.matrix.get(mk1)?.get("p2");
    expect(openaiP1?.writes).toEqual({ have: 1, need: 1 });
    expect(openaiP2?.writes).toEqual({ have: 1, need: 1 });

    // anthropic has writes for p1 only
    const anthropicP1 = result.matrix.get(mk2)?.get("p1");
    const anthropicP2 = result.matrix.get(mk2)?.get("p2");
    expect(anthropicP1?.writes).toEqual({ have: 1, need: 1 });
    expect(anthropicP2?.writes).toEqual({ have: 0, need: 1 });
  });

  it("reports non-zero downstream need counts when writes are missing", async () => {
    const mk1 = modelKey("openai", "gpt-4o");
    const mk2 = modelKey("anthropic", "claude");
    const prompts = [makePrompt("p1")];
    const hash = hashPromptContent(prompts[0].prompt);

    // Only one writer has writes
    await writeJson(
      join(TEST_CACHE_DIR, "writes", mk1, hash, "sample_0.json"),
      { cacheId: "w1", text: "t", usage: { inputTokens: 1, outputTokens: 1 }, cost: { input: 0, output: 0, total: 0, totalUncached: 0 }, latencyMs: 0, createdAt: "" }
    );
    // Create empty writes dir for mk2 so it's discovered
    await mkdir(join(TEST_CACHE_DIR, "writes", mk2), { recursive: true });

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 1,
      cacheDir: TEST_CACHE_DIR,
    });

    // anthropic has no writes → downstream stages should show need > 0
    const cell = result.matrix.get(mk2)?.get("p1");
    expect(cell?.writes).toEqual({ have: 0, need: 1 });
    // Feedback need = N * W = 1 * 2 = 2 (each writer gives feedback on each sample)
    expect(cell?.feedback.need).toBe(2);
    expect(cell?.feedback.have).toBe(0);
    // Revisions need = N * W = 1 * 2 = 2
    expect(cell?.revisions.need).toBe(2);
    expect(cell?.revisions.have).toBe(0);
    // Cell should not be marked complete
    expect(cell?.complete).toBe(false);
  });

  it("finds covering for fully cached 2-writer setup", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers,
      judges: writers,
      prompts,
      N: 1,
    });

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 1,
      cacheDir: TEST_CACHE_DIR,
    });

    expect(result.coverings.length).toBeGreaterThanOrEqual(1);
    expect(result.coverings[0].writerKeys.sort()).toEqual(
      ["anthropic_claude", "openai_gpt-4o"].sort()
    );
    expect(result.coverings[0].promptIds).toEqual(["p1"]);
  });

  it("marks cells as complete when fully cached", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers,
      judges: writers,
      prompts,
      N: 1,
    });

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 1,
      cacheDir: TEST_CACHE_DIR,
    });

    for (const wk of result.writerKeys) {
      const cell = result.matrix.get(wk)?.get("p1");
      expect(cell?.complete).toBe(true);
    }
  });

  it("reports correct summary counts for fully cached setup", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers,
      judges: writers,
      prompts,
      N: 1,
    });

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 1,
      cacheDir: TEST_CACHE_DIR,
    });

    // W=2, P=1, N=1, J=2 (judges=writers)
    // Writes: 2*1*1 = 2
    expect(result.summary.writes).toEqual({ have: 2, need: 2 });

    // Initial judgments: C(2,2)=1 pair * 2 judges * 1 prompt = 2
    expect(result.summary.initialJudgments).toEqual({ have: 2, need: 2 });

    // Feedback: 2*2*1*1 = 4
    expect(result.summary.feedback).toEqual({ have: 4, need: 4 });

    // Revisions: 2*2*1*1 = 4
    expect(result.summary.revisions).toEqual({ have: 4, need: 4 });
  });

  it("handles N=2 outputs per model", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers,
      judges: writers,
      prompts,
      N: 2,
    });

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 2,
      cacheDir: TEST_CACHE_DIR,
    });

    // Writes: 2*1*2 = 4
    expect(result.summary.writes).toEqual({ have: 4, need: 4 });
    expect(result.coverings.length).toBeGreaterThanOrEqual(1);
  });

  it("supports separate judge models", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const judges = [{ provider: "openai", model: "gpt-4o" }]; // only one judge
    const prompts = [makePrompt("p1")];

    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers,
      judges,
      prompts,
      N: 1,
    });

    const result = await analyzeCacheStatus({
      prompts,
      outputsPerModel: 1,
      judgeKeys: judges.map((j) => modelKey(j.provider, j.model)),
      cacheDir: TEST_CACHE_DIR,
    });

    expect(result.judgesDefaultToWriters).toBe(false);
    expect(result.judgeKeys).toEqual(["openai_gpt-4o"]);
    // With only 1 judge, fewer judgment files needed
    expect(result.summary.initialJudgments.need).toBe(1); // C(2,2)=1 pair * 1 judge
  });
});

// ── formatCacheStatusTable ──────────────────────────

describe("formatCacheStatusTable", () => {
  it("includes header with config summary", () => {
    const result = makeMinimalResult();
    const output = formatCacheStatusTable(result);
    expect(output).toContain("Cache Status");
    expect(output).toContain("judges=writers");
  });

  it("includes write availability section", () => {
    const result = makeMinimalResult();
    const output = formatCacheStatusTable(result);
    expect(output).toContain("Write Availability");
    expect(output).toContain("N=1");
  });

  it("includes summary section", () => {
    const result = makeMinimalResult();
    const output = formatCacheStatusTable(result);
    expect(output).toContain("Summary");
    expect(output).toContain("Total cached:");
  });

  it("shows covering when found", () => {
    const result = makeMinimalResult();
    result.coverings = [
      { writerKeys: ["openai_gpt-4o", "anthropic_claude"], promptIds: ["p1"], judgeKeys: ["openai_gpt-4o"], outputsPerModel: 1 },
    ];
    const output = formatCacheStatusTable(result);
    expect(output).toContain("Fully Cached Runs");
    expect(output).toContain("2 writers");
    expect(output).toContain("1 prompts");
    expect(output).toContain("1 judges");
    expect(output).toContain("(N=1)");
    expect(output).toContain("Judges:");
  });

  it("shows 'no fully cached runs' when none found", () => {
    const result = makeMinimalResult();
    result.coverings = [];
    const output = formatCacheStatusTable(result);
    expect(output).toContain("No fully cached runs found");
  });

  it("shows write counts per N level in availability table", () => {
    const result = makeMinimalResult();
    // maxWrites=1 means 1/1 at N=1 and · at N=2, N=3
    result.outputsPerModel = 3; // maxN=3 so 3 columns
    const output = formatCacheStatusTable(result);
    expect(output).toContain("N=1");
    expect(output).toContain("N=2");
    expect(output).toContain("N=3");
    expect(output).toContain("1/1"); // both writers have 1 write for 1 prompt
  });
});

// ── formatCacheStatusJson ───────────────────────────

describe("formatCacheStatusJson", () => {
  it("produces valid JSON", () => {
    const result = makeMinimalResult();
    const output = formatCacheStatusJson(result);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("includes config section", () => {
    const result = makeMinimalResult();
    const parsed = JSON.parse(formatCacheStatusJson(result));
    expect(parsed.config).toBeDefined();
    expect(parsed.config.outputsPerModel).toBe(1);
    expect(parsed.config.judgesDefaultToWriters).toBe(true);
  });

  it("includes matrix with per-stage counts", () => {
    const result = makeMinimalResult();
    const parsed = JSON.parse(formatCacheStatusJson(result));
    expect(parsed.matrix).toBeDefined();
    const firstWriter = Object.keys(parsed.matrix)[0];
    const firstPrompt = Object.keys(parsed.matrix[firstWriter])[0];
    const cell = parsed.matrix[firstWriter][firstPrompt];
    expect(cell.writes).toBeDefined();
    expect(cell.writes.have).toBeDefined();
    expect(cell.writes.need).toBeDefined();
    expect(cell.complete).toBeDefined();
  });

  it("includes coverings with display names and judges", () => {
    const result = makeMinimalResult();
    result.coverings = [
      { writerKeys: ["openai_gpt-4o", "anthropic_claude"], promptIds: ["p1"], judgeKeys: ["openai_gpt-4o"], outputsPerModel: 1 },
    ];
    const parsed = JSON.parse(formatCacheStatusJson(result));
    expect(parsed.coverings).toHaveLength(1);
    expect(parsed.coverings[0].writers).toContain("openai:gpt-4o");
    expect(parsed.coverings[0].judges).toContain("openai:gpt-4o");
    expect(parsed.coverings[0].outputsPerModel).toBe(1);
    expect(parsed.coverings[0].cells).toBe(2);
  });

  it("includes summary", () => {
    const result = makeMinimalResult();
    const parsed = JSON.parse(formatCacheStatusJson(result));
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.writes).toBeDefined();
    expect(parsed.summary.initialJudgments).toBeDefined();
  });

  it("includes diskSize in JSON output", () => {
    const result = makeMinimalResult();
    const parsed = JSON.parse(formatCacheStatusJson(result));
    expect(parsed.diskSize).toBeDefined();
    expect(parsed.diskSize.total).toBe(2560);
    expect(parsed.diskSize.writes).toBe(1024);
    expect(parsed.diskSize.feedback).toBe(512);
    expect(parsed.diskSize.revisions).toBe(768);
    expect(parsed.diskSize.judgments).toBe(256);
  });
});

// ── formatBytes ─────────────────────────────────────

describe("formatBytes", () => {
  it("returns '0 B' for zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes below 1 KB", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(15 * 1024)).toBe("15 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatBytes(42 * 1024 * 1024)).toBe("42 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(2.3 * 1024 * 1024 * 1024)).toBe("2.3 GB");
  });
});

// ── computeCacheDiskSize ────────────────────────────

describe("computeCacheDiskSize", () => {
  const DISK_TEST_DIR = join(process.cwd(), "data", "test-cache-disk-size");

  beforeEach(async () => {
    if (existsSync(DISK_TEST_DIR)) {
      await rm(DISK_TEST_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(DISK_TEST_DIR)) {
      await rm(DISK_TEST_DIR, { recursive: true });
    }
  });

  it("returns all zeros for nonexistent directory", async () => {
    const sizes = await computeCacheDiskSize(DISK_TEST_DIR);
    expect(sizes.total).toBe(0);
    expect(sizes.writes).toBe(0);
    expect(sizes.feedback).toBe(0);
    expect(sizes.revisions).toBe(0);
    expect(sizes.judgments).toBe(0);
  });

  it("sums file sizes per category", async () => {
    // Create files in each category
    const content = JSON.stringify({ text: "hello world", cacheId: "x1" });
    await writeJson(join(DISK_TEST_DIR, "writes", "model_a", "hash1", "sample_0.json"), { text: "hello" });
    await writeJson(join(DISK_TEST_DIR, "feedback", "model_a", "fb1.json"), { text: "feedback" });
    await writeJson(join(DISK_TEST_DIR, "revisions", "model_a", "rev1.json"), { text: "revision" });
    await writeJson(join(DISK_TEST_DIR, "judgments", "model_a", "j1.json"), { text: "judgment" });

    const sizes = await computeCacheDiskSize(DISK_TEST_DIR);
    expect(sizes.writes).toBeGreaterThan(0);
    expect(sizes.feedback).toBeGreaterThan(0);
    expect(sizes.revisions).toBeGreaterThan(0);
    expect(sizes.judgments).toBeGreaterThan(0);
    expect(sizes.total).toBe(sizes.writes + sizes.feedback + sizes.revisions + sizes.judgments);
  });

  it("handles empty category directories", async () => {
    await mkdir(join(DISK_TEST_DIR, "writes"), { recursive: true });
    await mkdir(join(DISK_TEST_DIR, "judgments"), { recursive: true });

    const sizes = await computeCacheDiskSize(DISK_TEST_DIR);
    expect(sizes.total).toBe(0);
  });
});

// ── disk size in formatCacheStatusTable ──────────────

describe("formatCacheStatusTable disk size", () => {
  it("includes disk usage line with total and per-category sizes", () => {
    const result = makeMinimalResult();
    result.diskSize = {
      writes: 5 * 1024 * 1024,
      feedback: 1024 * 1024,
      revisions: 2 * 1024 * 1024,
      judgments: 512 * 1024,
      total: 5 * 1024 * 1024 + 1024 * 1024 + 2 * 1024 * 1024 + 512 * 1024,
    };
    const output = formatCacheStatusTable(result);
    expect(output).toContain("Disk usage:");
    expect(output).toContain("writes:");
    expect(output).toContain("feedback:");
    expect(output).toContain("revisions:");
    expect(output).toContain("judgments:");
  });

  it("shows 0 B when cache is empty", () => {
    const result = makeMinimalResult();
    result.diskSize = { writes: 0, feedback: 0, revisions: 0, judgments: 0, total: 0 };
    const output = formatCacheStatusTable(result);
    expect(output).toContain("Disk usage: 0 B");
  });
});

// ── filterDominated ─────────────────────────────────

describe("filterDominated", () => {
  it("removes a covering dominated in all dimensions", () => {
    const coverings: Covering[] = [
      { writerKeys: ["a", "b", "c"], promptIds: ["p1", "p2"], judgeKeys: ["j1"], outputsPerModel: 2 },
      { writerKeys: ["a", "b"], promptIds: ["p1"], judgeKeys: ["j1"], outputsPerModel: 1 },
    ];
    const result = filterDominated(coverings);
    expect(result).toHaveLength(1);
    expect(result[0].writerKeys).toEqual(["a", "b", "c"]);
  });

  it("removes a covering dominated only by subset inclusion", () => {
    const coverings: Covering[] = [
      { writerKeys: ["a", "b", "c"], promptIds: ["p1", "p2"], judgeKeys: ["j1"], outputsPerModel: 1 },
      { writerKeys: ["a", "b"], promptIds: ["p1", "p2"], judgeKeys: ["j1"], outputsPerModel: 1 },
    ];
    const result = filterDominated(coverings);
    expect(result).toHaveLength(1);
    expect(result[0].writerKeys).toEqual(["a", "b", "c"]);
  });

  it("preserves non-dominated coverings that trade off writers for prompts", () => {
    const coverings: Covering[] = [
      { writerKeys: ["a", "b", "c"], promptIds: ["p1", "p2"], judgeKeys: ["j1"], outputsPerModel: 1 },
      { writerKeys: ["a", "b"], promptIds: ["p1", "p2", "p3"], judgeKeys: ["j1"], outputsPerModel: 1 },
    ];
    const result = filterDominated(coverings);
    expect(result).toHaveLength(2);
  });

  it("preserves non-dominated coverings that trade off N for writers", () => {
    const coverings: Covering[] = [
      { writerKeys: ["a", "b"], promptIds: ["p1", "p2"], judgeKeys: ["j1"], outputsPerModel: 2 },
      { writerKeys: ["a", "b", "c"], promptIds: ["p1", "p2"], judgeKeys: ["j1"], outputsPerModel: 1 },
    ];
    const result = filterDominated(coverings);
    // Neither dominates: first has higher N but fewer writers
    expect(result).toHaveLength(2);
  });

  it("removes covering dominated by higher N with same sets", () => {
    const coverings: Covering[] = [
      { writerKeys: ["a", "b"], promptIds: ["p1"], judgeKeys: ["j1"], outputsPerModel: 2 },
      { writerKeys: ["a", "b"], promptIds: ["p1"], judgeKeys: ["j1"], outputsPerModel: 1 },
    ];
    const result = filterDominated(coverings);
    expect(result).toHaveLength(1);
    expect(result[0].outputsPerModel).toBe(2);
  });

  it("returns empty for empty input", () => {
    expect(filterDominated([])).toEqual([]);
  });

  it("preserves single covering", () => {
    const coverings: Covering[] = [
      { writerKeys: ["a", "b"], promptIds: ["p1"], judgeKeys: ["j1"], outputsPerModel: 1 },
    ];
    const result = filterDominated(coverings);
    expect(result).toHaveLength(1);
  });

  it("preserves three mutually non-dominated coverings", () => {
    const coverings: Covering[] = [
      { writerKeys: ["a", "b", "c"], promptIds: ["p1"], judgeKeys: ["j1"], outputsPerModel: 1 },
      { writerKeys: ["a", "b"], promptIds: ["p1", "p2"], judgeKeys: ["j1"], outputsPerModel: 1 },
      { writerKeys: ["a", "b"], promptIds: ["p1"], judgeKeys: ["j1", "j2"], outputsPerModel: 1 },
    ];
    const result = filterDominated(coverings);
    expect(result).toHaveLength(3);
  });
});

// ── vary-N covering search ──────────────────────────

describe("findMaximalCoverings with vary-N", () => {
  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("finds N=2 covering and filters out dominated N=1", async () => {
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    const { writeCacheIds, feedbackCacheIds, revisionCacheIds } =
      await populateFullCache({
        cacheDir: TEST_CACHE_DIR,
        writers,
        judges: writers,
        prompts,
        N: 2,
      });

    const judgmentFileSets = await buildJudgmentFileSets(TEST_CACHE_DIR, writers);

    const writerKeys = writers.map((w) => modelKey(w.provider, w.model));
    const coverings = findMaximalCoverings(writerKeys, prompts, 2, {
      writeCacheIds,
      feedbackCacheIdMap: feedbackCacheIds,
      revisionCacheIdMap: revisionCacheIds,
      judgmentFileSets,
      candidateJudges: writerKeys,
      judgesFixed: false,
    });

    // N=2 covering should exist
    const n2 = coverings.filter((c) => c.outputsPerModel === 2);
    expect(n2.length).toBe(1);

    // N=1 with same writers/prompts should be filtered as dominated
    const n1 = coverings.filter((c) => c.outputsPerModel === 1);
    expect(n1.length).toBe(0);
  });

  it("finds non-dominated coverings at different N levels", async () => {
    // Writers A,B fully cached at N=2; writer C only has 1 write (cached at N=1)
    const coreWriters = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const extraWriter = { provider: "google", model: "gemini" };
    const prompts = [makePrompt("p1")];

    // Populate full pipeline for {A,B,C} at N=1
    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers: [...coreWriters, extraWriter],
      judges: [...coreWriters, extraWriter],
      prompts,
      N: 1,
    });

    // Populate full pipeline for {A,B} at N=2 (adds second write + downstream)
    const { writeCacheIds, feedbackCacheIds, revisionCacheIds } =
      await populateFullCache({
        cacheDir: TEST_CACHE_DIR,
        writers: coreWriters,
        judges: coreWriters,
        prompts,
        N: 2,
      });

    // Also include C's write cacheIds from the N=1 cache
    const extraMk = modelKey(extraWriter.provider, extraWriter.model);
    const hash = hashPromptContent(prompts[0].prompt);
    // Read C's writes
    const cWriteDir = join(TEST_CACHE_DIR, "writes", extraMk, hash);
    const cWriteFiles = (await readdir(cWriteDir).catch(() => [])).filter(
      (f: string) => f.endsWith(".json")
    ).sort();
    const cWriteIds: string[] = [];
    for (const f of cWriteFiles) {
      const entry = JSON.parse(
        await readFile(join(cWriteDir, f), "utf-8")
      );
      if (entry?.cacheId) cWriteIds.push(entry.cacheId);
    }
    writeCacheIds.set(extraMk, new Map([["p1", cWriteIds]]));

    const judgmentFileSets = await buildJudgmentFileSets(TEST_CACHE_DIR, [...coreWriters, extraWriter]);

    // Rebuild feedback/revision maps from disk
    const allMks = [...coreWriters, extraWriter].map((w) =>
      modelKey(w.provider, w.model)
    );
    for (const mk of allMks) {
      const fbDir = join(TEST_CACHE_DIR, "feedback", mk);
      const fbFiles = (await readdir(fbDir).catch(() => [])).filter(
        (f: string) => f.endsWith(".json")
      );
      for (const f of fbFiles) {
        const entry = JSON.parse(
          await readFile(join(fbDir, f), "utf-8")
        );
        if (entry?.cacheId) {
          const wCid = f.replace(".json", "");
          feedbackCacheIds.set(`${mk}:${wCid}`, entry.cacheId);
        }
      }

      const revDir = join(TEST_CACHE_DIR, "revisions", mk);
      const revFiles = (await readdir(revDir).catch(() => [])).filter(
        (f: string) => f.endsWith(".json")
      );
      for (const f of revFiles) {
        const entry = JSON.parse(
          await readFile(join(revDir, f), "utf-8")
        );
        if (entry?.cacheId) {
          const fbCid = f.replace(".json", "");
          revisionCacheIds.set(`${mk}:${fbCid}`, entry.cacheId);
        }
      }
    }

    const allWriterKeys = allMks;
    const coverings = findMaximalCoverings(allWriterKeys, prompts, 2, {
      writeCacheIds,
      feedbackCacheIdMap: feedbackCacheIds,
      revisionCacheIdMap: revisionCacheIds,
      judgmentFileSets,
      candidateJudges: allWriterKeys,
      judgesFixed: false,
    });

    // Should have at least two non-dominated coverings:
    // - {A,B} × p1 at N=2 (higher N but fewer writers)
    // - {A,B,C} × p1 at N=1 (more writers but lower N)
    const n2 = coverings.filter((c) => c.outputsPerModel === 2);
    const n1 = coverings.filter((c) => c.outputsPerModel === 1);

    expect(n2.length).toBeGreaterThanOrEqual(1);
    expect(n1.length).toBeGreaterThanOrEqual(1);

    // The N=2 covering should have 2 writers (A,B)
    expect(n2[0].writerKeys.sort()).toEqual(
      coreWriters.map((w) => modelKey(w.provider, w.model)).sort()
    );

    // The N=1 covering should have 3 writers (A,B,C)
    expect(n1[0].writerKeys.sort()).toEqual(allWriterKeys.sort());
  });
});

// ── overlapping coverings ───────────────────────────

describe("findMaximalCoverings with overlapping coverings", () => {
  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("finds overlapping coverings trading writers for prompts", async () => {
    // Setup: {A,B} fully cached for {p1,p2,p3}; {A,B,C} fully cached for {p1} only
    // Expected: covering1 = A,B × p1,p2,p3 (more prompts); covering2 = A,B,C × p1 (more writers)
    const coreWriters = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const extraWriter = { provider: "google", model: "gemini" };
    const allWriters = [...coreWriters, extraWriter];
    const allPrompts = [makePrompt("p1"), makePrompt("p2"), makePrompt("p3")];

    // Populate full pipeline for {A,B} across all 3 prompts
    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers: coreWriters,
      judges: coreWriters,
      prompts: allPrompts,
      N: 1,
    });

    // Populate full pipeline for {A,B,C} on p1 only
    await populateFullCache({
      cacheDir: TEST_CACHE_DIR,
      writers: allWriters,
      judges: allWriters,
      prompts: [allPrompts[0]], // p1 only
      N: 1,
    });

    // Build data structures from disk
    const writeCacheIds = new Map<string, Map<string, string[]>>();
    const feedbackCacheIds = new Map<string, string>();
    const revisionCacheIds = new Map<string, string>();
    const judgmentFileSets = new Map<string, Set<string>>();

    const allMks = allWriters.map((w) => modelKey(w.provider, w.model));

    for (const mk of allMks) {
      // Writes
      const byPrompt = new Map<string, string[]>();
      for (const p of allPrompts) {
        const hash = hashPromptContent(p.prompt);
        const dir = join(TEST_CACHE_DIR, "writes", mk, hash);
        const files = (await readdir(dir).catch(() => []))
          .filter((f: string) => f.endsWith(".json"))
          .sort();
        const ids: string[] = [];
        for (const f of files) {
          const entry = JSON.parse(await readFile(join(dir, f), "utf-8"));
          if (entry?.cacheId) ids.push(entry.cacheId);
        }
        byPrompt.set(p.id, ids);
      }
      writeCacheIds.set(mk, byPrompt);

      // Feedback
      const fbDir = join(TEST_CACHE_DIR, "feedback", mk);
      const fbFiles = (await readdir(fbDir).catch(() => []))
        .filter((f: string) => f.endsWith(".json"));
      for (const f of fbFiles) {
        const entry = JSON.parse(await readFile(join(fbDir, f), "utf-8"));
        if (entry?.cacheId) {
          feedbackCacheIds.set(`${mk}:${f.replace(".json", "")}`, entry.cacheId);
        }
      }

      // Revisions
      const revDir = join(TEST_CACHE_DIR, "revisions", mk);
      const revFiles = (await readdir(revDir).catch(() => []))
        .filter((f: string) => f.endsWith(".json"));
      for (const f of revFiles) {
        const entry = JSON.parse(await readFile(join(revDir, f), "utf-8"));
        if (entry?.cacheId) {
          revisionCacheIds.set(`${mk}:${f.replace(".json", "")}`, entry.cacheId);
        }
      }

      // Judgments
      const jDir = join(TEST_CACHE_DIR, "judgments", mk);
      const jFiles = await readdir(jDir).catch(() => []);
      judgmentFileSets.set(mk, new Set(jFiles));
    }

    const coverings = findMaximalCoverings(allMks, allPrompts, 1, {
      writeCacheIds,
      feedbackCacheIdMap: feedbackCacheIds,
      revisionCacheIdMap: revisionCacheIds,
      judgmentFileSets,
      candidateJudges: allMks,
      judgesFixed: false,
    });

    // Should find two non-dominated coverings:
    // 1. {A,B} × {p1,p2,p3} -- more prompts
    // 2. {A,B,C} × {p1} -- more writers
    expect(coverings.length).toBeGreaterThanOrEqual(2);

    const coreMks = coreWriters.map((w) => modelKey(w.provider, w.model)).sort();

    const morePrompts = coverings.find(
      (c) =>
        c.promptIds.length === 3 &&
        c.writerKeys.length === 2 &&
        [...c.writerKeys].sort().join(",") === coreMks.join(",")
    );
    expect(morePrompts).toBeDefined();

    const moreWriters = coverings.find(
      (c) =>
        c.writerKeys.length === 3 &&
        c.promptIds.length === 1 &&
        c.promptIds[0] === "p1"
    );
    expect(moreWriters).toBeDefined();
  });

  it("deduplicates identical coverings from different seeds", async () => {
    // With a small fully-cached setup, multiple seeds find the same covering
    const writers = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude" },
    ];
    const prompts = [makePrompt("p1")];

    const { writeCacheIds, feedbackCacheIds, revisionCacheIds } =
      await populateFullCache({
        cacheDir: TEST_CACHE_DIR,
        writers,
        judges: writers,
        prompts,
        N: 1,
      });

    const judgmentFileSets = await buildJudgmentFileSets(TEST_CACHE_DIR, writers);

    const writerKeys = writers.map((w) => modelKey(w.provider, w.model));
    const coverings = findMaximalCoverings(writerKeys, prompts, 1, {
      writeCacheIds,
      feedbackCacheIdMap: feedbackCacheIds,
      revisionCacheIdMap: revisionCacheIds,
      judgmentFileSets,
      candidateJudges: writerKeys,
      judgesFixed: false,
    });

    // Should have exactly 1 covering (deduped despite multiple seeds finding same result)
    expect(coverings).toHaveLength(1);
    expect(coverings[0].writerKeys.sort()).toEqual(writerKeys.sort());
    expect(coverings[0].outputsPerModel).toBe(1);
  });
});

// ── Test helpers ────────────────────────────────────

type WriterSpec = { provider: string; model: string };

async function buildJudgmentFileSets(
  cacheDir: string,
  writers: WriterSpec[]
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  for (const w of writers) {
    const mk = modelKey(w.provider, w.model);
    const dir = join(cacheDir, "judgments", mk);
    const files = await readdir(dir).catch(() => []);
    result.set(mk, new Set(files));
  }
  return result;
}

function makeMinimalResult(): CacheStatusResult {
  const matrix = new Map<string, Map<string, any>>();
  const cell = {
    writes: { have: 1, need: 1 },
    maxWrites: 1,
    writeCacheIds: ["w1"],
    initialJudgments: { have: 2, need: 2 },
    feedback: { have: 4, need: 4 },
    revisions: { have: 4, need: 4 },
    improvementJudgments: { have: 4, need: 4 },
    revisedJudgments: { have: 2, need: 2 },
    complete: true,
  };

  const writerMap1 = new Map();
  writerMap1.set("p1", { ...cell });
  const writerMap2 = new Map();
  writerMap2.set("p1", { ...cell });

  matrix.set("openai_gpt-4o", writerMap1);
  matrix.set("anthropic_claude", writerMap2);

  return {
    outputsPerModel: 1,
    writerKeys: ["openai_gpt-4o", "anthropic_claude"],
    judgeKeys: ["openai_gpt-4o", "anthropic_claude"],
    judgesDefaultToWriters: true,
    prompts: [makePrompt("p1")],
    matrix,
    coverings: [],
    summary: {
      writes: { have: 2, need: 2 },
      initialJudgments: { have: 2, need: 2 },
      feedback: { have: 4, need: 4 },
      revisions: { have: 4, need: 4 },
      improvementJudgments: { have: 4, need: 4 },
      revisedJudgments: { have: 2, need: 2 },
    },
    diskSize: { writes: 1024, feedback: 512, revisions: 768, judgments: 256, total: 2560 },
  };
}
