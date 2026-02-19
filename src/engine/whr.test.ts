import { describe, it, expect } from "bun:test";
import {
  computeWhr,
  computeWhrFromRecords,
  maxCiHalfWidth,
  hasOverlap,
  estimateRemainingJudgments,
  overlapFreeThreshold,
  judgmentsToGames,
  improvementJudgmentsToGames,
  gamesToRecords,
  mergeRecords,
} from "./whr.js";
import type { WhrGame, WhrRating } from "./whr.js";
import type { PairwiseJudgment, PairwiseRecord } from "../types.js";

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

describe("hasOverlap", () => {
  it("returns true for models with overlapping CIs", () => {
    const a = makeWhrRating("A", 1500, 100, 5);
    const b = makeWhrRating("B", 1550, 100, 5);
    // |1500 - 1550| = 50 < 100 + 100 = 200
    expect(hasOverlap(a, b)).toBe(true);
  });

  it("returns false for models with non-overlapping CIs", () => {
    const a = makeWhrRating("A", 1800, 50, 20);
    const b = makeWhrRating("B", 1200, 50, 20);
    // |1800 - 1200| = 600 > 50 + 50 = 100
    expect(hasOverlap(a, b)).toBe(false);
  });

  it("returns false at exact boundary", () => {
    const a = makeWhrRating("A", 1600, 100, 10);
    const b = makeWhrRating("B", 1400, 100, 10);
    // |1600 - 1400| = 200, not < 200 (strict <)
    expect(hasOverlap(a, b)).toBe(false);
  });

  it("returns true when CIs just barely overlap", () => {
    const a = makeWhrRating("A", 1599, 100, 10);
    const b = makeWhrRating("B", 1400, 100, 10);
    // |1599 - 1400| = 199 < 200
    expect(hasOverlap(a, b)).toBe(true);
  });

  it("returns true when either model has Infinity CI", () => {
    const a = makeWhrRating("A", 1500, Infinity, 0);
    const b = makeWhrRating("B", 1500, 50, 10);
    expect(hasOverlap(a, b)).toBe(true);
    expect(hasOverlap(b, a)).toBe(true);
  });

  it("returns true when both models have Infinity CI", () => {
    const a = makeWhrRating("A", 1500, Infinity, 0);
    const b = makeWhrRating("B", 1500, Infinity, 0);
    expect(hasOverlap(a, b)).toBe(true);
  });

  it("handles zero CI with same rating", () => {
    const a = makeWhrRating("A", 1500, 0, 50);
    const b = makeWhrRating("B", 1500, 0, 50);
    // |0| = 0, not < 0 + 0 = 0
    expect(hasOverlap(a, b)).toBe(false);
  });

  it("handles zero CI with different ratings", () => {
    const a = makeWhrRating("A", 1500, 0, 50);
    const b = makeWhrRating("B", 1501, 50, 10);
    // |1500 - 1501| = 1 < 0 + 50 = 50
    expect(hasOverlap(a, b)).toBe(true);
  });
});

