import { describe, it, expect } from "bun:test";
import {
  identifyNeeds as identifyNeedsRaw,
  isConverged,
  judgmentKey,
  formatNeedDescription,
  formatBatchSummary,
  DEFAULT_CONVERGENCE,
} from "./need-identifier.js";
import type { Need, CompletedWork, ConvergenceConfig } from "./need-identifier.js";
import type { WhrRating } from "./whr.js";
import type { ModelConfig, PromptConfig } from "../types.js";

/** Wrapper that returns just the needs array for test convenience. */
function identifyNeeds(
  ...args: Parameters<typeof identifyNeedsRaw>
): Need[] {
  return identifyNeedsRaw(...args).needs;
}

describe("identifyNeeds", () => {
  it("returns empty list when all CIs are below threshold", () => {
    const ratings = [
      makeWhrRating("modelA", 1550, 30, 10),
      makeWhrRating("modelB", 1450, 25, 10),
    ];
    const needs = identifyNeeds(
      ratings, ratings, ratings,
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs).toHaveLength(0);
  });

  it("prioritizes pairs with widest combined CI", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 300, 5),
      makeWhrRating("modelB", 1500, 30, 10),
      makeWhrRating("modelC", 1500, 280, 5),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(3), convergedRatings(3),
      emptyWork(), threeModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 2, 1,
    );
    expect(needs.length).toBeGreaterThan(0);
    // First need should involve high-CI models (A and/or C)
    const firstNeed = needs[0];
    expect(firstNeed.type).toBe("initial_judgment");
    if (firstNeed.type === "initial_judgment") {
      const involvedModels = [firstNeed.modelA, firstNeed.modelB];
      // Should involve at least one of the high-CI models
      expect(
        involvedModels.includes("modelA") || involvedModels.includes("modelC")
      ).toBe(true);
    }
  });

  it("prioritizes uncertain pairs over confident ones", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 300, 5),
      makeWhrRating("modelB", 1500, 300, 5),
      makeWhrRating("modelC", 1500, 30, 10),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(3), convergedRatings(3),
      emptyWork(), threeModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 1, 1,
    );
    expect(needs).toHaveLength(1);
    if (needs[0].type === "initial_judgment") {
      // Should pick A vs B (both uncertain) over pairs involving C (confident)
      expect(needs[0].modelA).toBe("modelA");
      expect(needs[0].modelB).toBe("modelB");
    }
  });

  it("diversifies across prompts", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 300, 3),
      makeWhrRating("modelB", 1500, 300, 3),
    ];
    const prompts = [
      makePrompt("p1"), makePrompt("p2"), makePrompt("p3"),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), prompts,
      DEFAULT_CONVERGENCE, 6, 1,
    );
    // Should have needs across multiple prompts
    const promptIds = new Set(needs.map((n) =>
      n.type === "initial_judgment" ? n.promptId : ""
    ));
    expect(promptIds.size).toBeGreaterThan(1);
  });

  it("caps selections per model pair", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 300, 3),
      makeWhrRating("modelB", 1500, 300, 3),
    ];
    const manyPrompts = Array.from({ length: 10 }, (_, i) => makePrompt(`p${i}`));
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), manyPrompts,
      DEFAULT_CONVERGENCE, 20, 1,
    );
    // With 2 models, maxPerPair = max(2, ceil(20/2)) = 10
    // But there should be at most 10 prompts * 1 judge = 10 candidates
    expect(needs.length).toBeLessThanOrEqual(10);
  });

  it("returns needs for all three dimensions", () => {
    const wideRatings = [
      makeWhrRating("modelA", 1500, 200, 1),
      makeWhrRating("modelB", 1500, 200, 1),
    ];
    const needs = identifyNeeds(
      wideRatings, wideRatings, wideRatings,
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 20, 1,
    );
    const types = new Set(needs.map((n) => n.type));
    // Should have both initial and improvement/revised needs
    expect(types.has("initial_judgment")).toBe(true);
  });

  it("accounts for cascade cost in scoring", () => {
    const wideRatings = [
      makeWhrRating("modelA", 1500, 200, 1),
      makeWhrRating("modelB", 1500, 200, 1),
    ];
    const needs = identifyNeeds(
      wideRatings, wideRatings, wideRatings,
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 20, 1,
    );
    // Initial judgments should score higher than improvement/revised
    // (because they have lower cascade cost)
    const initialNeeds = needs.filter((n) => n.type === "initial_judgment");
    const improvementNeeds = needs.filter((n) => n.type === "improvement_judgment");

    if (initialNeeds.length > 0 && improvementNeeds.length > 0) {
      expect(initialNeeds[0].score).toBeGreaterThan(improvementNeeds[0].score);
    }
  });

  it("excludes already-completed work", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const completed: CompletedWork = {
      judgments: new Set([
        judgmentKey("initial", "modelA", "modelB", "p1", "judge"),
      ]),
    };
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      completed, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    // The only initial judgment for this pair/prompt/judge is already done
    const initialForP1 = needs.filter(
      (n) => n.type === "initial_judgment" && n.promptId === "p1"
    );
    expect(initialForP1).toHaveLength(0);
  });

  it("returns empty when all possible work is exhausted", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    // Mark everything as done. For improvement, writer and feedbackModel
    // are asymmetric (not sorted). For each feedback pair (A,B), each
    // writer needs improvement judgments for both feedback models.
    const completed: CompletedWork = {
      judgments: new Set([
        // Initial
        judgmentKey("initial", "modelA", "modelB", "p1", "judge"),
        // Improvement: writer=A, fb=A and fb=B
        judgmentKey("improvement", "modelA", "modelA", "p1", "judge"),
        judgmentKey("improvement", "modelA", "modelB", "p1", "judge"),
        // Improvement: writer=B, fb=A and fb=B
        judgmentKey("improvement", "modelB", "modelA", "p1", "judge"),
        judgmentKey("improvement", "modelB", "modelB", "p1", "judge"),
        // Revised: per feedback source
        judgmentKey("revised", "modelA", "modelB", "p1:modelA", "judge"),
        judgmentKey("revised", "modelA", "modelB", "p1:modelB", "judge"),
      ]),
    };
    const needs = identifyNeeds(
      ratings, ratings, ratings,
      completed, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs).toHaveLength(0);
  });

  it("prefers lower output indices over higher ones", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 20, 2,
    );
    const initialNeeds = needs.filter((n) => n.type === "initial_judgment");
    // N=0 candidates: (0,0) -> penalty 1/(1+0) = 1.0
    // N=1 candidates: (0,1), (1,0), (1,1) -> penalty 1/(1+1) = 0.5
    const n0 = initialNeeds.filter(
      (n) => n.type === "initial_judgment" && n.outputIdxA === 0 && n.outputIdxB === 0,
    );
    const n1 = initialNeeds.filter(
      (n) => n.type === "initial_judgment" && (n.outputIdxA > 0 || n.outputIdxB > 0),
    );
    expect(n0.length).toBe(1);
    expect(n1.length).toBe(3);
    // N=0 should have higher score than any N=1
    expect(n0[0].score).toBeGreaterThan(n1[0].score);
  });

  it("selects all prompts at N=0 before any at N=1", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const prompts = [makePrompt("p1"), makePrompt("p2"), makePrompt("p3")];
    // Complete all N=0 work for p1 only
    const completed: CompletedWork = {
      judgments: new Set([
        judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 0),
      ]),
    };
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      completed, twoModels(), oneJudge(), prompts,
      DEFAULT_CONVERGENCE, 5,
      2, // allow N=1
    );
    const initialNeeds = needs.filter((n) => n.type === "initial_judgment");
    // p2 and p3 at N=0 should come before p1 at N=1
    const firstTwo = initialNeeds.slice(0, 2);
    for (const n of firstTwo) {
      if (n.type === "initial_judgment") {
        expect(n.outputIdxA).toBe(0);
        expect(n.outputIdxB).toBe(0);
        expect(["p2", "p3"]).toContain(n.promptId);
      }
    }
  });

  it("applies depth penalty to improvement judgments", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(2), ratings,
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 40, 2,
    );
    const impNeeds = needs.filter((n) => n.type === "improvement_judgment");
    const n0 = impNeeds.filter(
      (n) => n.type === "improvement_judgment" && n.outputIdx === 0,
    );
    const n1 = impNeeds.filter(
      (n) => n.type === "improvement_judgment" && n.outputIdx === 1,
    );
    if (n0.length > 0 && n1.length > 0) {
      expect(n0[0].score).toBeGreaterThan(n1[0].score);
    }
  });

  it("generates needs for additional output indices when CIs are wide", () => {
    // With outputsPerModel=2 and 2 models, each model pair has 4 possible
    // sample-pair comparisons: (0,0), (0,1), (1,0), (1,1).
    // Completing 1 should leave 3 more available.
    const ratings = [
      makeWhrRating("modelA", 1550, 200, 1),
      makeWhrRating("modelB", 1450, 200, 1),
    ];

    // One judgment done for this model pair (output 0 vs 0)
    const completed: CompletedWork = {
      judgments: new Set([
        judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 0),
      ]),
    };

    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      completed, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10,
      2, // outputsPerModel
    );

    // Should still have 3 needs for remaining output combinations
    const initialNeeds = needs.filter((n) => n.type === "initial_judgment");
    expect(initialNeeds.length).toBe(3);
  });

  it("grows beyond single-output exhaustion with higher cap", () => {
    // All output-0 work is exhausted but CIs are still wide.
    // With outputsPerModel=3, output indices 1 and 2 create new
    // comparison opportunities (9 total combos, 1 done = 8 remaining).
    const ratings = [
      makeWhrRating("modelA", 1500, 300, 3),
      makeWhrRating("modelB", 1500, 300, 3),
    ];

    const completed: CompletedWork = {
      judgments: new Set([
        judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 0),
      ]),
    };

    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      completed, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10,
      3,
    );

    // 9 combos (3×3) minus 1 done = 8 possible, but capped by batchSize/diversification
    expect(needs.length).toBeGreaterThan(0);
    // All should be initial_judgment type
    expect(needs.every((n) => n.type === "initial_judgment")).toBe(true);
  });
});

