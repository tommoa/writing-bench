import { describe, it, expect } from "bun:test";
import {
  buildJudgeGames,
  computeJudgeQuality,
  computeEloBasedJudgeQuality,
  ratingsToWeights,
  getJudgeWeight,
  shouldPruneJudge,
  MIN_JUDGE_INSTANCES,
  MIN_JUDGE_WEIGHT,
} from "./judge-quality.js";
import type { JudgeQualityData } from "./judge-quality.js";
import type { WhrRating } from "./whr.js";
import type { PairwiseJudgment } from "../types.js";
import { DEFAULT_CONVERGENCE } from "../types.js";

describe("buildJudgeGames", () => {
  it("produces win for judge that agrees with consensus", () => {
    // 3 judges: j1=A, j2=A, j3=B → consensus = A
    // j1 agrees, j2 agrees, j3 disagrees
    const judgments = [
      makeJudgment("j1", "s1", "s2", "A", "judge1"),
      makeJudgment("j2", "s1", "s2", "A", "judge2"),
      makeJudgment("j3", "s1", "s2", "B", "judge3"),
    ];

    const games = buildJudgeGames(judgments);
    // 3 pairs: (j1,j2), (j1,j3), (j2,j3)
    expect(games).toHaveLength(3);

    // j1 vs j2: both agree → tie
    const j1j2 = games.find(
      (g) =>
        (g.playerWhite === "judge1" && g.playerBlack === "judge2") ||
        (g.playerWhite === "judge2" && g.playerBlack === "judge1"),
    )!;
    expect(j1j2.result).toBe(0.5);

    // j1 vs j3: j1 agrees, j3 doesn't → j1 wins
    const j1j3 = games.find(
      (g) => g.playerWhite === "judge1" && g.playerBlack === "judge3",
    )!;
    expect(j1j3.result).toBe(1.0);

    // j2 vs j3: j2 agrees, j3 doesn't → j2 wins
    const j2j3 = games.find(
      (g) => g.playerWhite === "judge2" && g.playerBlack === "judge3",
    )!;
    expect(j2j3.result).toBe(1.0);
  });

  it("produces all ties when all judges agree", () => {
    const judgments = [
      makeJudgment("j1", "s1", "s2", "A", "judge1"),
      makeJudgment("j2", "s1", "s2", "A", "judge2"),
      makeJudgment("j3", "s1", "s2", "A", "judge3"),
    ];

    const games = buildJudgeGames(judgments);
    expect(games).toHaveLength(3);
    for (const g of games) {
      expect(g.result).toBe(0.5); // all agree → all ties
    }
  });

  it("returns empty for single-judge instances", () => {
    const judgments = [
      makeJudgment("j1", "s1", "s2", "A", "judge1"),
      makeJudgment("j2", "s3", "s4", "B", "judge2"),
    ];

    const games = buildJudgeGames(judgments);
    expect(games).toHaveLength(0);
  });

  it("handles tie consensus correctly", () => {
    // j1=A, j2=B, j3=tie → consensus = tie (A not > B and tie, B not > A and tie)
    const judgments = [
      makeJudgment("j1", "s1", "s2", "A", "judge1"),
      makeJudgment("j2", "s1", "s2", "B", "judge2"),
      makeJudgment("j3", "s1", "s2", "tie", "judge3"),
    ];

    const games = buildJudgeGames(judgments);
    expect(games).toHaveLength(3);

    // Only judge3 agrees with "tie" consensus
    // j3 beats j1, j3 beats j2, j1 ties j2 (both disagree)
    const j3wins = games.filter((g) => g.result === 1.0);
    const ties = games.filter((g) => g.result === 0.5);
    expect(j3wins).toHaveLength(2);
    expect(ties).toHaveLength(1);
    for (const g of j3wins) {
      expect(g.playerWhite).toBe("judge3");
    }
  });

  it("normalizes sample order for canonical keying", () => {
    // Same pair judged with sampleA/sampleB in different order
    const judgments = [
      makeJudgment("j1", "s1", "s2", "A", "judge1"),
      makeJudgment("j2", "s2", "s1", "B", "judge2"), // flipped order, B→A in canonical
    ];

    const games = buildJudgeGames(judgments);
    // Both should map to the same instance (s1 < s2 canonical)
    // j1 says A (canonical), j2 says B→A (flipped → A canonical)
    // Both say A → both agree → tie
    expect(games).toHaveLength(1);
    expect(games[0].result).toBe(0.5);
  });

  it("handles multiple instances independently", () => {
    const judgments = [
      // Instance 1: s1 vs s2
      makeJudgment("j1", "s1", "s2", "A", "judge1"),
      makeJudgment("j2", "s1", "s2", "A", "judge2"),
      makeJudgment("j3", "s1", "s2", "B", "judge3"),
      // Instance 2: s3 vs s4
      makeJudgment("j4", "s3", "s4", "B", "judge1"),
      makeJudgment("j5", "s3", "s4", "B", "judge2"),
      makeJudgment("j6", "s3", "s4", "A", "judge3"),
    ];

    const games = buildJudgeGames(judgments);
    // 3 pairs per instance × 2 instances = 6 games
    expect(games).toHaveLength(6);

    // judge3 disagrees in both instances → should have lower rating
    const judge3Losses = games.filter(
      (g) => g.playerBlack === "judge3" && g.result === 1.0,
    );
    expect(judge3Losses.length).toBeGreaterThanOrEqual(2);
  });
});

