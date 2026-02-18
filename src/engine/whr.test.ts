import { describe, it, expect } from "bun:test";
import {
  computeWhr,
  maxCiHalfWidth,
  estimateRemainingJudgments,
  judgmentsToGames,
  improvementJudgmentsToGames,
} from "./whr.js";
import type { WhrGame } from "./whr.js";

describe("computeWhr", () => {
  it("returns default ratings for empty game list", () => {
    const result = computeWhr([]);
    expect(result.ratings).toHaveLength(0);
    expect(result.converged).toBe(true);
  });

  it("returns default ratings when all games are self-comparisons", () => {
    const games: WhrGame[] = [
      makeGame("modelA", "modelA", "white"),
      makeGame("modelA", "modelA", "black"),
    ];
    // Self-comparisons are skipped, so effectively no games
    const result = computeWhr(games);
    expect(result.ratings).toHaveLength(1);
    expect(result.ratings[0].rating).toBe(1500);
    expect(result.ratings[0].matchCount).toBe(0);
  });

  it("rates the dominant model higher when one model always wins", () => {
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "white"),
    ];

    const result = computeWhr(games);
    const a = result.ratings.find((r) => r.model === "modelA")!;
    const b = result.ratings.find((r) => r.model === "modelB")!;

    expect(a.rating).toBeGreaterThan(1500);
    expect(b.rating).toBeLessThan(1500);
    expect(a.wins).toBe(3);
    expect(b.losses).toBe(3);
  });

  it("produces equal ratings for all ties", () => {
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "tie"),
      makeGame("modelA", "modelB", "tie"),
      makeGame("modelA", "modelB", "tie"),
    ];

    const result = computeWhr(games);
    const a = result.ratings.find((r) => r.model === "modelA")!;
    const b = result.ratings.find((r) => r.model === "modelB")!;

    expect(a.rating).toBe(b.rating);
    expect(a.ties).toBe(3);
    expect(b.ties).toBe(3);
  });

  it("produces identical ratings regardless of game order", () => {
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelB", "modelC", "black"),
      makeGame("modelA", "modelC", "white"),
      makeGame("modelA", "modelB", "black"),
      makeGame("modelB", "modelC", "white"),
    ];

    const forward = computeWhr(games);
    const reversed = computeWhr([...games].reverse());
    const shuffled = computeWhr(
      [games[3], games[0], games[4], games[2], games[1]],
    );

    for (const model of ["modelA", "modelB", "modelC"]) {
      const fwd = forward.ratings.find((r) => r.model === model)!;
      const rev = reversed.ratings.find((r) => r.model === model)!;
      const shf = shuffled.ratings.find((r) => r.model === model)!;
      expect(fwd.rating).toBe(rev.rating);
      expect(fwd.rating).toBe(shf.rating);
      expect(fwd.wins).toBe(rev.wins);
      expect(fwd.losses).toBe(rev.losses);
      expect(fwd.ties).toBe(rev.ties);
    }
  });

  it("handles 2-model case with known analytical solution", () => {
    // With A beating B 3 times and 0 losses, the BT MLE strength
    // ratio is 3:0 which diverges, but the Bayesian prior regularizes.
    // With σ²=0.25 the prior pulls ratings toward center more, so the
    // gap is smaller than with σ²=1. The key check is that A >> B.
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "white"),
    ];

    const result = computeWhr(games);
    const a = result.ratings.find((r) => r.model === "modelA")!;
    const b = result.ratings.find((r) => r.model === "modelB")!;

    expect(a.rating - b.rating).toBeGreaterThan(50);
    expect(result.converged).toBe(true);
  });

  it("handles 3+ models with transitive dominance", () => {
    // A always beats B, B always beats C
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "white"),
      makeGame("modelB", "modelC", "white"),
      makeGame("modelB", "modelC", "white"),
      makeGame("modelA", "modelC", "white"),
    ];

    const result = computeWhr(games);
    const a = result.ratings.find((r) => r.model === "modelA")!;
    const b = result.ratings.find((r) => r.model === "modelB")!;
    const c = result.ratings.find((r) => r.model === "modelC")!;

    expect(a.rating).toBeGreaterThan(b.rating);
    expect(b.rating).toBeGreaterThan(c.rating);
  });

  it("converges within max iterations for adversarial input", () => {
    // Very lopsided: 20-0 to stress numerical stability
    const games: WhrGame[] = [];
    for (let i = 0; i < 20; i++) {
      games.push(makeGame("modelA", "modelB", "white"));
    }

    const result = computeWhr(games);
    expect(result.converged).toBe(true);
    const a = result.ratings.find((r) => r.model === "modelA")!;
    const b = result.ratings.find((r) => r.model === "modelB")!;
    expect(a.rating).toBeGreaterThan(b.rating);
  });

  it("handles single model gracefully", () => {
    // Games list mentions only one model (via self-play, which is skipped)
    const games: WhrGame[] = [
      makeGame("modelA", "modelA", "white"),
    ];
    const result = computeWhr(games);
    expect(result.ratings).toHaveLength(1);
    expect(result.ratings[0].rating).toBe(1500);
  });

  it("handles model that only ties", () => {
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "white"),
      makeGame("modelB", "modelC", "tie"),
      makeGame("modelB", "modelC", "tie"),
      makeGame("modelB", "modelC", "tie"),
    ];

    const result = computeWhr(games);
    const b = result.ratings.find((r) => r.model === "modelB")!;
    const c = result.ratings.find((r) => r.model === "modelC")!;

    // B and C only tie each other, so they should have the same rating
    // (B also loses to A, so B < A, but B == C from their matchups)
    expect(b.ties).toBe(3);
    expect(c.ties).toBe(3);
  });

  it("handles disconnected model pairs", () => {
    // A vs B games, C vs D games, no cross-group
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "white"),
      makeGame("modelC", "modelD", "white"),
      makeGame("modelC", "modelD", "white"),
    ];

    const result = computeWhr(games);
    expect(result.ratings).toHaveLength(4);
    // All models should have ratings, even if disconnected
    for (const r of result.ratings) {
      expect(r.matchCount).toBeGreaterThan(0);
    }
  });
});

