import { describe, it, expect } from "bun:test";
import {
  computeSelfPreferenceBias,
  computePositionBias,
  computeJudgeBias,
  computeBiasCorrections,
  composeWeights,
  MIN_SELF_JUDGMENTS,
  MIN_POSITION_JUDGMENTS,
  BIAS_DEAD_ZONE,
} from "./judge-bias.js";
import type { JudgeBiasData } from "./judge-bias.js";
import { MIN_JUDGE_WEIGHT } from "./judge-quality.js";
import type { PairwiseJudgment } from "../types.js";

// ── computeSelfPreferenceBias ───────────────────────

describe("computeSelfPreferenceBias", () => {
  it("detects self-preference when judge favors own model", () => {
    // modelA judges modelA-vs-modelB pairs, always picks A (its own)
    // modelB judges same pairs, picks A and B equally
    const judgments: PairwiseJudgment[] = [];
    const sampleToModel = new Map<string, string>();

    for (let i = 0; i < MIN_SELF_JUDGMENTS + 2; i++) {
      const sA = `sA_${i}`;
      const sB = `sB_${i}`;
      sampleToModel.set(sA, "modelA");
      sampleToModel.set(sB, "modelB");

      // modelA always picks its own output
      judgments.push(makeJudgment(`jA_${i}`, sA, sB, "A", "modelA"));
      // modelB alternates (fair baseline)
      judgments.push(makeJudgment(`jB_${i}`, sA, sB, i % 2 === 0 ? "A" : "B", "modelB"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["modelA", "modelB"]);

    const biasA = result.get("modelA")!;
    expect(biasA.sufficient).toBe(true);
    expect(biasA.selfWinRate).toBe(1.0); // Always picks own
    expect(biasA.expectedWinRate).toBe(0.5); // Other judges say 50%
    expect(biasA.biasDelta).toBe(0.5); // 100% - 50% = 50% excess
  });

  it("returns approximately zero bias when judge is fair on own model", () => {
    const judgments: PairwiseJudgment[] = [];
    const sampleToModel = new Map<string, string>();

    for (let i = 0; i < MIN_SELF_JUDGMENTS + 2; i++) {
      const sA = `sA_${i}`;
      const sB = `sB_${i}`;
      sampleToModel.set(sA, "modelA");
      sampleToModel.set(sB, "modelB");

      // modelA alternates — same rate as modelB's verdicts
      judgments.push(makeJudgment(`jA_${i}`, sA, sB, i % 2 === 0 ? "A" : "B", "modelA"));
      judgments.push(makeJudgment(`jB_${i}`, sA, sB, i % 2 === 0 ? "A" : "B", "modelB"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["modelA", "modelB"]);

    const biasA = result.get("modelA")!;
    expect(biasA.sufficient).toBe(true);
    expect(Math.abs(biasA.biasDelta)).toBeLessThan(0.01);
  });

  it("returns negative bias when judge disfavors own model", () => {
    const judgments: PairwiseJudgment[] = [];
    const sampleToModel = new Map<string, string>();

    for (let i = 0; i < MIN_SELF_JUDGMENTS + 2; i++) {
      const sA = `sA_${i}`;
      const sB = `sB_${i}`;
      sampleToModel.set(sA, "modelA");
      sampleToModel.set(sB, "modelB");

      // modelA always picks AGAINST its own output
      judgments.push(makeJudgment(`jA_${i}`, sA, sB, "B", "modelA"));
      // modelB says A wins half the time (baseline 50%)
      judgments.push(makeJudgment(`jB_${i}`, sA, sB, i % 2 === 0 ? "A" : "B", "modelB"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["modelA", "modelB"]);

    const biasA = result.get("modelA")!;
    expect(biasA.sufficient).toBe(true);
    expect(biasA.selfWinRate).toBe(0); // Never picks own
    expect(biasA.biasDelta).toBeLessThan(0); // Negative bias
  });

  it("returns insufficient when fewer than MIN_SELF_JUDGMENTS decisive", () => {
    const judgments: PairwiseJudgment[] = [];
    const sampleToModel = new Map<string, string>();

    // Only 3 self-judgments (below threshold)
    for (let i = 0; i < 3; i++) {
      const sA = `sA_${i}`;
      const sB = `sB_${i}`;
      sampleToModel.set(sA, "modelA");
      sampleToModel.set(sB, "modelB");
      judgments.push(makeJudgment(`jA_${i}`, sA, sB, "A", "modelA"));
      judgments.push(makeJudgment(`jB_${i}`, sA, sB, "A", "modelB"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["modelA", "modelB"]);
    expect(result.get("modelA")!.sufficient).toBe(false);
  });

  it("handles all ties in self-judgments", () => {
    const judgments: PairwiseJudgment[] = [];
    const sampleToModel = new Map<string, string>();

    for (let i = 0; i < MIN_SELF_JUDGMENTS + 2; i++) {
      const sA = `sA_${i}`;
      const sB = `sB_${i}`;
      sampleToModel.set(sA, "modelA");
      sampleToModel.set(sB, "modelB");
      judgments.push(makeJudgment(`jA_${i}`, sA, sB, "tie", "modelA"));
      judgments.push(makeJudgment(`jB_${i}`, sA, sB, "A", "modelB"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["modelA"]);
    const biasA = result.get("modelA")!;
    expect(isNaN(biasA.selfWinRate)).toBe(true);
    expect(biasA.sufficient).toBe(false);
  });

  it("handles no self-judgments (separate --judges)", () => {
    const judgments: PairwiseJudgment[] = [];
    const sampleToModel = new Map<string, string>();

    for (let i = 0; i < 10; i++) {
      const sA = `sA_${i}`;
      const sB = `sB_${i}`;
      sampleToModel.set(sA, "writerA");
      sampleToModel.set(sB, "writerB");
      // Judge is a separate model, not a writer
      judgments.push(makeJudgment(`j_${i}`, sA, sB, "A", "judgeX"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["judgeX"]);
    const bias = result.get("judgeX")!;
    expect(bias.selfJudgmentCount).toBe(0);
    expect(bias.sufficient).toBe(false);
  });

  it("handles single judge (no cross-judge expected rate)", () => {
    const judgments: PairwiseJudgment[] = [];
    const sampleToModel = new Map<string, string>();

    for (let i = 0; i < MIN_SELF_JUDGMENTS + 2; i++) {
      const sA = `sA_${i}`;
      const sB = `sB_${i}`;
      sampleToModel.set(sA, "modelA");
      sampleToModel.set(sB, "modelB");
      judgments.push(makeJudgment(`jA_${i}`, sA, sB, "A", "modelA"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["modelA"]);
    const biasA = result.get("modelA")!;
    // No other judges → expectedWinRate = NaN → biasDelta = NaN → insufficient
    expect(isNaN(biasA.expectedWinRate)).toBe(true);
    expect(biasA.sufficient).toBe(false);
  });

  it("computes expected win rate from other judges on same model pair", () => {
    const sampleToModel = new Map<string, string>();
    // Pair 1: modelA vs modelB — modelA's writing is strong here
    sampleToModel.set("s1A", "modelA");
    sampleToModel.set("s1B", "modelB");
    // Pair 2: modelA vs modelB — modelA's writing is weak here
    sampleToModel.set("s2A", "modelA");
    sampleToModel.set("s2B", "modelB");

    const judgments: PairwiseJudgment[] = [];
    // On pair 1: both judges agree A wins
    for (let i = 0; i < MIN_SELF_JUDGMENTS; i++) {
      judgments.push(makeJudgment(`p1_jA_${i}`, "s1A", "s1B", "A", "modelA"));
      judgments.push(makeJudgment(`p1_jB_${i}`, "s1A", "s1B", "A", "modelB"));
    }
    // On pair 2: modelA picks itself, modelB picks itself
    for (let i = 0; i < MIN_SELF_JUDGMENTS; i++) {
      judgments.push(makeJudgment(`p2_jA_${i}`, "s2A", "s2B", "A", "modelA"));
      judgments.push(makeJudgment(`p2_jB_${i}`, "s2A", "s2B", "B", "modelB"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["modelA", "modelB"]);

    const biasA = result.get("modelA")!;
    // Self-win rate for modelA: always picks A (its own) → 100%
    expect(biasA.selfWinRate).toBe(1.0);
    // Expected: on pair1 modelB picks A (modelA wins), on pair2 modelB picks B (modelA loses)
    // Expected win rate = MIN_SELF_JUDGMENTS / (2 * MIN_SELF_JUDGMENTS) = 0.5
    expect(biasA.expectedWinRate).toBe(0.5);
  });

  it("aggregates across different sample pairs for the same model pair", () => {
    // This tests the model-pair grouping: judges evaluate DIFFERENT sample
    // pairs (different output indices) of the same model matchup. Cross-judge
    // data should still aggregate for the expected rate.
    const sampleToModel = new Map<string, string>();
    const judgments: PairwiseJudgment[] = [];

    // modelA judges one set of sample pairs (output index 0)
    for (let i = 0; i < MIN_SELF_JUDGMENTS + 2; i++) {
      const sA = `sA_idx0_${i}`;
      const sB = `sB_idx0_${i}`;
      sampleToModel.set(sA, "modelA");
      sampleToModel.set(sB, "modelB");
      judgments.push(makeJudgment(`jA_${i}`, sA, sB, "A", "modelA")); // always picks self
    }

    // modelB judges a DIFFERENT set of sample pairs (output index 1)
    // — no overlap on exact sample IDs!
    for (let i = 0; i < MIN_SELF_JUDGMENTS + 2; i++) {
      const sA = `sA_idx1_${i}`;
      const sB = `sB_idx1_${i}`;
      sampleToModel.set(sA, "modelA");
      sampleToModel.set(sB, "modelB");
      judgments.push(makeJudgment(`jB_${i}`, sA, sB, i % 2 === 0 ? "A" : "B", "modelB"));
    }

    const result = computeSelfPreferenceBias(judgments, sampleToModel, ["modelA", "modelB"]);

    const biasA = result.get("modelA")!;
    // With model-pair grouping, modelB's verdicts on idx1 pairs provide
    // the baseline for modelA even though they're different sample IDs.
    expect(biasA.sufficient).toBe(true);
    expect(biasA.selfWinRate).toBe(1.0);
    expect(biasA.expectedWinRate).toBe(0.5); // modelB picks A 50% of the time
    expect(biasA.biasDelta).toBe(0.5);
  });
});

// ── computePositionBias ─────────────────────────────

describe("computePositionBias", () => {
  it("detects position-A bias", () => {
    const judgments: PairwiseJudgment[] = [];
    // Judge always picks whatever is in position A
    for (let i = 0; i < MIN_POSITION_JUDGMENTS + 2; i++) {
      // Half not swapped (winner A = presented-A won), half swapped (winner B = presented-A won)
      const swapped = i % 2 === 0;
      judgments.push(makeJudgment(
        `j_${i}`, `sA_${i}`, `sB_${i}`,
        swapped ? "B" : "A", // Always picks presented-A
        "judge1", "initial", "p1", swapped,
      ));
    }

    const result = computePositionBias(judgments, ["judge1"]);
    const bias = result.get("judge1")!;
    expect(bias.sufficient).toBe(true);
    expect(bias.positionARate).toBe(1.0);
    expect(bias.positionBiasDelta).toBe(0.5);
  });

  it("returns approximately zero bias for balanced judge", () => {
    const judgments: PairwiseJudgment[] = [];
    for (let i = 0; i < MIN_POSITION_JUDGMENTS + 4; i++) {
      // Alternating: sometimes presented-A wins, sometimes not
      // Not swapped, winner alternates A/B → half presented-A wins
      judgments.push(makeJudgment(
        `j_${i}`, `sA_${i}`, `sB_${i}`,
        i % 2 === 0 ? "A" : "B",
        "judge1", "initial", "p1", false,
      ));
    }

    const result = computePositionBias(judgments, ["judge1"]);
    const bias = result.get("judge1")!;
    expect(bias.sufficient).toBe(true);
    expect(Math.abs(bias.positionBiasDelta)).toBeLessThan(0.01);
  });

  it("returns insufficient with few judgments", () => {
    const judgments = [
      makeJudgment("j1", "sA", "sB", "A", "judge1", "initial", "p1", false),
      makeJudgment("j2", "sA2", "sB2", "B", "judge1", "initial", "p1", true),
    ];

    const result = computePositionBias(judgments, ["judge1"]);
    expect(result.get("judge1")!.sufficient).toBe(false);
  });

  it("excludes judgments without positionSwapped", () => {
    const judgments: PairwiseJudgment[] = [];
    // Add many judgments without positionSwapped
    for (let i = 0; i < 20; i++) {
      judgments.push(makeJudgment(`j_${i}`, `sA_${i}`, `sB_${i}`, "A", "judge1"));
    }
    // Add a few with positionSwapped
    judgments.push(makeJudgment("jS1", "sX1", "sY1", "A", "judge1", "initial", "p1", false));
    judgments.push(makeJudgment("jS2", "sX2", "sY2", "B", "judge1", "initial", "p1", true));

    const result = computePositionBias(judgments, ["judge1"]);
    // Only 2 have position data → insufficient
    expect(result.get("judge1")!.positionKnownCount).toBe(2);
    expect(result.get("judge1")!.sufficient).toBe(false);
  });

  it("correctly interprets swapped=true winner=B as presented-A win", () => {
    // swapped=true, winner="B" → judge picked what was originally presented as A
    const judgments = [];
    for (let i = 0; i < MIN_POSITION_JUDGMENTS + 2; i++) {
      judgments.push(makeJudgment(
        `j_${i}`, `sA_${i}`, `sB_${i}`, "B", "judge1", "initial", "p1", true,
      ));
    }

    const result = computePositionBias(judgments, ["judge1"]);
    const bias = result.get("judge1")!;
    // All are presented-A wins
    expect(bias.presentedAWins).toBe(MIN_POSITION_JUDGMENTS + 2);
    expect(bias.positionARate).toBe(1.0);
  });

  it("handles all ties", () => {
    const judgments = [];
    for (let i = 0; i < MIN_POSITION_JUDGMENTS + 2; i++) {
      judgments.push(makeJudgment(
        `j_${i}`, `sA_${i}`, `sB_${i}`, "tie", "judge1", "initial", "p1", false,
      ));
    }

    const result = computePositionBias(judgments, ["judge1"]);
    const bias = result.get("judge1")!;
    expect(isNaN(bias.positionARate)).toBe(true);
    expect(bias.sufficient).toBe(false);
  });
});

// ── computeBiasCorrections ──────────────────────────

describe("computeBiasCorrections", () => {
  it("omits non-self judgments from sparse map (implicit 1.0)", () => {
    const sampleToModel = new Map([["sA", "writerA"], ["sB", "writerB"]]);
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "judgeX")];
    const biasData = makeBiasData("judgeX", { biasDelta: 0.3, sufficient: true });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    expect(corrections.has("j1")).toBe(false);
  });

  it("omits self-judgments during bootstrap (insufficient)", () => {
    const sampleToModel = new Map([["sA", "modelA"], ["sB", "modelB"]]);
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "modelA")];
    const biasData = makeBiasData("modelA", { biasDelta: 0.5, sufficient: false });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    expect(corrections.has("j1")).toBe(false);
  });

  it("omits self-judgments within dead zone", () => {
    const sampleToModel = new Map([["sA", "modelA"], ["sB", "modelB"]]);
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "modelA")];
    const biasData = makeBiasData("modelA", { biasDelta: BIAS_DEAD_ZONE - 0.01, sufficient: true });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    expect(corrections.has("j1")).toBe(false);
  });

  it("down-weights self-favorable votes proportionally", () => {
    const sampleToModel = new Map([["sA", "modelA"], ["sB", "modelB"]]);
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "modelA")];
    const biasData = makeBiasData("modelA", { biasDelta: 0.3, sufficient: true });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    expect(corrections.get("j1")).toBeCloseTo(0.7, 5);
  });

  it("omits votes against self (implicit 1.0)", () => {
    const sampleToModel = new Map([["sA", "modelA"], ["sB", "modelB"]]);
    const judgments = [makeJudgment("j1", "sA", "sB", "B", "modelA")]; // Voted against self
    const biasData = makeBiasData("modelA", { biasDelta: 0.3, sufficient: true });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    expect(corrections.has("j1")).toBe(false);
  });

  it("omits self-judgment ties (implicit 1.0)", () => {
    const sampleToModel = new Map([["sA", "modelA"], ["sB", "modelB"]]);
    const judgments = [makeJudgment("j1", "sA", "sB", "tie", "modelA")];
    const biasData = makeBiasData("modelA", { biasDelta: 0.3, sufficient: true });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    expect(corrections.has("j1")).toBe(false);
  });

  it("clamps correction factor to MIN_JUDGE_WEIGHT floor", () => {
    const sampleToModel = new Map([["sA", "modelA"], ["sB", "modelB"]]);
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "modelA")];
    const biasData = makeBiasData("modelA", { biasDelta: 1.0, sufficient: true });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    expect(corrections.get("j1")).toBe(MIN_JUDGE_WEIGHT);
  });

  it("omits when bias is negative (implicit 1.0)", () => {
    const sampleToModel = new Map([["sA", "modelA"], ["sB", "modelB"]]);
    // Judge votes for its own model, but has negative bias (disfavors self normally)
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "modelA")];
    const biasData = makeBiasData("modelA", { biasDelta: -0.2, sufficient: true });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    // Negative bias: -0.2 <= BIAS_DEAD_ZONE (0.05) → no correction, omitted from sparse map
    expect(corrections.has("j1")).toBe(false);
  });

  it("handles model on side B", () => {
    const sampleToModel = new Map([["sA", "modelB"], ["sB", "modelA"]]);
    // modelA is on side B, and votes for B (itself)
    const judgments = [makeJudgment("j1", "sA", "sB", "B", "modelA")];
    const biasData = makeBiasData("modelA", { biasDelta: 0.3, sufficient: true });

    const corrections = computeBiasCorrections(judgments, sampleToModel, biasData);
    expect(corrections.get("j1")).toBeCloseTo(0.7, 5);
  });
});

// ── composeWeights ──────────────────────────────────

describe("composeWeights", () => {
  it("multiplies quality weight and bias correction", () => {
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "judge1")];
    const judgeWeights = new Map([["judge1", 0.8]]);
    const biasCorrections = new Map([["j1", 0.7]]);

    const result = composeWeights(judgments, judgeWeights, biasCorrections);
    expect(result.get("j1")).toBeCloseTo(0.56, 5);
  });

  it("uses 1.0 when no judge weights provided (bootstrap)", () => {
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "judge1")];
    const biasCorrections = new Map([["j1", 0.7]]);

    const result = composeWeights(judgments, undefined, biasCorrections);
    expect(result.get("j1")).toBeCloseTo(0.7, 5);
  });

  it("uses 1.0 when no bias correction for a judgment", () => {
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "judge1")];
    const judgeWeights = new Map([["judge1", 0.8]]);
    const biasCorrections = new Map<string, number>();

    const result = composeWeights(judgments, judgeWeights, biasCorrections);
    expect(result.get("j1")).toBeCloseTo(0.8, 5);
  });

  it("clamps composed weight to MIN_JUDGE_WEIGHT", () => {
    const judgments = [makeJudgment("j1", "sA", "sB", "A", "judge1")];
    const judgeWeights = new Map([["judge1", 0.1]]);
    const biasCorrections = new Map([["j1", 0.1]]);

    const result = composeWeights(judgments, judgeWeights, biasCorrections);
    // 0.1 * 0.1 = 0.01, clamped to MIN_JUDGE_WEIGHT
    expect(result.get("j1")).toBe(MIN_JUDGE_WEIGHT);
  });
});