describe("computeJudgeQuality", () => {
  it("returns inactive during bootstrap period", () => {
    // Only 2 multi-judge instances (below MIN_JUDGE_INSTANCES=5)
    const judgments: PairwiseJudgment[] = [];
    for (let i = 0; i < 2; i++) {
      judgments.push(makeJudgment(`j${i}a`, `s${i}a`, `s${i}b`, "A", "judge1"));
      judgments.push(makeJudgment(`j${i}b`, `s${i}a`, `s${i}b`, "A", "judge2"));
    }

    const result = computeJudgeQuality(judgments, ["judge1", "judge2"], DEFAULT_CONVERGENCE.judgeDecay);
    expect(result.active).toBe(false);
    expect(result.weights.get("judge1")).toBe(1.0);
    expect(result.weights.get("judge2")).toBe(1.0);
    expect(result.instanceCount).toBe(2);
  });

  it("returns active with weights after sufficient data", () => {
    // Create enough multi-judge instances with clear quality difference
    const judgments: PairwiseJudgment[] = [];
    for (let i = 0; i < 8; i++) {
      // Consensus will be A (2 votes A, 1 vote B)
      judgments.push(makeJudgment(`j${i}a`, `s${i}a`, `s${i}b`, "A", "judge1"));
      judgments.push(makeJudgment(`j${i}b`, `s${i}a`, `s${i}b`, "A", "judge2"));
      judgments.push(makeJudgment(`j${i}c`, `s${i}a`, `s${i}b`, "B", "judge3"));
    }

    const result = computeJudgeQuality(judgments, ["judge1", "judge2", "judge3"], DEFAULT_CONVERGENCE.judgeDecay);
    expect(result.active).toBe(true);
    expect(result.instanceCount).toBe(8);
    expect(result.ratings.length).toBeGreaterThan(0);
  });

  it("assigns higher weight to more consistent judge", () => {
    const judgments: PairwiseJudgment[] = [];
    for (let i = 0; i < 10; i++) {
      // judge1 and judge2 always agree (consensus = A), judge3 always disagrees
      judgments.push(makeJudgment(`j${i}a`, `s${i}a`, `s${i}b`, "A", "judge1"));
      judgments.push(makeJudgment(`j${i}b`, `s${i}a`, `s${i}b`, "A", "judge2"));
      judgments.push(makeJudgment(`j${i}c`, `s${i}a`, `s${i}b`, "B", "judge3"));
    }

    const result = computeJudgeQuality(judgments, ["judge1", "judge2", "judge3"], DEFAULT_CONVERGENCE.judgeDecay);
    expect(result.active).toBe(true);

    const w1 = result.weights.get("judge1")!;
    const w3 = result.weights.get("judge3")!;
    expect(w1).toBeGreaterThan(w3);
  });

  it("assigns equal weights when all judges always agree", () => {
    const judgments: PairwiseJudgment[] = [];
    for (let i = 0; i < 8; i++) {
      judgments.push(makeJudgment(`j${i}a`, `s${i}a`, `s${i}b`, "A", "judge1"));
      judgments.push(makeJudgment(`j${i}b`, `s${i}a`, `s${i}b`, "A", "judge2"));
      judgments.push(makeJudgment(`j${i}c`, `s${i}a`, `s${i}b`, "A", "judge3"));
    }

    const result = computeJudgeQuality(judgments, ["judge1", "judge2", "judge3"], DEFAULT_CONVERGENCE.judgeDecay);
    // All agree → all tie games → equal ratings → equal weights
    if (result.active) {
      const w1 = result.weights.get("judge1")!;
      const w2 = result.weights.get("judge2")!;
      const w3 = result.weights.get("judge3")!;
      expect(Math.abs(w1 - w2)).toBeLessThan(0.01);
      expect(Math.abs(w2 - w3)).toBeLessThan(0.01);
    }
  });

  it("normalizes best weight to 1.0 (ceiling normalization)", () => {
    const judgments: PairwiseJudgment[] = [];
    for (let i = 0; i < 10; i++) {
      judgments.push(makeJudgment(`j${i}a`, `s${i}a`, `s${i}b`, "A", "judge1"));
      judgments.push(makeJudgment(`j${i}b`, `s${i}a`, `s${i}b`, "A", "judge2"));
      judgments.push(makeJudgment(`j${i}c`, `s${i}a`, `s${i}b`, "B", "judge3"));
    }

    const result = computeJudgeQuality(judgments, ["judge1", "judge2", "judge3"], DEFAULT_CONVERGENCE.judgeDecay);
    if (result.active) {
      const weights = [...result.weights.values()];
      const maxWeight = Math.max(...weights);
      expect(Math.abs(maxWeight - 1.0)).toBeLessThan(0.001);
    }
  });

  it("no weight exceeds 1.0", () => {
    const judgments: PairwiseJudgment[] = [];
    for (let i = 0; i < 10; i++) {
      judgments.push(makeJudgment(`j${i}a`, `s${i}a`, `s${i}b`, "A", "judge1"));
      judgments.push(makeJudgment(`j${i}b`, `s${i}a`, `s${i}b`, "A", "judge2"));
      judgments.push(makeJudgment(`j${i}c`, `s${i}a`, `s${i}b`, "B", "judge3"));
    }

    const result = computeJudgeQuality(judgments, ["judge1", "judge2", "judge3"], DEFAULT_CONVERGENCE.judgeDecay);
    if (result.active) {
      for (const w of result.weights.values()) {
        expect(w).toBeLessThanOrEqual(1.0);
      }
    }
  });

  it("fills in missing judges with weight 1.0", () => {
    const judgments: PairwiseJudgment[] = [];
    for (let i = 0; i < 8; i++) {
      judgments.push(makeJudgment(`j${i}a`, `s${i}a`, `s${i}b`, "A", "judge1"));
      judgments.push(makeJudgment(`j${i}b`, `s${i}a`, `s${i}b`, "A", "judge2"));
    }

    // judge3 is in the labels but has no judgments
    const result = computeJudgeQuality(judgments, ["judge1", "judge2", "judge3"], DEFAULT_CONVERGENCE.judgeDecay);
    expect(result.weights.get("judge3")).toBe(1.0);
  });
});