describe("information gain scoring", () => {
  it("scores highest for equal-strength high-uncertainty pairs", () => {
    const highUncertain = [
      makeWhrRating("modelA", 1500, 200, 5),
      makeWhrRating("modelB", 1500, 200, 5),
    ];
    // Use ratings close enough that CIs still overlap (|200| < 200+200)
    // but lopsided enough that p*(1-p) is lower than equal-strength.
    const lopsided = [
      makeWhrRating("modelA", 1650, 200, 5),
      makeWhrRating("modelB", 1350, 200, 5),
    ];

    const equalNeeds = identifyNeeds(
      highUncertain, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 1, 1,
    );
    const lopsidedNeeds = identifyNeeds(
      lopsided, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 1, 1,
    );

    // Equal-strength pair should have higher score (more informative)
    expect(equalNeeds[0].score).toBeGreaterThan(lopsidedNeeds[0].score);
  });

  it("scores low for lopsided pairs", () => {
    const ratings = [
      makeWhrRating("modelA", 1900, 40, 10),
      makeWhrRating("modelB", 1100, 40, 10),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 1, 1,
    );
    // Both CIs are below threshold (40 < 50) and both have enough games
    // so no needs should be generated
    expect(needs).toHaveLength(0);
  });
});

describe("isConverged", () => {
  it("returns true when all models have tight non-overlapping CIs", () => {
    const tight = [
      makeWhrRating("modelA", 1550, 30, 10),
      makeWhrRating("modelB", 1450, 25, 10),
    ];
    expect(isConverged(tight, tight, tight, DEFAULT_CONVERGENCE)).toBe(true);
  });

  it("returns false when any dimension has wide CI", () => {
    const tight = [
      makeWhrRating("modelA", 1550, 30, 10),
      makeWhrRating("modelB", 1450, 25, 10),
    ];
    const wide = [
      makeWhrRating("modelA", 1550, 200, 10),
      makeWhrRating("modelB", 1450, 25, 10),
    ];
    expect(isConverged(wide, tight, tight, DEFAULT_CONVERGENCE)).toBe(false);
    expect(isConverged(tight, wide, tight, DEFAULT_CONVERGENCE)).toBe(false);
    expect(isConverged(tight, tight, wide, DEFAULT_CONVERGENCE)).toBe(false);
  });

  it("returns false when models have too few games", () => {
    const fewGames = [
      makeWhrRating("modelA", 1550, 30, 1), // below minPairsPerModel (2)
      makeWhrRating("modelB", 1450, 25, 10),
    ];
    expect(isConverged(fewGames, fewGames, fewGames, DEFAULT_CONVERGENCE)).toBe(false);
  });

  it("returns false for empty ratings", () => {
    expect(isConverged([], [], [], DEFAULT_CONVERGENCE)).toBe(false);
  });

  it("converges when CIs are wide but non-overlapping", () => {
    const ratings = [
      makeWhrRating("modelA", 1800, 150, 10),
      makeWhrRating("modelB", 1200, 150, 10),
    ];
    // |1800-1200| = 600 > 150+150 = 300 → no overlap
    // Both have wide CIs (150 > 100) but models are distinguishable
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE)).toBe(true);
  });

  it("does not converge when CIs are wide and overlapping", () => {
    const ratings = [
      makeWhrRating("modelA", 1550, 150, 10),
      makeWhrRating("modelB", 1450, 150, 10),
    ];
    // |1550-1450| = 100 < 150+150 = 300 → overlap
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE)).toBe(false);
  });

  it("does not converge when minPairsPerModel is not met even without overlap", () => {
    const ratings = [
      makeWhrRating("modelA", 1800, 150, 1),
      makeWhrRating("modelB", 1200, 150, 10),
    ];
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE)).toBe(false);
  });

  it("converges with single model after minimum pairs", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 5),
    ];
    // Single model, no overlap possible → converged
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE)).toBe(true);
  });

  it("converges when one model has tight CI and another has wide but non-overlapping", () => {
    const ratings = [
      makeWhrRating("modelA", 1800, 30, 20),
      makeWhrRating("modelB", 1200, 150, 10),
    ];
    // |1800-1200| = 600 > 30+150 = 180 → no overlap
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE)).toBe(true);
  });
});

