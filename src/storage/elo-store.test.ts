import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { rm, mkdir, writeFile, readFile } from "fs/promises";
import { join, dirname } from "path";
import { updateCumulativeElo, loadCumulativeElo } from "./elo-store.js";
import type {
  RunResult,
  WritingSample,
  PairwiseJudgment,
  EloRating,
  CumulativeElo,
} from "../types.js";

const ELO_FILE = join(process.cwd(), "data", "elo.json");

function makeSample(
  id: string,
  model: string,
  promptId: string,
  stage: "initial" | "revised" = "initial",
  feedbackModel?: string
): WritingSample {
  return {
    id,
    model,
    promptId,
    outputIndex: 0,
    text: "test",
    stage,
    feedbackModel,
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
}): RunResult {
  return {
    config: {
      id: "test-run",
      models: [
        { provider: "openai", model: "gpt-4o", label: "modelA", registryId: "openai:gpt-4o" },
        { provider: "anthropic", model: "claude-sonnet-4-20250514", label: "modelB", registryId: "anthropic:claude-sonnet-4-20250514" },
      ],
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
    // Revised judgments compare writers (same feedback provider) — should not affect feedback ELO.
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
    // Run 1: modelA wins sermon
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

    // Run 2: modelB wins sermon
    const run2 = makeRunResult({
      samples: [
        makeSample("s2a", "modelA", "sermon"),
        makeSample("s2b", "modelB", "sermon"),
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
        // Only improvement judgments — should NOT affect category ELO
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