describe("getJudgeWeight", () => {
  it("returns weight from data", () => {
    const data: JudgeQualityData = {
      ratings: [],
      weights: new Map([["judge1", 0.8]]),
      active: true,
      instanceCount: 10,
    };
    expect(getJudgeWeight(data, "judge1")).toBe(0.8);
  });

  it("returns 1.0 for unknown judge", () => {
    const data: JudgeQualityData = {
      ratings: [],
      weights: new Map(),
      active: true,
      instanceCount: 10,
    };
    expect(getJudgeWeight(data, "unknown")).toBe(1.0);
  });
});

describe("shouldPruneJudge", () => {
  const threshold = DEFAULT_CONVERGENCE.judgePruneThreshold;

  it("does not prune during bootstrap", () => {
    const data: JudgeQualityData = {
      ratings: [],
      weights: new Map([["judge1", 0.1]]),
      active: false,
      instanceCount: 2,
    };
    expect(shouldPruneJudge(data, "judge1", threshold)).toBe(false);
  });

  it("prunes judge below threshold", () => {
    const data: JudgeQualityData = {
      ratings: [],
      weights: new Map([["judge1", threshold - 0.01]]),
      active: true,
      instanceCount: 10,
    };
    expect(shouldPruneJudge(data, "judge1", threshold)).toBe(true);
  });

  it("does not prune judge at or above threshold", () => {
    const data: JudgeQualityData = {
      ratings: [],
      weights: new Map([["judge1", threshold]]),
      active: true,
      instanceCount: 10,
    };
    expect(shouldPruneJudge(data, "judge1", threshold)).toBe(false);
  });

  it("does not prune unknown judge", () => {
    const data: JudgeQualityData = {
      ratings: [],
      weights: new Map(),
      active: true,
      instanceCount: 10,
    };
    // Unknown judge defaults to weight 1.0 → above threshold
    expect(shouldPruneJudge(data, "unknown", threshold)).toBe(false);
  });
});