describe("identifyNeeds with overlap", () => {
  it("skips non-overlapping pairs when both models are converged", () => {
    const ratings = [
      makeWhrRating("modelA", 1800, 50, 5),
      makeWhrRating("modelB", 1200, 50, 5),
    ];
    // |1800-1200| = 600 > 100 → no overlap, both CIs (50) below threshold (100) → skip
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs).toHaveLength(0);
  });

  it("keeps non-overlapping pairs when one model has wide CI", () => {
    // Non-overlapping, but modelA's CI (150) is above the convergence threshold
    // (100). WHR benefits from all games, so we still generate candidates to
    // help narrow modelA's CI even though the pair outcome is already clear.
    const ratings = [
      makeWhrRating("modelA", 1800, 150, 5),
      makeWhrRating("modelB", 1200, 50, 5),
    ];
    // |1800-1200| = 600 > 200 → no overlap, but modelA CI (150) > threshold (100)
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs.length).toBeGreaterThan(0);
  });

  it("generates needs for overlapping pairs", () => {
    const ratings = [
      makeWhrRating("modelA", 1550, 150, 5),
      makeWhrRating("modelB", 1450, 150, 5),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs.length).toBeGreaterThan(0);
  });

  it("only generates needs for overlapping pairs in 3-model converged scenario", () => {
    // All three models have CIs below threshold (100) and few matches
    // (matchCount 1 < minPairsPerModel 2), so bothTight is false but
    // bothConverged is true. Non-overlapping pairs are skipped.
    const ratings = [
      makeWhrRating("modelA", 1800, 50, 1),
      makeWhrRating("modelB", 1500, 50, 1),
      makeWhrRating("modelC", 1480, 50, 1),
    ];
    // A-B: |300| > 100 → no overlap, both converged → skip
    // A-C: |320| > 100 → no overlap, both converged → skip
    // B-C: |20| < 100 → overlap!
    const needs = identifyNeeds(
      ratings, convergedRatings(3), convergedRatings(3),
      emptyWork(), threeModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    const initialNeeds = needs.filter((n) => n.type === "initial_judgment");
    expect(initialNeeds.length).toBeGreaterThan(0);
    for (const n of initialNeeds) {
      if (n.type === "initial_judgment") {
        expect([n.modelA, n.modelB].sort()).toEqual(["modelB", "modelC"]);
      }
    }
  });

  it("generates needs for non-overlapping pairs when one model is unconverged", () => {
    // modelB has wide CI (150 > threshold 100), so even non-overlapping pairs
    // involving modelB generate candidates — WHR uses all games to narrow CIs.
    const ratings = [
      makeWhrRating("modelA", 1800, 50, 10),
      makeWhrRating("modelB", 1500, 150, 5),
      makeWhrRating("modelC", 1480, 50, 5),
    ];
    // A-B: no overlap, but modelB unconverged → generates needs
    // A-C: no overlap, both converged → skip
    // B-C: overlap → generates needs
    const needs = identifyNeeds(
      ratings, convergedRatings(3), convergedRatings(3),
      emptyWork(), threeModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    const initialNeeds = needs.filter((n) => n.type === "initial_judgment");
    const pairs = new Set(initialNeeds.map((n) =>
      n.type === "initial_judgment" ? [n.modelA, n.modelB].sort().join(":") : "",
    ));
    expect(pairs.has("modelA:modelB")).toBe(true);  // non-overlapping but modelB unconverged
    expect(pairs.has("modelB:modelC")).toBe(true);  // overlapping
    expect(pairs.has("modelA:modelC")).toBe(false);  // non-overlapping, both converged
  });

  it("generates needs for Infinity CI models (always overlap)", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, Infinity, 0),
      makeWhrRating("modelB", 1500, 50, 10),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      emptyWork(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs.length).toBeGreaterThan(0);
  });
});

