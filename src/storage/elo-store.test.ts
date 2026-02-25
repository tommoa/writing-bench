import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { rm, mkdir, writeFile, readFile } from "fs/promises";
import { join, dirname } from "path";
import { updateCumulativeElo, loadCumulativeElo, judgmentStableKey } from "./elo-store.js";
import type {
  RunResult,
  WritingSample,
  PairwiseJudgment,
  EloRating,
  CumulativeElo,
} from "../types.js";
import { DEFAULT_CONVERGENCE, DEFAULT_CONCURRENCY } from "../types.js";

const ELO_FILE = join(process.cwd(), "data", "elo.json");

function makeSample(
  id: string,
  model: string,
  promptId: string,
  stage: "initial" | "revised" = "initial",
  feedbackModel?: string,
  outputIndex: number = 0,
  opts?: { registryId?: string; feedbackRegistryId?: string }
): WritingSample {
  return {
    id,
    model,
    registryId: opts?.registryId,
    promptId,
    outputIndex,
    text: "test",
    stage,
    feedbackModel,
    feedbackRegistryId: opts?.feedbackRegistryId,
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: { input: 0, output: 0, total: 0, totalUncached: 0 },
    latencyMs: 0,
  };
}

function makeJudgment(
  id: string,
  promptId: string,
  sampleA: string,
  sampleB: string,
  winner: "A" | "B" | "tie",
  stage: "initial" | "revised" | "improvement" = "initial"
): PairwiseJudgment {
  return {
    id,
    judgeModel: "judge",
    promptId,
    sampleA,
    sampleB,
    winner,
    reasoning: "test",
    stage,
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: { input: 0, output: 0, total: 0, totalUncached: 0 },
    latencyMs: 0,
  };
}

function makeRunResult(opts: {
  samples: WritingSample[];
  judgments: PairwiseJudgment[];
  prompts: Array<{ id: string; tags: string[] }>;
  models?: Array<{ provider: string; model: string; label: string; registryId: string }>;
}): RunResult {
  return {
    config: {
      id: "test-run",
      models: (opts.models ?? [
        { provider: "openai", model: "gpt-4o", label: "modelA", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "claude-sonnet-4-20250514", label: "modelB", registryId: "anthropic:claude-sonnet-4-20250514" },
      ]) as any,
      prompts: opts.prompts.map((p) => ({
        id: p.id,
        name: p.id,
        tags: p.tags,
        description: "test",
        prompt: "test",
        judgingCriteria: ["quality"],
      })),
      outputsPerModel: 1,
      reasoning: true,
      noCache: false,
      cacheOnly: false,
      skipSeeding: false,
      concurrency: DEFAULT_CONCURRENCY,
      convergence: DEFAULT_CONVERGENCE,
      timestamp: new Date().toISOString(),
    },
    samples: opts.samples,
    feedback: [],
    judgments: opts.judgments,
    elo: {
      initial: { stage: "initial", ratings: [] },
      revised: { stage: "revised", ratings: [] },
    },
    meta: {
      totalTokens: 0,
      totalCost: 0,
      totalCostUncached: 0,
      costByModel: {},
      costByStage: {},
      costByModelByStage: {},
      speedByModel: {},
      durationMs: 0,
      terminationReason: "converged" as const,
      converged: true,
      roundsCompleted: 0,
    },
    modelInfo: {},
  };
}