// ── ELO-based judge quality ─────────────────────────

describe("ratingsToWeights", () => {
  it("anchors best at 1.0 and decays others", () => {
    const ratings: WhrRating[] = [
      { model: "a", rating: 1600, ci95: 30, wins: 6, losses: 4, ties: 0, matchCount: 10 },
      { model: "b", rating: 1500, ci95: 30, wins: 5, losses: 5, ties: 0, matchCount: 10 },
    ];
    const weights = ratingsToWeights(ratings, 0.03);
    expect(weights.get("a")).toBe(1.0);
    expect(weights.get("b")!).toBeLessThan(1.0);
    expect(weights.get("b")!).toBeGreaterThanOrEqual(MIN_JUDGE_WEIGHT);
  });

  it("returns empty map for empty ratings", () => {
    const weights = ratingsToWeights([], 0.03);
    expect(weights.size).toBe(0);
  });

  it("assigns 1.0 to all when ratings are equal", () => {
    const ratings: WhrRating[] = [
      { model: "a", rating: 1500, ci95: 30, wins: 5, losses: 5, ties: 0, matchCount: 10 },
      { model: "b", rating: 1500, ci95: 30, wins: 5, losses: 5, ties: 0, matchCount: 10 },
    ];
    const weights = ratingsToWeights(ratings, 0.03);
    expect(weights.get("a")).toBe(1.0);
    expect(weights.get("b")).toBe(1.0);
  });
});