// ── computeJudgeBias ────────────────────────────────

describe("computeJudgeBias", () => {
  it("returns both self-preference and position bias data", () => {
    const sampleToModel = new Map([["sA", "modelA"], ["sB", "modelB"]]);
    const judgments = [
      makeJudgment("j1", "sA", "sB", "A", "modelA", "initial", "p1", false),
    ];

    const result = computeJudgeBias(judgments, sampleToModel, ["modelA"]);
    expect(result.selfPreference.has("modelA")).toBe(true);
    expect(result.positionBias.has("modelA")).toBe(true);
  });
});

// ── Helpers ─────────────────────────────────────────

function makeJudgment(
  id: string,
  sampleA: string,
  sampleB: string,
  winner: "A" | "B" | "tie",
  judgeModel: string,
  stage: "initial" | "revised" | "improvement" = "initial",
  promptId: string = "p1",
  positionSwapped?: boolean,
): PairwiseJudgment {
  return {
    id,
    judgeModel,
    promptId,
    sampleA,
    sampleB,
    winner,
    reasoning: "test",
    stage,
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: { input: 0, output: 0, total: 0, totalUncached: 0 },
    latencyMs: 0,
    ...(positionSwapped != null ? { positionSwapped } : {}),
  };
}



function makeBiasData(
  judgeLabel: string,
  selfPreference: { biasDelta: number; sufficient: boolean },
): JudgeBiasData {
  return {
    selfPreference: new Map([[judgeLabel, {
      selfJudgmentCount: 20,
      selfWins: 15,
      selfTies: 0,
      selfWinRate: 0.75,
      expectedWinRate: 0.75 - selfPreference.biasDelta,
      biasDelta: selfPreference.biasDelta,
      sufficient: selfPreference.sufficient,
    }]]),
    positionBias: new Map(),
  };
}