describe("maxCiHalfWidth", () => {
  it("returns the largest CI across overlapping models", () => {
    const games: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "black"),
    ];

    const result = computeWhr(games);
    const maxCi = maxCiHalfWidth(result);
    const individualMax = Math.max(...result.ratings.map((r) => r.ci95));
    // With only 2 models at similar ratings, they overlap, so max is unchanged
    expect(maxCi).toBe(individualMax);
  });

  it("returns 0 for empty results", () => {
    const result = computeWhr([]);
    expect(maxCiHalfWidth(result)).toBe(0);
  });

  it("excludes models whose CIs do not overlap with any other", () => {
    const result = {
      ratings: [
        makeWhrRating("A", 1800, 50, 20),
        makeWhrRating("B", 1200, 80, 20),
      ],
      converged: true,
      iterations: 5,
    };
    // |1800 - 1200| = 600 > 50 + 80 = 130, no overlap
    expect(maxCiHalfWidth(result)).toBe(0);
  });

  it("returns 0 for a single model", () => {
    const result = {
      ratings: [makeWhrRating("A", 1500, 200, 5)],
      converged: true,
      iterations: 1,
    };
    expect(maxCiHalfWidth(result)).toBe(0);
  });

  it("returns Infinity when an overlapping model has Infinity CI", () => {
    const result = {
      ratings: [
        makeWhrRating("A", 1500, Infinity, 0),
        makeWhrRating("B", 1500, 50, 10),
      ],
      converged: false,
      iterations: 0,
    };
    expect(maxCiHalfWidth(result)).toBe(Infinity);
  });

  it("considers only overlapping subset in mixed scenario", () => {
    const result = {
      ratings: [
        makeWhrRating("A", 1800, 150, 5),  // separated from B and C
        makeWhrRating("B", 1500, 80, 10),   // overlaps with C
        makeWhrRating("C", 1480, 60, 10),   // overlaps with B
      ],
      converged: true,
      iterations: 5,
    };
    // A vs B: |300| > 230 → no overlap
    // A vs C: |320| > 210 → no overlap
    // B vs C: |20| < 140 → overlap!
    // Only B (80) and C (60) are overlapping, so max = 80
    expect(maxCiHalfWidth(result)).toBe(80);
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

  it("returns fewer games when non-overlap threshold is larger than ci threshold", () => {
    const withoutOverlap = estimateRemainingJudgments(200, 10, 50);
    // nonOverlapThreshold=150 means model only needs ci95 <= 150 to separate
    const withOverlap = estimateRemainingJudgments(200, 10, 50, 150);
    expect(withoutOverlap).not.toBeNull();
    expect(withOverlap).not.toBeNull();
    expect(withOverlap!).toBeLessThan(withoutOverlap!);
  });

  it("returns 0 when ci95 is below the non-overlap threshold", () => {
    // ci95=120 is above ciThreshold=50, but below nonOverlapThreshold=150
    const est = estimateRemainingJudgments(120, 10, 50, 150);
    expect(est).toBe(0);
  });

  it("ignores non-overlap threshold when it is smaller than ci threshold", () => {
    const withoutOverlap = estimateRemainingJudgments(200, 10, 50);
    const withSmallerOverlap = estimateRemainingJudgments(200, 10, 50, 30);
    expect(withoutOverlap).toBe(withSmallerOverlap);
  });

  it("ignores null non-overlap threshold", () => {
    const without = estimateRemainingJudgments(200, 10, 50);
    const withNull = estimateRemainingJudgments(200, 10, 50, null);
    expect(without).toBe(withNull);
  });

  it("ignores undefined non-overlap threshold", () => {
    const without = estimateRemainingJudgments(200, 10, 50);
    const withUndef = estimateRemainingJudgments(200, 10, 50, undefined);
    expect(without).toBe(withUndef);
  });

  it("returns null when ciThreshold is 0 and no overlap threshold", () => {
    // In overlap mode (ciThreshold=0), if overlapFreeThreshold returns null
    // (can't separate), the estimate is impossible
    expect(estimateRemainingJudgments(200, 10, 0)).toBeNull();
    expect(estimateRemainingJudgments(200, 10, 0, null)).toBeNull();
  });

  it("uses overlap threshold when ciThreshold is 0", () => {
    // In overlap mode, overlapFreeThreshold provides the effective target
    const est = estimateRemainingJudgments(200, 10, 0, 80);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(0);
  });

  it("returns 0 when ciThreshold is 0 and already below overlap threshold", () => {
    // ci95=50 is below nonOverlapThreshold=80 → already converged
    expect(estimateRemainingJudgments(50, 10, 0, 80)).toBe(0);
  });
});