describe("computeEloBasedJudgeQuality", () => {
  it("returns inactive with no ratings (bootstrap)", () => {
    const result = computeEloBasedJudgeQuality(
      [],
      ["judge1", "judge2"],
      DEFAULT_CONVERGENCE.judgeDecay,
    );
    expect(result.active).toBe(false);
    expect(result.weights.get("judge1")).toBe(1.0);
    expect(result.weights.get("judge2")).toBe(1.0);
  });

  it("returns inactive with only one judge in ratings", () => {
    const ratings: WhrRating[] = [
      { model: "judge1", rating: 1600, ci95: 50, wins: 5, losses: 3, ties: 2, matchCount: 10 },
    ];
    const result = computeEloBasedJudgeQuality(
      ratings,
      ["judge1", "judge2"],
      DEFAULT_CONVERGENCE.judgeDecay,
    );
    expect(result.active).toBe(false);
    expect(result.weights.get("judge1")).toBe(1.0);
    expect(result.weights.get("judge2")).toBe(1.0);
  });

  it("assigns higher weight to higher-rated judge", () => {
    const ratings: WhrRating[] = [
      { model: "judge1", rating: 1700, ci95: 30, wins: 8, losses: 2, ties: 0, matchCount: 10 },
      { model: "judge2", rating: 1400, ci95: 30, wins: 2, losses: 8, ties: 0, matchCount: 10 },
    ];
    const result = computeEloBasedJudgeQuality(
      ratings,
      ["judge1", "judge2"],
      DEFAULT_CONVERGENCE.judgeDecay,
    );
    expect(result.active).toBe(true);
    expect(result.weights.get("judge1")!).toBeGreaterThan(result.weights.get("judge2")!);
    expect(result.weights.get("judge1")).toBe(1.0); // best gets 1.0
  });

  it("filters ratings to only judge models", () => {
    const ratings: WhrRating[] = [
      { model: "writer-only", rating: 1800, ci95: 30, wins: 10, losses: 0, ties: 0, matchCount: 10 },
      { model: "judge1", rating: 1600, ci95: 30, wins: 6, losses: 4, ties: 0, matchCount: 10 },
      { model: "judge2", rating: 1500, ci95: 30, wins: 5, losses: 5, ties: 0, matchCount: 10 },
    ];
    const result = computeEloBasedJudgeQuality(
      ratings,
      ["judge1", "judge2"],
      DEFAULT_CONVERGENCE.judgeDecay,
    );
    expect(result.active).toBe(true);
    // "writer-only" should not affect weights
    expect(result.weights.has("writer-only")).toBe(false);
    expect(result.weights.get("judge1")).toBe(1.0); // best among judges
  });

  it("assigns weight 1.0 to judges not in ratings", () => {
    const ratings: WhrRating[] = [
      { model: "judge1", rating: 1600, ci95: 30, wins: 6, losses: 4, ties: 0, matchCount: 10 },
      { model: "judge2", rating: 1500, ci95: 30, wins: 5, losses: 5, ties: 0, matchCount: 10 },
    ];
    const result = computeEloBasedJudgeQuality(
      ratings,
      ["judge1", "judge2", "judge3"],
      DEFAULT_CONVERGENCE.judgeDecay,
    );
    // judge3 has no rating -> gets default 1.0
    expect(result.weights.get("judge3")).toBe(1.0);
  });

  it("respects decay parameter k", () => {
    const ratings: WhrRating[] = [
      { model: "judge1", rating: 1600, ci95: 30, wins: 6, losses: 4, ties: 0, matchCount: 10 },
      { model: "judge2", rating: 1400, ci95: 30, wins: 4, losses: 6, ties: 0, matchCount: 10 },
    ];
    const gentle = computeEloBasedJudgeQuality(ratings, ["judge1", "judge2"], 0.007);
    const aggressive = computeEloBasedJudgeQuality(ratings, ["judge1", "judge2"], 0.03);

    // Both should have judge1 at 1.0
    expect(gentle.weights.get("judge1")).toBe(1.0);
    expect(aggressive.weights.get("judge1")).toBe(1.0);

    // Aggressive decay should penalize judge2 more
    expect(aggressive.weights.get("judge2")!).toBeLessThan(gentle.weights.get("judge2")!);
  });

  it("sets instanceCount to 0 (not applicable for elo-based mode)", () => {
    const ratings: WhrRating[] = [
      { model: "judge1", rating: 1600, ci95: 30, wins: 6, losses: 4, ties: 0, matchCount: 10 },
      { model: "judge2", rating: 1500, ci95: 30, wins: 5, losses: 5, ties: 0, matchCount: 10 },
    ];
    const result = computeEloBasedJudgeQuality(
      ratings,
      ["judge1", "judge2"],
      DEFAULT_CONVERGENCE.judgeDecay,
    );
    expect(result.instanceCount).toBe(0);
  });

  it("no weight exceeds 1.0", () => {
    const ratings: WhrRating[] = [
      { model: "judge1", rating: 1700, ci95: 30, wins: 8, losses: 2, ties: 0, matchCount: 10 },
      { model: "judge2", rating: 1500, ci95: 30, wins: 5, losses: 5, ties: 0, matchCount: 10 },
      { model: "judge3", rating: 1300, ci95: 30, wins: 2, losses: 8, ties: 0, matchCount: 10 },
    ];
    const result = computeEloBasedJudgeQuality(
      ratings,
      ["judge1", "judge2", "judge3"],
      DEFAULT_CONVERGENCE.judgeDecay,
    );
    for (const w of result.weights.values()) {
      expect(w).toBeLessThanOrEqual(1.0);
    }
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
  };
}