describe("confidence intervals", () => {
  it("returns prior-width CI for models with no games", () => {
    // A model with only self-play (which is skipped) has no game data.
    // With Bayesian regularization, CI comes from the prior, not infinity.
    const result = computeWhr([makeGame("modelA", "modelA", "white")]);
    // CI should be finite (from the prior) and large
    expect(result.ratings[0].ci95).toBeGreaterThan(100);
    expect(result.ratings[0].ci95).toBeLessThan(Infinity);
  });

  it("returns narrower CI with more games", () => {
    const fewGames: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "black"),
      makeGame("modelA", "modelB", "white"),
    ];

    const manyGames: WhrGame[] = [];
    for (let i = 0; i < 30; i++) {
      manyGames.push(makeGame("modelA", "modelB", i % 3 === 0 ? "black" : "white"));
    }

    const fewResult = computeWhr(fewGames);
    const manyResult = computeWhr(manyGames);

    const fewCi = maxCiHalfWidth(fewResult);
    const manyCi = maxCiHalfWidth(manyResult);

    expect(manyCi).toBeLessThan(fewCi);
  });

  it("ci95 is symmetric for symmetric results", () => {
    const games: WhrGame[] = [];
    for (let i = 0; i < 5; i++) {
      games.push(makeGame("modelA", "modelB", "white"));
      games.push(makeGame("modelA", "modelB", "black"));
    }

    const result = computeWhr(games);
    const a = result.ratings.find((r) => r.model === "modelA")!;
    const b = result.ratings.find((r) => r.model === "modelB")!;

    expect(a.ci95).toBe(b.ci95);
  });

  it("ci95 values are finite and positive for models with games", () => {
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "black"),
      makeGame("modelB", "modelC", "white"),
      makeGame("modelA", "modelC", "white"),
    ];

    const result = computeWhr(games);
    for (const r of result.ratings) {
      expect(r.ci95).toBeGreaterThan(0);
      expect(r.ci95).toBeLessThan(Infinity);
    }
  });
});

describe("maxCiHalfWidth", () => {
  it("returns the largest CI across all models", () => {
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "black"),
    ];

    const result = computeWhr(games);
    const maxCi = maxCiHalfWidth(result);
    const individualMax = Math.max(...result.ratings.map((r) => r.ci95));
    expect(maxCi).toBe(individualMax);
  });

  it("returns 0 for empty results", () => {
    const result = computeWhr([]);
    expect(maxCiHalfWidth(result)).toBe(0);
  });
});

describe("estimateRemainingJudgments", () => {
  it("returns 0 for already converged model", () => {
    expect(estimateRemainingJudgments(30, 20, 50)).toBe(0);
  });

  it("returns 0 when ci95 exactly equals threshold", () => {
    expect(estimateRemainingJudgments(50, 15, 50)).toBe(0);
  });

  it("returns null for infinite ci95", () => {
    expect(estimateRemainingJudgments(Infinity, 0, 50)).toBeNull();
  });

  it("returns null for zero matchCount", () => {
    expect(estimateRemainingJudgments(100, 0, 50)).toBeNull();
  });

  it("returns null for negative ci95", () => {
    expect(estimateRemainingJudgments(-5, 10, 50)).toBeNull();
  });

  it("returns a positive integer for unconverged model", () => {
    const est = estimateRemainingJudgments(120, 10, 50);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(0);
    expect(Number.isInteger(est)).toBe(true);
  });

  it("uses theoretical fallback for low matchCount", () => {
    const est1 = estimateRemainingJudgments(120, 1, 50);
    const est2 = estimateRemainingJudgments(120, 2, 50);
    // Both should use 0.25 theoretical, so same estimate
    expect(est1).toBe(est2);
  });

  it("estimates more games for larger ci gap", () => {
    const estSmallGap = estimateRemainingJudgments(80, 15, 50);
    const estLargeGap = estimateRemainingJudgments(200, 15, 50);
    expect(estSmallGap).not.toBeNull();
    expect(estLargeGap).not.toBeNull();
    expect(estLargeGap!).toBeGreaterThan(estSmallGap!);
  });

  it("handles edge case of ci95 just barely above threshold", () => {
    const est = estimateRemainingJudgments(50.001, 20, 50);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThanOrEqual(0);
  });
});