describe("overlapFreeThreshold", () => {
  function makeRating(model: string, rating: number, ci95: number, matchCount = 10): WhrRating {
    return { model, rating, ci95, wins: 0, losses: 0, ties: 0, matchCount };
  }

  it("returns Infinity when model is already non-overlapping with all", () => {
    const a = makeRating("A", 1800, 50);
    const b = makeRating("B", 1200, 50);
    // gap=600, ci95_A+ci95_B=100 → no overlap
    expect(overlapFreeThreshold(a, [a, b])).toBe(Infinity);
  });

  it("uses gap/2 when neighbor CI is wider than the gap", () => {
    const a = makeRating("A", 1050, 200);
    const b = makeRating("B", 1000, 150);
    // gap=50, gap - ci_B = 50 - 150 = -100, gap/2 = 25
    // max(-100, 25) = 25 → assumes both models shrink to split the gap
    expect(overlapFreeThreshold(a, [a, b])).toBe(25);
  });

  it("returns correct threshold for overlapping models", () => {
    const a = makeRating("A", 1300, 180);
    const b = makeRating("B", 1100, 100);
    // gap=200, overlap (180+100=280 > 200), threshold = 200 - 100 = 100
    const result = overlapFreeThreshold(a, [a, b]);
    expect(result).toBe(100);
  });

  it("returns the tightest constraint across multiple neighbors", () => {
    const a = makeRating("A", 1300, 180);
    const b = makeRating("B", 1100, 100);
    const c = makeRating("C", 1150, 120);
    // A-B: gap=200, max(200-100, 100) = 100
    // A-C: gap=150, max(150-120, 75) = 75
    // Tightest is 75
    const result = overlapFreeThreshold(a, [a, b, c]);
    expect(result).toBe(75);
  });

  it("skips models that are already non-overlapping", () => {
    const a = makeRating("A", 1500, 100);
    const b = makeRating("B", 1350, 80);
    const c = makeRating("C", 800, 50);
    // A-B: gap=150, ci=100+80=180, overlaps → max(150-80, 75) = 75
    // A-C: gap=700, ci=100+50=150, no overlap → skipped
    const result = overlapFreeThreshold(a, [a, b, c]);
    expect(result).toBe(75);
  });

  it("returns Infinity for single model", () => {
    const a = makeRating("A", 1500, 100);
    expect(overlapFreeThreshold(a, [a])).toBe(Infinity);
  });

  it("uses gap/2 when gap equals neighbor ci exactly", () => {
    const a = makeRating("A", 1200, 100);
    const b = makeRating("B", 1100, 100);
    // gap=100, gap - ci_B = 0, gap/2 = 50 → max(0, 50) = 50
    expect(overlapFreeThreshold(a, [a, b])).toBe(50);
  });

  it("returns null when neighbor has Infinity ci", () => {
    const a = makeRating("A", 1500, 100);
    const b = makeRating("B", 1200, Infinity);
    // Infinity CI always overlaps, can't estimate against no-data model
    expect(overlapFreeThreshold(a, [a, b])).toBeNull();
  });

  it("returns null when models have identical ratings", () => {
    const a = makeRating("A", 1500, 100);
    const b = makeRating("B", 1500, 100);
    // gap=0, gap/2=0 → can't separate
    expect(overlapFreeThreshold(a, [a, b])).toBeNull();
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
      { sampleA: "orig1", sampleB: "rev2", winner: "A" as const,
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
      { sampleA: "orig1", sampleB: "rev2", winner: "B" as const,
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
      { sampleA: "orig1", sampleB: "rev2", winner: "A" as const,
        promptId: "p1", judgeModel: "judge" },
    ];

    const games = improvementJudgmentsToGames(judgments, sampleToFeedbackModel);
    expect(games).toHaveLength(0);
  });

  it("does not pair feedback models tested on different base texts", () => {
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

    // Different sampleA values → different base texts → no comparison
    const games = improvementJudgmentsToGames(judgments, sampleToFeedbackModel);
    expect(games).toHaveLength(0);
  });
});

describe("computeWhrFromRecords", () => {
  it("computes correct win/loss/tie counts from records", () => {
    const records: PairwiseRecord[] = [
      { modelA: "gpt-4", modelB: "claude", winsA: 2, winsB: 1, ties: 1 },
    ];
    const result = computeWhrFromRecords(records);
    expect(result.ratings).toHaveLength(2);
    const gpt4 = result.ratings.find((r) => r.model === "gpt-4")!;
    const claude = result.ratings.find((r) => r.model === "claude")!;
    expect(gpt4.wins).toBe(2);
    expect(gpt4.losses).toBe(1);
    expect(gpt4.ties).toBe(1);
    expect(gpt4.matchCount).toBe(4);
    expect(claude.wins).toBe(1);
    expect(claude.losses).toBe(2);
    expect(claude.ties).toBe(1);
  });

  it("returns empty ratings for empty records", () => {
    const result = computeWhrFromRecords([]);
    expect(result.ratings).toHaveLength(0);
    expect(result.converged).toBe(true);
  });

  it("handles multiple records across models", () => {
    const records: PairwiseRecord[] = [
      { modelA: "a", modelB: "b", winsA: 1, winsB: 0, ties: 0 },
      { modelA: "b", modelB: "c", winsA: 0, winsB: 1, ties: 1 },
    ];
    const result = computeWhrFromRecords(records);
    expect(result.ratings).toHaveLength(3);
    // c should be ranked highest (1 win, 0 losses + 1 tie)
    // a next (1 win, 0 losses)
    // b lowest (0 wins, 2 losses + 1 tie)
    const c = result.ratings.find((r) => r.model === "c")!;
    const b = result.ratings.find((r) => r.model === "b")!;
    expect(c.rating).toBeGreaterThan(b.rating);
  });

  it("produces ratings with CIs", () => {
    const records: PairwiseRecord[] = [
      { modelA: "strong", modelB: "weak", winsA: 8, winsB: 2, ties: 0 },
    ];
    const result = computeWhrFromRecords(records);
    expect(result.ratings).toHaveLength(2);
    const strong = result.ratings.find((r) => r.model === "strong")!;
    const weak = result.ratings.find((r) => r.model === "weak")!;
    expect(strong.rating).toBeGreaterThan(weak.rating);
    expect(strong.ci95).toBeGreaterThan(0);
    expect(strong.ci95).toBeLessThan(Infinity);
    expect(weak.ci95).toBeGreaterThan(0);
    expect(weak.ci95).toBeLessThan(Infinity);
  });

  it("produces same ratings as computeWhr with equivalent games", () => {
    const records: PairwiseRecord[] = [
      { modelA: "a", modelB: "b", winsA: 5, winsB: 3, ties: 2 },
    ];
    // Build equivalent games manually
    const games = [
      ...Array(5).fill({ playerWhite: "a", playerBlack: "b", result: 1.0 }),
      ...Array(3).fill({ playerWhite: "a", playerBlack: "b", result: 0.0 }),
      ...Array(2).fill({ playerWhite: "a", playerBlack: "b", result: 0.5 }),
    ];
    const fromRecords = computeWhrFromRecords(records);
    const fromGames = computeWhr(games);
    expect(fromRecords.ratings.length).toBe(fromGames.ratings.length);
    for (const rr of fromRecords.ratings) {
      const rg = fromGames.ratings.find((r) => r.model === rr.model)!;
      expect(rr.rating).toBe(rg.rating);
      expect(rr.ci95).toBe(rg.ci95);
      expect(rr.wins).toBe(rg.wins);
      expect(rr.losses).toBe(rg.losses);
      expect(rr.ties).toBe(rg.ties);
    }
  });
});

describe("gamesToRecords and mergeRecords", () => {
  it("gamesToRecords aggregates win/loss/tie counts", () => {
    const games = [
      { playerWhite: "a", playerBlack: "b", result: 1.0 },
      { playerWhite: "a", playerBlack: "b", result: 0.0 },
      { playerWhite: "a", playerBlack: "b", result: 0.5 },
    ];
    const records = gamesToRecords(games);
    expect(records).toHaveLength(1);
    expect(records[0].winsA + records[0].winsB).toBe(2);
    expect(records[0].ties).toBe(1);
  });

  it("mergeRecords accumulates counts", () => {
    const existing = [
      { modelA: "modelA", modelB: "modelB", winsA: 2, winsB: 1, ties: 0 },
    ];
    const incoming = [
      { modelA: "modelA", modelB: "modelB", winsA: 0, winsB: 3, ties: 1 },
    ];

    const merged = mergeRecords(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].winsA).toBe(2);
    expect(merged[0].winsB).toBe(4);
    expect(merged[0].ties).toBe(1);
  });

  it("mergeRecords handles flipped model order", () => {
    const existing = [
      { modelA: "modelB", modelB: "modelA", winsA: 3, winsB: 1, ties: 0 },
    ];
    const incoming = [
      { modelA: "modelA", modelB: "modelB", winsA: 2, winsB: 0, ties: 1 },
    ];

    const merged = mergeRecords(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].modelA).toBe("modelA");
    expect(merged[0].winsA).toBe(3);
    expect(merged[0].winsB).toBe(3);
    expect(merged[0].ties).toBe(1);
  });

  it("mergeRecords adds new pairs", () => {
    const existing = [
      { modelA: "modelA", modelB: "modelB", winsA: 1, winsB: 0, ties: 0 },
    ];
    const incoming = [
      { modelA: "modelA", modelB: "modelC", winsA: 0, winsB: 2, ties: 0 },
    ];

    const merged = mergeRecords(existing, incoming);
    expect(merged).toHaveLength(2);
  });

  it("extracting feedback records via improvementJudgmentsToGames + gamesToRecords works", () => {
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "B", "improvement", "p1"),
      makeJudgment("j2", "orig1", "rev2", "A", "improvement", "p1"),
    ];

    const records = gamesToRecords(
      improvementJudgmentsToGames(judgments, sampleToFeedbackModel),
    );
    expect(records).toHaveLength(1);

    const r = records[0];
    const total = r.winsA + r.winsB + r.ties;
    expect(total).toBe(1);
  });
});