describe("updateCumulativeElo - feedback ELO", () => {
  let originalEloContent: string | null = null;

  beforeEach(async () => {
    if (existsSync(ELO_FILE)) {
      originalEloContent = await readFile(ELO_FILE, "utf-8");
    }
    const dir = dirname(ELO_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    if (existsSync(ELO_FILE)) {
      await rm(ELO_FILE);
    }
  });

  afterEach(async () => {
    if (originalEloContent !== null) {
      await writeFile(ELO_FILE, originalEloContent);
    } else if (existsSync(ELO_FILE)) {
      await rm(ELO_FILE);
    }
  });

  it("updates feedbackGiving from improvement judgments", async () => {
    // Writer modelA gets feedback from feedbackX and feedbackY on the same original.
    // feedbackX's revision wins (B beats original), feedbackY's loses.
    const run = makeRunResult({
      samples: [
        makeSample("origA", "modelA", "sermon"),
        makeSample("revA", "modelA", "sermon", "revised", "feedbackX"),
        makeSample("revB", "modelA", "sermon", "revised", "feedbackY"),
      ],
      judgments: [
        // feedbackX led to a better revision (revision beat original)
        makeJudgment("j1", "sermon", "origA", "revA", "B", "improvement"),
        // feedbackY did not help (original beat revision)
        makeJudgment("j2", "sermon", "origA", "revB", "A", "improvement"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });

    const elo = await updateCumulativeElo(run);

    expect(elo.feedbackGiving["feedbackX"]).toBeDefined();
    expect(elo.feedbackGiving["feedbackY"]).toBeDefined();
    expect(elo.feedbackGiving["feedbackX"].rating).toBeGreaterThan(
      elo.feedbackGiving["feedbackY"].rating
    );
    expect(elo.feedbackGiving["feedbackX"].matchCount).toBe(1);
  });

  it("does NOT use revised judgments for feedback ELO", async () => {
    // Revised judgments compare writers (same feedback provider) -- should not affect feedback ELO.
    const run = makeRunResult({
      samples: [
        makeSample("origA", "modelA", "sermon"),
        makeSample("origB", "modelB", "sermon"),
        makeSample("revA", "modelA", "sermon", "revised", "feedbackX"),
        makeSample("revB", "modelB", "sermon", "revised", "feedbackX"),
      ],
      judgments: [
        // Revised judgment: same feedback provider for both → no feedback competition
        makeJudgment("j1", "sermon", "revA", "revB", "A", "revised"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });

    const elo = await updateCumulativeElo(run);

    // feedbackX should exist but have no matches
    // (revised judgments with same feedback model produce no pairings)
    if (elo.feedbackGiving["feedbackX"]) {
      expect(elo.feedbackGiving["feedbackX"].matchCount).toBe(0);
    }
  });

  it("accumulates feedback ELO across runs", async () => {
    const run1 = makeRunResult({
      samples: [
        makeSample("o1", "modelA", "sermon"),
        makeSample("r1a", "modelA", "sermon", "revised", "feedbackX"),
        makeSample("r1b", "modelA", "sermon", "revised", "feedbackY"),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "o1", "r1a", "B", "improvement"),
        makeJudgment("j2", "sermon", "o1", "r1b", "A", "improvement"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    await updateCumulativeElo(run1);

    const run2 = makeRunResult({
      samples: [
        makeSample("o2", "modelA", "essay"),
        makeSample("r2a", "modelA", "essay", "revised", "feedbackX"),
        makeSample("r2b", "modelA", "essay", "revised", "feedbackY"),
      ],
      judgments: [
        // feedbackY wins this time
        makeJudgment("j3", "essay", "o2", "r2a", "A", "improvement"),
        makeJudgment("j4", "essay", "o2", "r2b", "B", "improvement"),
      ],
      prompts: [{ id: "essay", tags: ["essay"] }],
    });
    const elo = await updateCumulativeElo(run2);

    // 1 win each → ratings should be close to 1500
    const x = elo.feedbackGiving["feedbackX"];
    const y = elo.feedbackGiving["feedbackY"];
    expect(x.matchCount).toBe(2);
    expect(y.matchCount).toBe(2);
    expect(Math.abs(x.rating - y.rating)).toBeLessThan(10);
  });
});

describe("updateCumulativeElo - per-category", () => {
  let originalEloContent: string | null = null;

  beforeEach(async () => {
    // Save existing elo.json if it exists
    if (existsSync(ELO_FILE)) {
      originalEloContent = await readFile(ELO_FILE, "utf-8");
    }
    // Clear it for tests
    const dir = dirname(ELO_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    if (existsSync(ELO_FILE)) {
      await rm(ELO_FILE);
    }
  });

  afterEach(async () => {
    // Restore original elo.json
    if (originalEloContent !== null) {
      await writeFile(ELO_FILE, originalEloContent);
    } else if (existsSync(ELO_FILE)) {
      await rm(ELO_FILE);
    }
  });

  it("creates writingByTag entries for each category", async () => {
    const run = makeRunResult({
      samples: [
        makeSample("sa1", "modelA", "sermon"),
        makeSample("sb1", "modelB", "sermon"),
        makeSample("ea1", "modelA", "essay"),
        makeSample("eb1", "modelB", "essay"),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "sa1", "sb1", "A"),
        makeJudgment("j2", "essay", "ea1", "eb1", "B"),
      ],
      prompts: [
        { id: "sermon", tags: ["sermon"] },
        { id: "essay", tags: ["essay"] },
      ],
    });

    const elo = await updateCumulativeElo(run);

    expect(elo.writingByTag).toBeDefined();
    expect(elo.writingByTag["sermon"]).toBeDefined();
    expect(elo.writingByTag["essay"]).toBeDefined();

    // modelA should lead in sermons
    const sermonA = elo.writingByTag["sermon"]["modelA"];
    const sermonB = elo.writingByTag["sermon"]["modelB"];
    expect(sermonA.rating).toBeGreaterThan(sermonB.rating);

    // modelB should lead in essays
    const essayA = elo.writingByTag["essay"]["modelA"];
    const essayB = elo.writingByTag["essay"]["modelB"];
    expect(essayB.rating).toBeGreaterThan(essayA.rating);
  });

  it("accumulates across multiple runs", async () => {
    // Run 1: modelA wins sermon (output index 0)
    const run1 = makeRunResult({
      samples: [
        makeSample("s1a", "modelA", "sermon"),
        makeSample("s1b", "modelB", "sermon"),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1a", "s1b", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    await updateCumulativeElo(run1);

    // Run 2: modelB wins sermon (output index 1 -- distinct samples)
    const run2 = makeRunResult({
      samples: [
        makeSample("s2a", "modelA", "sermon", "initial", undefined, 1),
        makeSample("s2b", "modelB", "sermon", "initial", undefined, 1),
      ],
      judgments: [
        makeJudgment("j2", "sermon", "s2a", "s2b", "B"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    const elo = await updateCumulativeElo(run2);

    // After 1 win each, ratings should be close to 1500
    const sermonA = elo.writingByTag["sermon"]["modelA"];
    const sermonB = elo.writingByTag["sermon"]["modelB"];
    expect(Math.abs(sermonA.rating - sermonB.rating)).toBeLessThan(10);
    expect(sermonA.matchCount).toBe(2);
    expect(sermonB.matchCount).toBe(2);
  });

  it("excludes improvement judgments from category ELO", async () => {
    const run = makeRunResult({
      samples: [
        makeSample("s1", "modelA", "sermon"),
        makeSample("s2", "modelB", "sermon"),
      ],
      judgments: [
        // Only improvement judgments -- should NOT affect category ELO
        makeJudgment("j1", "sermon", "s1", "s2", "A", "improvement"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    const elo = await updateCumulativeElo(run);

    const sermonA = elo.writingByTag["sermon"]["modelA"];
    const sermonB = elo.writingByTag["sermon"]["modelB"];
    // No matches processed since improvement judgments are excluded
    expect(sermonA.matchCount).toBe(0);
    expect(sermonB.matchCount).toBe(0);
    expect(sermonA.rating).toBe(1500);
  });

  it("initializes writingByTag on old elo.json without it", async () => {
    // Write an old-format elo.json without writingByTag
    const oldElo = {
      lastUpdated: new Date().toISOString(),
      writing: {},
      feedbackGiving: {},
      history: [],
    };
    await writeFile(ELO_FILE, JSON.stringify(oldElo));

    const run = makeRunResult({
      samples: [
        makeSample("s1", "modelA", "sermon"),
        makeSample("s2", "modelB", "sermon"),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1", "s2", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });

    const elo = await updateCumulativeElo(run);
    expect(elo.writingByTag).toBeDefined();
    expect(elo.writingByTag["sermon"]).toBeDefined();
  });
});

describe("judgmentStableKey", () => {
  it("produces the same key regardless of sample ID", () => {
    const sampleMap1 = new Map<string, WritingSample>([
      ["id-abc", makeSample("id-abc", "modelA", "sermon")],
      ["id-def", makeSample("id-def", "modelB", "sermon")],
    ]);
    const sampleMap2 = new Map<string, WritingSample>([
      ["id-xyz", makeSample("id-xyz", "modelA", "sermon")],
      ["id-uvw", makeSample("id-uvw", "modelB", "sermon")],
    ]);

    const j1 = makeJudgment("j1", "sermon", "id-abc", "id-def", "A");
    const j2 = makeJudgment("j2", "sermon", "id-xyz", "id-uvw", "B");

    const key1 = judgmentStableKey(j1, sampleMap1);
    const key2 = judgmentStableKey(j2, sampleMap2);
    expect(key1).toBe(key2);
  });

  it("produces the same key when sampleA/sampleB are swapped", () => {
    const sampleMap = new Map<string, WritingSample>([
      ["sa", makeSample("sa", "modelA", "sermon")],
      ["sb", makeSample("sb", "modelB", "sermon")],
    ]);

    const j1 = makeJudgment("j1", "sermon", "sa", "sb", "A");
    const j2 = makeJudgment("j2", "sermon", "sb", "sa", "B");

    expect(judgmentStableKey(j1, sampleMap)).toBe(judgmentStableKey(j2, sampleMap));
  });

  it("differs when output index differs", () => {
    const sampleMap = new Map<string, WritingSample>([
      ["sa0", makeSample("sa0", "modelA", "sermon", "initial", undefined, 0)],
      ["sb0", makeSample("sb0", "modelB", "sermon", "initial", undefined, 0)],
      ["sa1", makeSample("sa1", "modelA", "sermon", "initial", undefined, 1)],
      ["sb1", makeSample("sb1", "modelB", "sermon", "initial", undefined, 1)],
    ]);

    const j0 = makeJudgment("j0", "sermon", "sa0", "sb0", "A");
    const j1 = makeJudgment("j1", "sermon", "sa1", "sb1", "A");

    expect(judgmentStableKey(j0, sampleMap)).not.toBe(judgmentStableKey(j1, sampleMap));
  });

  it("differs when stage differs", () => {
    const sampleMap = new Map<string, WritingSample>([
      ["sa", makeSample("sa", "modelA", "sermon")],
      ["sb", makeSample("sb", "modelB", "sermon")],
    ]);

    const jInit = makeJudgment("j1", "sermon", "sa", "sb", "A", "initial");
    const jRev = makeJudgment("j2", "sermon", "sa", "sb", "A", "revised");

    expect(judgmentStableKey(jInit, sampleMap)).not.toBe(judgmentStableKey(jRev, sampleMap));
  });

  it("returns null when sample is missing from the map", () => {
    const sampleMap = new Map<string, WritingSample>([
      ["sa", makeSample("sa", "modelA", "sermon")],
    ]);
    const j = makeJudgment("j1", "sermon", "sa", "sb-missing", "A");
    expect(judgmentStableKey(j, sampleMap)).toBeNull();
  });
});

describe("updateCumulativeElo - deduplication", () => {
  let originalEloContent: string | null = null;

  beforeEach(async () => {
    if (existsSync(ELO_FILE)) {
      originalEloContent = await readFile(ELO_FILE, "utf-8");
    }
    const dir = dirname(ELO_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    if (existsSync(ELO_FILE)) {
      await rm(ELO_FILE);
    }
  });

  afterEach(async () => {
    if (originalEloContent !== null) {
      await writeFile(ELO_FILE, originalEloContent);
    } else if (existsSync(ELO_FILE)) {
      await rm(ELO_FILE);
    }
  });

  it("does not double-count when run 2 re-includes cached judgments from run 1", async () => {
    // Run 1: modelA beats modelB
    const run1 = makeRunResult({
      samples: [
        makeSample("s1a", "modelA", "sermon"),
        makeSample("s1b", "modelB", "sermon"),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1a", "s1b", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    await updateCumulativeElo(run1);

    // Run 2: includes the SAME judgment (cache-seeded) + a new one on a
    // different output index. The cached judgment should be deduplicated.
    const run2 = makeRunResult({
      samples: [
        // Same semantic samples as run 1 (same model, prompt, outputIndex)
        makeSample("s2a", "modelA", "sermon"),
        makeSample("s2b", "modelB", "sermon"),
        // New samples at output index 1
        makeSample("s2c", "modelA", "sermon", "initial", undefined, 1),
        makeSample("s2d", "modelB", "sermon", "initial", undefined, 1),
      ],
      judgments: [
        // Duplicate of j1 (same judge, stage, and sample pair identity)
        makeJudgment("j1-cached", "sermon", "s2a", "s2b", "A"),
        // New judgment on distinct samples
        makeJudgment("j2", "sermon", "s2c", "s2d", "B"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    const elo = await updateCumulativeElo(run2);

    // Should have exactly 2 matches (1 from run1 + 1 new from run2),
    // NOT 3 (which would happen if the cached judgment was double-counted).
    const a = elo.writing["modelA"];
    const b = elo.writing["modelB"];
    expect(a.matchCount).toBe(2);
    expect(b.matchCount).toBe(2);
    // 1 win each → ratings close to 1500
    expect(Math.abs(a.rating - b.rating)).toBeLessThan(10);
  });

  it("ingests all judgments in a cache-only run (no false filtering)", async () => {
    // Cache-only run: all judgments have fromCache=true. The deduplication
    // should still ingest them since no prior keys exist.
    const judgments = [
      { ...makeJudgment("j1", "sermon", "s1", "s2", "A"), fromCache: true },
      { ...makeJudgment("j2", "essay", "s3", "s4", "B"), fromCache: true },
    ];
    const run = makeRunResult({
      samples: [
        makeSample("s1", "modelA", "sermon"),
        makeSample("s2", "modelB", "sermon"),
        makeSample("s3", "modelA", "essay"),
        makeSample("s4", "modelB", "essay"),
      ],
      judgments,
      prompts: [
        { id: "sermon", tags: ["sermon"] },
        { id: "essay", tags: ["essay"] },
      ],
    });

    const elo = await updateCumulativeElo(run);

    // Both judgments should be ingested (not filtered by fromCache)
    expect(elo.writing["modelA"].matchCount).toBe(2);
    expect(elo.writing["modelB"].matchCount).toBe(2);
  });

  it("persists processedJudgmentKeys and uses them across calls", async () => {
    const run = makeRunResult({
      samples: [
        makeSample("s1", "modelA", "sermon"),
        makeSample("s2", "modelB", "sermon"),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1", "s2", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    await updateCumulativeElo(run);

    // Reload from disk and verify processedJudgmentKeys is persisted
    const elo = await loadCumulativeElo();
    expect(elo.processedJudgmentKeys).toBeDefined();
    expect(elo.processedJudgmentKeys!.length).toBe(1);

    // Ingest same run again -- no new data should be added
    const elo2 = await updateCumulativeElo(run);
    // Still 1 key, 1 history entry from run1, plus 1 new history entry
    expect(elo2.processedJudgmentKeys!.length).toBe(1);
    expect(elo2.writing["modelA"].matchCount).toBe(1);
  });

  it("deduplicates improvement judgments correctly", async () => {
    const run1 = makeRunResult({
      samples: [
        makeSample("o1", "modelA", "sermon"),
        makeSample("r1a", "modelA", "sermon", "revised", "feedbackX"),
        makeSample("r1b", "modelA", "sermon", "revised", "feedbackY"),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "o1", "r1a", "B", "improvement"),
        makeJudgment("j2", "sermon", "o1", "r1b", "A", "improvement"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    await updateCumulativeElo(run1);

    // Re-ingest with same semantic judgments but different IDs
    const run2 = makeRunResult({
      samples: [
        makeSample("o2", "modelA", "sermon"),
        makeSample("r2a", "modelA", "sermon", "revised", "feedbackX"),
        makeSample("r2b", "modelA", "sermon", "revised", "feedbackY"),
      ],
      judgments: [
        makeJudgment("j3", "sermon", "o2", "r2a", "B", "improvement"),
        makeJudgment("j4", "sermon", "o2", "r2b", "A", "improvement"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    const elo = await updateCumulativeElo(run2);

    // feedbackX should have exactly 1 match, not 2
    expect(elo.feedbackGiving["feedbackX"].matchCount).toBe(1);
  });

  it("does not deduplicate same slot when text differs", async () => {
    const run1 = makeRunResult({
      samples: [
        makeSample("s1a", "modelA", "sermon", "initial", undefined, 0),
        makeSample("s1b", "modelB", "sermon", "initial", undefined, 0),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1a", "s1b", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    await updateCumulativeElo(run1);

    const run2 = makeRunResult({
      samples: [
        { ...makeSample("s2a", "modelA", "sermon", "initial", undefined, 0), text: "different text A" },
        { ...makeSample("s2b", "modelB", "sermon", "initial", undefined, 0), text: "different text B" },
      ],
      judgments: [
        makeJudgment("j2", "sermon", "s2a", "s2b", "B"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });

    const elo = await updateCumulativeElo(run2);
    expect(elo.writing["modelA"].matchCount).toBe(2);
    expect(elo.writing["modelB"].matchCount).toBe(2);
  });
});

describe("updateCumulativeElo - model identity (registryId)", () => {
  let originalEloContent: string | null = null;

  beforeEach(async () => {
    if (existsSync(ELO_FILE)) {
      originalEloContent = await readFile(ELO_FILE, "utf-8");
    }
    const dir = dirname(ELO_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    if (existsSync(ELO_FILE)) {
      await rm(ELO_FILE);
    }
  });

  afterEach(async () => {
    if (originalEloContent !== null) {
      await writeFile(ELO_FILE, originalEloContent);
    } else if (existsSync(ELO_FILE)) {
      await rm(ELO_FILE);
    }
  });

  it("merges pairwise records when label changes but registryId is stable", async () => {
    // Run 1: modelA (label "GPT-4o") beats modelB
    const run1 = makeRunResult({
      samples: [
        makeSample("s1a", "GPT-4o", "sermon", "initial", undefined, 0, { registryId: "openai:gpt-4o" }),
        makeSample("s1b", "Sonnet", "sermon", "initial", undefined, 0, { registryId: "anthropic:sonnet" }),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1a", "s1b", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
      models: [
        { provider: "openai", model: "gpt-4o", label: "GPT-4o", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "sonnet", label: "Sonnet", registryId: "anthropic:sonnet" },
      ],
    });
    await updateCumulativeElo(run1);

    // Run 2: label changed from "GPT-4o" to "GPT 4o" (models.dev rename),
    // but registryId is the same. modelB wins this time on a new output.
    const run2 = makeRunResult({
      samples: [
        makeSample("s2a", "GPT 4o", "sermon", "initial", undefined, 1, { registryId: "openai:gpt-4o" }),
        makeSample("s2b", "Sonnet", "sermon", "initial", undefined, 1, { registryId: "anthropic:sonnet" }),
      ],
      judgments: [
        makeJudgment("j2", "sermon", "s2a", "s2b", "B"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
      models: [
        { provider: "openai", model: "gpt-4o", label: "GPT 4o", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "sonnet", label: "Sonnet", registryId: "anthropic:sonnet" },
      ],
    });
    const elo = await updateCumulativeElo(run2);

    // Should display under the LATEST label "GPT 4o", not split into two entries
    expect(elo.writing["GPT 4o"]).toBeDefined();
    expect(elo.writing["GPT-4o"]).toBeUndefined();
    expect(elo.writing["GPT 4o"].matchCount).toBe(2);
    expect(elo.writing["Sonnet"].matchCount).toBe(2);
    // 1 win each → ratings close to 1500
    expect(Math.abs(elo.writing["GPT 4o"].rating - elo.writing["Sonnet"].rating)).toBeLessThan(10);
  });

  it("updates labels to latest when re-ingesting", async () => {
    // Run 1 with old label
    const run1 = makeRunResult({
      samples: [
        makeSample("s1a", "Old Label", "sermon", "initial", undefined, 0, { registryId: "openai:gpt-4o" }),
        makeSample("s1b", "Sonnet", "sermon", "initial", undefined, 0, { registryId: "anthropic:sonnet" }),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1a", "s1b", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
      models: [
        { provider: "openai", model: "gpt-4o", label: "Old Label", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "sonnet", label: "Sonnet", registryId: "anthropic:sonnet" },
      ],
    });
    await updateCumulativeElo(run1);

    // Verify it was stored under "Old Label"
    let elo = await loadCumulativeElo();
    expect(elo.writing["Old Label"]).toBeDefined();

    // Run 2 with new label, different output
    const run2 = makeRunResult({
      samples: [
        makeSample("s2a", "New Label", "sermon", "initial", undefined, 1, { registryId: "openai:gpt-4o" }),
        makeSample("s2b", "Sonnet", "sermon", "initial", undefined, 1, { registryId: "anthropic:sonnet" }),
      ],
      judgments: [
        makeJudgment("j2", "sermon", "s2a", "s2b", "B"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
      models: [
        { provider: "openai", model: "gpt-4o", label: "New Label", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "sonnet", label: "Sonnet", registryId: "anthropic:sonnet" },
      ],
    });
    elo = await updateCumulativeElo(run2);

    // Old label should be gone, new label should have accumulated data
    expect(elo.writing["Old Label"]).toBeUndefined();
    expect(elo.writing["New Label"]).toBeDefined();
    expect(elo.writing["New Label"].matchCount).toBe(2);
  });

  it("persists modelLabels mapping", async () => {
    const run = makeRunResult({
      samples: [
        makeSample("s1", "GPT-4o", "sermon", "initial", undefined, 0, { registryId: "openai:gpt-4o" }),
        makeSample("s2", "Sonnet", "sermon", "initial", undefined, 0, { registryId: "anthropic:sonnet" }),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1", "s2", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
      models: [
        { provider: "openai", model: "gpt-4o", label: "GPT-4o", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "sonnet", label: "Sonnet", registryId: "anthropic:sonnet" },
      ],
    });
    await updateCumulativeElo(run);

    const elo = await loadCumulativeElo();
    expect(elo.modelLabels).toBeDefined();
    expect(elo.modelLabels!["openai:gpt-4o"]).toBe("GPT-4o");
    expect(elo.modelLabels!["anthropic:sonnet"]).toBe("Sonnet");
  });

  it("works with per-tag ratings across label changes", async () => {
    const run1 = makeRunResult({
      samples: [
        makeSample("s1a", "Old-A", "sermon", "initial", undefined, 0, { registryId: "openai:gpt-4o" }),
        makeSample("s1b", "ModelB", "sermon", "initial", undefined, 0, { registryId: "anthropic:sonnet" }),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1a", "s1b", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
      models: [
        { provider: "openai", model: "gpt-4o", label: "Old-A", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "sonnet", label: "ModelB", registryId: "anthropic:sonnet" },
      ],
    });
    await updateCumulativeElo(run1);

    // Run 2: label changes for model A
    const run2 = makeRunResult({
      samples: [
        makeSample("s2a", "New-A", "sermon", "initial", undefined, 1, { registryId: "openai:gpt-4o" }),
        makeSample("s2b", "ModelB", "sermon", "initial", undefined, 1, { registryId: "anthropic:sonnet" }),
      ],
      judgments: [
        makeJudgment("j2", "sermon", "s2a", "s2b", "B"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
      models: [
        { provider: "openai", model: "gpt-4o", label: "New-A", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "sonnet", label: "ModelB", registryId: "anthropic:sonnet" },
      ],
    });
    const elo = await updateCumulativeElo(run2);

    // Per-tag should also use latest label and have merged data
    expect(elo.writingByTag["sermon"]["New-A"]).toBeDefined();
    expect(elo.writingByTag["sermon"]["Old-A"]).toBeUndefined();
    expect(elo.writingByTag["sermon"]["New-A"].matchCount).toBe(2);
  });

  it("falls back to label when registryId is absent (old run data)", async () => {
    // Simulate old run data: no registryId on samples
    const run = makeRunResult({
      samples: [
        makeSample("s1", "modelA", "sermon"),
        makeSample("s2", "modelB", "sermon"),
      ],
      judgments: [
        makeJudgment("j1", "sermon", "s1", "s2", "A"),
      ],
      prompts: [{ id: "sermon", tags: ["sermon"] }],
    });
    const elo = await updateCumulativeElo(run);

    // Should work exactly as before -- keyed by label
    expect(elo.writing["modelA"]).toBeDefined();
    expect(elo.writing["modelA"].matchCount).toBe(1);
    expect(elo.writing["modelB"].matchCount).toBe(1);
  });
});