describe("tie handling", () => {
  it("treats ties as half-win for each side", () => {
    const games: WhrGame[] = [];
    for (let i = 0; i < 10; i++) {
      games.push(makeGame("modelA", "modelB", "tie"));
    }

    const result = computeWhr(games);
    const a = result.ratings.find((r) => r.model === "modelA")!;
    const b = result.ratings.find((r) => r.model === "modelB")!;

    // Equal ties should produce equal ratings
    expect(a.rating).toBe(b.rating);
    expect(a.rating).toBe(1500);
  });

  it("mixed wins and ties produce correct relative rankings", () => {
    // A beats B 5 times, ties 5 times
    const mixedGames: WhrGame[] = [];
    for (let i = 0; i < 5; i++) {
      mixedGames.push(makeGame("modelA", "modelB", "white"));
      mixedGames.push(makeGame("modelA", "modelB", "tie"));
    }

    // A beats B 10 times (no ties)
    const allWinGames: WhrGame[] = [];
    for (let i = 0; i < 10; i++) {
      allWinGames.push(makeGame("modelA", "modelB", "white"));
    }

    const mixedResult = computeWhr(mixedGames);
    const allWinResult = computeWhr(allWinGames);

    const mixedA = mixedResult.ratings.find((r) => r.model === "modelA")!;
    const allWinA = allWinResult.ratings.find((r) => r.model === "modelA")!;

    // Mixed result should have a smaller gap than all wins
    expect(mixedA.rating).toBeGreaterThan(1500);
    expect(allWinA.rating).toBeGreaterThan(mixedA.rating);
  });
});

describe("judgmentsToGames", () => {
  it("converts judgments to games correctly", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
      ["s2", "modelB"],
    ]);
    const judgments = [
      { sampleA: "s1", sampleB: "s2", winner: "A" as const },
      { sampleA: "s1", sampleB: "s2", winner: "B" as const },
      { sampleA: "s1", sampleB: "s2", winner: "tie" as const },
    ];

    const games = judgmentsToGames(judgments, sampleToModel);
    expect(games).toHaveLength(3);
    expect(games[0].result).toBe(1.0);
    expect(games[1].result).toBe(0.0);
    expect(games[2].result).toBe(0.5);
  });

  it("skips self-comparisons", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
      ["s2", "modelA"],
    ]);
    const judgments = [
      { sampleA: "s1", sampleB: "s2", winner: "A" as const },
    ];

    const games = judgmentsToGames(judgments, sampleToModel);
    expect(games).toHaveLength(0);
  });

  it("skips unknown samples", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
    ]);
    const judgments = [
      { sampleA: "s1", sampleB: "s999", winner: "A" as const },
    ];

    const games = judgmentsToGames(judgments, sampleToModel);
    expect(games).toHaveLength(0);
  });
});

describe("improvementJudgmentsToGames", () => {
  it("credits feedback model whose revision beat the original", () => {
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
    ]);
    const judgments = [
      { sampleA: "orig1", sampleB: "rev1", winner: "B" as const,
        promptId: "p1", judgeModel: "judge" },
      { sampleA: "orig2", sampleB: "rev2", winner: "A" as const,
        promptId: "p1", judgeModel: "judge" },
    ];

    const games = improvementJudgmentsToGames(judgments, sampleToFeedbackModel);
    expect(games).toHaveLength(1);
    // feedbackA improved (B won), feedbackB didn't → feedbackA wins
    expect(games[0].playerWhite).toBe("feedbackA");
    expect(games[0].result).toBe(1.0);
  });

  it("ties when both revisions beat the original", () => {
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
    ]);
    const judgments = [
      { sampleA: "orig1", sampleB: "rev1", winner: "B" as const,
        promptId: "p1", judgeModel: "judge" },
      { sampleA: "orig2", sampleB: "rev2", winner: "B" as const,
        promptId: "p1", judgeModel: "judge" },
    ];

    const games = improvementJudgmentsToGames(judgments, sampleToFeedbackModel);
    expect(games).toHaveLength(1);
    expect(games[0].result).toBe(0.5); // tie
  });

  it("skips same feedback model comparisons", () => {
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackA"],
    ]);
    const judgments = [
      { sampleA: "orig1", sampleB: "rev1", winner: "B" as const,
        promptId: "p1", judgeModel: "judge" },
      { sampleA: "orig2", sampleB: "rev2", winner: "A" as const,
        promptId: "p1", judgeModel: "judge" },
    ];

    const games = improvementJudgmentsToGames(judgments, sampleToFeedbackModel);
    expect(games).toHaveLength(0);
  });
});

// ── Helper ──────────────────────────────────────────

function makeGame(
  white: string,
  black: string,
  result: "white" | "black" | "tie",
): WhrGame {
  return {
    playerWhite: white,
    playerBlack: black,
    result: result === "white" ? 1.0 : result === "black" ? 0.0 : 0.5,
  };
}