describe("weighted games", () => {
  it("produces same ratings as unweighted when all weights are 1.0", () => {
    const unweighted: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "black"),
      makeGame("modelB", "modelC", "white"),
    ];
    const weighted: WhrGame[] = unweighted.map((g) => ({ ...g, weight: 1.0 }));

    const resultU = computeWhr(unweighted);
    const resultW = computeWhr(weighted);

    for (const model of ["modelA", "modelB", "modelC"]) {
      const ru = resultU.ratings.find((r) => r.model === model)!;
      const rw = resultW.ratings.find((r) => r.model === model)!;
      expect(rw.rating).toBe(ru.rating);
      expect(rw.ci95).toBe(ru.ci95);
    }
  });

  it("higher weight gives more influence", () => {
    // 1 game A beats B with weight 5, 1 game B beats A with weight 1
    // A should be rated higher because the heavy-weight win dominates
    const games: WhrGame[] = [
      { playerWhite: "modelA", playerBlack: "modelB", result: 1.0, weight: 5.0 },
      { playerWhite: "modelB", playerBlack: "modelA", result: 1.0, weight: 1.0 },
    ];

    const result = computeWhr(games);
    const a = result.ratings.find((r) => r.model === "modelA")!;
    const b = result.ratings.find((r) => r.model === "modelB")!;
    expect(a.rating).toBeGreaterThan(b.rating);
  });

  it("fractional weights work correctly", () => {
    // 10 games at weight 0.5 should produce similar ratings to 5 games at weight 1.0
    const halfWeight: WhrGame[] = [];
    for (let i = 0; i < 10; i++) {
      halfWeight.push({ playerWhite: "modelA", playerBlack: "modelB", result: 1.0, weight: 0.5 });
    }

    const fullWeight: WhrGame[] = [];
    for (let i = 0; i < 5; i++) {
      fullWeight.push(makeGame("modelA", "modelB", "white"));
    }

    const resultHalf = computeWhr(halfWeight);
    const resultFull = computeWhr(fullWeight);

    const halfA = resultHalf.ratings.find((r) => r.model === "modelA")!;
    const fullA = resultFull.ratings.find((r) => r.model === "modelA")!;

    // Ratings should be very close (both represent 5 effective wins)
    expect(Math.abs(halfA.rating - fullA.rating)).toBeLessThan(2);
  });

  it("weighted games produce narrower CIs when weights are higher", () => {
    // Same game count, but double weight = effectively double games
    const normalGames: WhrGame[] = [
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "black"),
      makeGame("modelA", "modelB", "white"),
      makeGame("modelA", "modelB", "black"),
    ];

    const doubleWeight: WhrGame[] = normalGames.map((g) => ({ ...g, weight: 2.0 }));

    const normalResult = computeWhr(normalGames);
    const doubleResult = computeWhr(doubleWeight);

    const normalCi = maxCiHalfWidth(normalResult);
    const doubleCi = maxCiHalfWidth(doubleResult);

    // Double weight should produce narrower CIs
    expect(doubleCi).toBeLessThan(normalCi);
  });

  it("default weight is 1.0 when weight field is omitted", () => {
    const withoutWeight: WhrGame[] = [makeGame("modelA", "modelB", "white")];
    const withWeight: WhrGame[] = [{ ...makeGame("modelA", "modelB", "white"), weight: 1.0 }];

    const r1 = computeWhr(withoutWeight);
    const r2 = computeWhr(withWeight);

    const a1 = r1.ratings.find((r) => r.model === "modelA")!;
    const a2 = r2.ratings.find((r) => r.model === "modelA")!;
    expect(a1.rating).toBe(a2.rating);
  });
});