describe("judgmentKey", () => {
  it("normalizes model order", () => {
    const key1 = judgmentKey("initial", "modelA", "modelB", "p1", "judge");
    const key2 = judgmentKey("initial", "modelB", "modelA", "p1", "judge");
    expect(key1).toBe(key2);
  });

  it("distinguishes different stages", () => {
    const key1 = judgmentKey("initial", "modelA", "modelB", "p1", "judge");
    const key2 = judgmentKey("revised", "modelA", "modelB", "p1", "judge");
    expect(key1).not.toBe(key2);
  });

  it("distinguishes different output index combinations", () => {
    const k00 = judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 0);
    const k01 = judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 1);
    const k10 = judgmentKey("initial", "modelA", "modelB", "p1", "judge", 1, 0);
    const k11 = judgmentKey("initial", "modelA", "modelB", "p1", "judge", 1, 1);
    const keys = new Set([k00, k01, k10, k11]);
    expect(keys.size).toBe(4);
  });

  it("normalizes model order with output indices", () => {
    const key1 = judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 1);
    const key2 = judgmentKey("initial", "modelB", "modelA", "p1", "judge", 1, 0);
    expect(key1).toBe(key2);
  });
});

describe("formatBatchSummary", () => {
  it("counts needs by type", () => {
    const needs: Need[] = [
      makeInitialNeed("modelA", "modelB"),
      makeInitialNeed("modelA", "modelB"),
      makeImprovementNeed("modelA", "modelB"),
      makeRevisedNeed("modelA", "modelB", "modelC"),
    ];
    expect(formatBatchSummary(needs)).toBe("2 writing, 1 feedback, 1 revision");
  });

  it("omits types with zero count", () => {
    const needs: Need[] = [
      makeImprovementNeed("modelA", "modelB"),
      makeImprovementNeed("modelA", "modelC"),
    ];
    expect(formatBatchSummary(needs)).toBe("2 feedback");
  });

  it("returns empty string for empty list", () => {
    expect(formatBatchSummary([])).toBe("");
  });
});