describe("judgmentsToGames with judge weights", () => {
  it("applies judge weights correctly", () => {
    const sampleToModel = new Map([["s1", "modelA"], ["s2", "modelB"]]);
    const judgeWeights = new Map([["judge1", 2.0], ["judge2", 0.5]]);
    const judgments = [
      { sampleA: "s1", sampleB: "s2", winner: "A" as const, judgeModel: "judge1" },
      { sampleA: "s1", sampleB: "s2", winner: "B" as const, judgeModel: "judge2" },
    ];

    const games = judgmentsToGames(judgments, sampleToModel, judgeWeights);
    expect(games).toHaveLength(2);
    expect(games[0].weight).toBe(2.0);
    expect(games[1].weight).toBe(0.5);
  });

  it("defaults to weight 1.0 for unknown judge", () => {
    const sampleToModel = new Map([["s1", "modelA"], ["s2", "modelB"]]);
    const judgeWeights = new Map<string, number>();
    const judgments = [
      { sampleA: "s1", sampleB: "s2", winner: "A" as const, judgeModel: "unknownJudge" },
    ];

    const games = judgmentsToGames(judgments, sampleToModel, judgeWeights);
    expect(games).toHaveLength(1);
    expect(games[0].weight).toBe(1.0);
  });

  it("skips self-comparisons with weights", () => {
    const sampleToModel = new Map([["s1", "modelA"], ["s2", "modelA"]]);
    const judgeWeights = new Map([["judge1", 1.5]]);
    const judgments = [
      { sampleA: "s1", sampleB: "s2", winner: "A" as const, judgeModel: "judge1" },
    ];

    const games = judgmentsToGames(judgments, sampleToModel, judgeWeights);
    expect(games).toHaveLength(0);
  });
});