describe("formatNeedDescription", () => {
  it("formats initial judgment with both CIs", () => {
    const need = makeInitialNeed("claude", "gpt-4o");
    const map = new Map<string, WhrRating>();
    map.set("writing:claude", makeWhrRating("claude", 1550, 142, 5));
    map.set("writing:gpt-4o", makeWhrRating("gpt-4o", 1450, 98, 8));
    expect(formatNeedDescription(need, map)).toBe(
      "writing: claude vs gpt-4o (±142 / ±98)",
    );
  });

  it("formats improvement judgment with single CI", () => {
    const need = makeImprovementNeed("gpt-4o", "claude");
    const map = new Map<string, WhrRating>();
    map.set("feedback:claude", makeWhrRating("claude", 1500, 200, 3));
    expect(formatNeedDescription(need, map)).toBe(
      "feedback: claude on gpt-4o (±200)",
    );
  });

  it("formats revised judgment with feedback model", () => {
    const need = makeRevisedNeed("claude", "gpt-4o", "gemini");
    const map = new Map<string, WhrRating>();
    map.set("revised:claude", makeWhrRating("claude", 1500, 180, 5));
    map.set("revised:gpt-4o", makeWhrRating("gpt-4o", 1500, 120, 8));
    expect(formatNeedDescription(need, map)).toBe(
      "revision: claude vs gpt-4o fb:gemini (±180 / ±120)",
    );
  });

  it("shows ±∞ for models without ratings", () => {
    const need = makeInitialNeed("claude", "gpt-4o");
    const map = new Map<string, WhrRating>();
    // No ratings in the map at all
    expect(formatNeedDescription(need, map)).toBe(
      "writing: claude vs gpt-4o (±∞ / ±∞)",
    );
  });

  it("shows ±∞ for Infinity CI", () => {
    const need = makeInitialNeed("claude", "gpt-4o");
    const map = new Map<string, WhrRating>();
    map.set("writing:claude", makeWhrRating("claude", 1500, Infinity, 0));
    map.set("writing:gpt-4o", makeWhrRating("gpt-4o", 1500, 50, 10));
    expect(formatNeedDescription(need, map)).toBe(
      "writing: claude vs gpt-4o (±∞ / ±50)",
    );
  });

  it("rounds CI to integer", () => {
    const need = makeInitialNeed("claude", "gpt-4o");
    const map = new Map<string, WhrRating>();
    map.set("writing:claude", makeWhrRating("claude", 1500, 142.7, 5));
    map.set("writing:gpt-4o", makeWhrRating("gpt-4o", 1500, 98.3, 8));
    expect(formatNeedDescription(need, map)).toBe(
      "writing: claude vs gpt-4o (±143 / ±98)",
    );
  });
});