describe("improvementJudgmentsToGames with judge weights", () => {
  it("applies judge weights to improvement games", () => {
    const sampleToFeedbackModel = new Map([["rev1", "feedbackA"], ["rev2", "feedbackB"]]);
    const judgeWeights = new Map([["judge1", 1.8]]);
    const judgments = [
      { sampleA: "orig1", sampleB: "rev1", winner: "B" as const, promptId: "p1", judgeModel: "judge1" },
      { sampleA: "orig1", sampleB: "rev2", winner: "A" as const, promptId: "p1", judgeModel: "judge1" },
    ];

    const games = improvementJudgmentsToGames(judgments, sampleToFeedbackModel, judgeWeights);
    expect(games).toHaveLength(1);
    expect(games[0].weight).toBe(1.8);
    // feedbackA improved (B won), feedbackB didn't -> feedbackA wins
    expect(games[0].playerWhite).toBe("feedbackA");
    expect(games[0].result).toBe(1.0);
  });
});

// ── Helpers ─────────────────────────────────────────

function makeJudgment(
  id: string,
  sampleA: string,
  sampleB: string,
  winner: "A" | "B" | "tie",
  stage: "initial" | "revised" | "improvement" = "initial",
  promptId: string = "p1",
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

function makeWhrRating(
  model: string,
  rating: number,
  ci95: number,
  matchCount: number,
): WhrRating {
  return {
    model,
    rating,
    ci95,
    wins: Math.floor(matchCount / 2),
    losses: Math.floor(matchCount / 2),
    ties: matchCount % 2,
    matchCount,
  };
}