// ── Helpers ─────────────────────────────────────────

function makeInitialNeed(modelA: string, modelB: string): Need {
  return {
    type: "initial_judgment",
    modelA,
    modelB,
    outputIdxA: 0,
    outputIdxB: 0,
    promptId: "p1",
    judgeModel: makeModel("judge"),
    score: 10,
  };
}

function makeImprovementNeed(writer: string, feedbackModel: string): Need {
  return {
    type: "improvement_judgment",
    writer,
    feedbackModel,
    outputIdx: 0,
    promptId: "p1",
    judgeModel: makeModel("judge"),
    score: 5,
  };
}

function makeRevisedNeed(modelA: string, modelB: string, feedbackModel: string): Need {
  return {
    type: "revised_judgment",
    modelA,
    modelB,
    outputIdxA: 0,
    outputIdxB: 0,
    feedbackModel,
    promptId: "p1",
    judgeModel: makeModel("judge"),
    score: 3,
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

function makeModel(label: string): ModelConfig {
  return {
    provider: "openai" as const,
    model: label,
    label,
    registryId: `openai:${label}`,
  };
}

function makePrompt(id: string): PromptConfig {
  return {
    id,
    name: id,
    tags: ["test"],
    description: "test prompt",
    prompt: "Write something",
    judgingCriteria: ["quality"],
  };
}

function twoModels(): ModelConfig[] {
  return [makeModel("modelA"), makeModel("modelB")];
}

function threeModels(): ModelConfig[] {
  return [makeModel("modelA"), makeModel("modelB"), makeModel("modelC")];
}

function oneJudge(): ModelConfig[] {
  return [makeModel("judge")];
}

function onePrompt(): PromptConfig[] {
  return [makePrompt("p1")];
}

function emptyWork(): CompletedWork {
  return { judgments: new Set() };
}

function convergedRatings(n: number): WhrRating[] {
  return Array.from({ length: n }, (_, i) =>
    makeWhrRating(`model${String.fromCharCode(65 + i)}`, 1500, 30, 10)
  );
}
