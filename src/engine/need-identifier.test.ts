import { describe, it, expect } from "bun:test";
import {
  identifyNeeds as identifyNeedsRaw,
  isConverged,
  judgmentKey,
  judgmentGroupKey,
  emptyCompletedWork,
  formatNeedDescription,
  formatBatchSummary,
} from "./need-identifier.js";
import type { Need, CompletedWork } from "./need-identifier.js";
import type { WhrRating } from "./whr.js";
import type { ModelConfig, PromptConfig, ConvergenceConfig } from "../types.js";
import { DEFAULT_CONVERGENCE } from "../types.js";

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
      workWith(), twoModels(), oneJudge(), onePrompt(),
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
      workWith(), threeModels(), oneJudge(), onePrompt(),
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
      workWith(), threeModels(), oneJudge(), onePrompt(),
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
      workWith(), twoModels(), oneJudge(), prompts,
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
      workWith(), twoModels(), oneJudge(), manyPrompts,
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
      workWith(), twoModels(), oneJudge(), onePrompt(),
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
      workWith(), twoModels(), oneJudge(), onePrompt(),
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

  it("uses custom cascade weights from convergence config", () => {
    const wideRatings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    // With high revised weight, revised needs should score closer to initial
    const highRevisedConfig: ConvergenceConfig = {
      ...DEFAULT_CONVERGENCE,
      revisedWeight: 0.9,
    };
    const needs = identifyNeeds(
      wideRatings, wideRatings, wideRatings,
      workWith(), twoModels(), oneJudge(), onePrompt(),
      highRevisedConfig, 20, 1,
    );
    const initialNeeds = needs.filter((n) => n.type === "initial_judgment");
    const revisedNeeds = needs.filter((n) => n.type === "revised_judgment");

    expect(initialNeeds.length).toBeGreaterThan(0);
    expect(revisedNeeds.length).toBeGreaterThan(0);
    // With revisedWeight=0.9 (close to initial's writingWeight 1.0),
    // revised scores should be much closer to initial than with default 0.4
    const ratio = revisedNeeds[0].score / initialNeeds[0].score;
    expect(ratio).toBeGreaterThan(0.5);
  });

  it("excludes already-completed work", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const completed = workWith({
      judgments: new Set([
        judgmentKey("initial", "modelA", "modelB", "p1", "judge"),
      ]),
    });
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
    const completed = workWith({
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
    });
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
      workWith(), twoModels(), oneJudge(), onePrompt(),
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
    const completed = workWith({
      judgments: new Set([
        judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 0),
      ]),
    });
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
      workWith(), twoModels(), oneJudge(), onePrompt(),
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
    const completed = workWith({
      judgments: new Set([
        judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 0),
      ]),
    });

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

    const completed = workWith({
      judgments: new Set([
        judgmentKey("initial", "modelA", "modelB", "p1", "judge", 0, 0),
      ]),
    });

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

describe("missing-artifact pruning", () => {
  it("skips initial judgments when a sample is missing", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const work = workWith({ missingSamples: new Set(["modelA:p1:0"]) });
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    // All initial judgments require modelA's sample at p1:0, so none should be generated
    const initial = needs.filter((n) => n.type === "initial_judgment");
    expect(initial).toHaveLength(0);
  });

  it("skips improvement judgments when writer sample is missing", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const work = workWith({ missingSamples: new Set(["modelA:p1:0"]) });
    const needs = identifyNeeds(
      convergedRatings(2), convergedRatings(2), ratings,
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    // Improvement needs where writer=modelA should be pruned
    const impA = needs.filter(
      (n) => n.type === "improvement_judgment" && n.writer === "modelA",
    );
    expect(impA).toHaveLength(0);
    // But writer=modelB should still have needs
    const impB = needs.filter(
      (n) => n.type === "improvement_judgment" && n.writer === "modelB",
    );
    expect(impB.length).toBeGreaterThan(0);
  });

  it("skips improvement judgments when feedback is missing for one side", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    // Feedback from modelA on modelB's sample is missing
    const work = workWith({ missingFeedback: new Set(["modelA:modelB:p1:0"]) });
    const needs = identifyNeeds(
      convergedRatings(2), convergedRatings(2), ratings,
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    // Side with feedbackModel=modelA on writer=modelB should be pruned
    const prunedSide = needs.filter(
      (n) => n.type === "improvement_judgment"
        && n.feedbackModel === "modelA" && n.writer === "modelB",
    );
    expect(prunedSide).toHaveLength(0);
  });

  it("skips revised judgments when a sample is missing", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const work = workWith({ missingSamples: new Set(["modelB:p1:0"]) });
    const needs = identifyNeeds(
      convergedRatings(2), ratings, convergedRatings(2),
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    // All revised judgments involve modelB at p1:0, so none should be generated
    const revised = needs.filter((n) => n.type === "revised_judgment");
    expect(revised).toHaveLength(0);
  });

  it("skips revised judgments when revision is missing", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    // Revision of modelA using feedback from modelA is missing
    const work = workWith({ missingRevisions: new Set(["modelA:modelA:p1:0"]) });
    const needs = identifyNeeds(
      convergedRatings(2), ratings, convergedRatings(2),
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    // Revised judgments with fbModel=modelA involving modelA should be pruned
    const pruned = needs.filter(
      (n) => n.type === "revised_judgment"
        && n.feedbackModel === "modelA",
    );
    expect(pruned).toHaveLength(0);
  });

  it("skips initial judgments when all judges missed the judgment group", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const work = workWith({
      missingJudgments: new Set([judgmentGroupKey("modelA", "modelB", "p1", 0, 0)]),
    });
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    const initial = needs.filter((n) => n.type === "initial_judgment");
    expect(initial).toHaveLength(0);
  });

  it("does not prune other output indices when one index is missing", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    // Miss at (0,0) should NOT block (0,1) or (1,0)
    const work = workWith({
      missingJudgments: new Set([judgmentGroupKey("modelA", "modelB", "p1", 0, 0)]),
    });
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 2,  // outputsPerModel = 2
    );
    const initial = needs.filter((n) => n.type === "initial_judgment");
    // (0,0) is pruned but (0,1), (1,0), (1,1) should still generate candidates
    const at00 = initial.filter((n) => n.outputIdxA === 0 && n.outputIdxB === 0);
    const atOther = initial.filter((n) => n.outputIdxA !== 0 || n.outputIdxB !== 0);
    expect(at00).toHaveLength(0);
    expect(atOther.length).toBeGreaterThan(0);
  });

  it("skips improvement judgments when all judges missed the judgment group", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    // Missing judgment group for writer=modelA, feedbackModel=modelA on p1
    const work = workWith({
      missingJudgments: new Set([judgmentGroupKey("modelA", "modelA", "p1", 0, 0)]),
    });
    const needs = identifyNeeds(
      convergedRatings(2), convergedRatings(2), ratings,
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    // The pruned side: writer=modelA, feedbackModel=modelA
    const pruned = needs.filter(
      (n) => n.type === "improvement_judgment"
        && n.writer === "modelA" && n.feedbackModel === "modelA",
    );
    expect(pruned).toHaveLength(0);
  });

  it("skips revised judgments when all judges missed the judgment group", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    // Missing judgment group for modelA vs modelB with fbModel=modelA on p1
    const work = workWith({
      missingJudgments: new Set([judgmentGroupKey("modelA", "modelB", "p1:modelA", 0, 0)]),
    });
    const needs = identifyNeeds(
      convergedRatings(2), ratings, convergedRatings(2),
      work, twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    // Revised judgments with fbModel=modelA should be pruned
    const pruned = needs.filter(
      (n) => n.type === "revised_judgment" && n.feedbackModel === "modelA",
    );
    expect(pruned).toHaveLength(0);
    // But fbModel=modelB should still have needs
    const remaining = needs.filter(
      (n) => n.type === "revised_judgment" && n.feedbackModel === "modelB",
    );
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("does not prune when missing sets are empty", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 3),
      makeWhrRating("modelB", 1500, 200, 3),
    ];
    const needsWithEmpty = identifyNeeds(
      ratings, ratings, ratings,
      workWith(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1,
    );
    // Should generate needs for all three dimensions
    expect(needsWithEmpty.length).toBeGreaterThan(0);
    expect(needsWithEmpty.some((n) => n.type === "initial_judgment")).toBe(true);
    expect(needsWithEmpty.some((n) => n.type === "improvement_judgment")).toBe(true);
    expect(needsWithEmpty.some((n) => n.type === "revised_judgment")).toBe(true);
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
      workWith(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 1, 1,
    );
    const lopsidedNeeds = identifyNeeds(
      lopsided, convergedRatings(2), convergedRatings(2),
      workWith(), twoModels(), oneJudge(), onePrompt(),
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
      workWith(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 1, 1,
    );
    // |800| > 80 → no overlap, both have enough matches → resolved
    expect(needs).toHaveLength(0);
  });
});

describe("isConverged", () => {
  it("returns true when all models have tight non-overlapping CIs", () => {
    const tight = [
      makeWhrRating("modelA", 1550, 30, 10),
      makeWhrRating("modelB", 1450, 25, 10),
    ];
    expect(isConverged(tight, tight, tight, DEFAULT_CONVERGENCE, 2)).toBe(true);
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
    expect(isConverged(wide, tight, tight, DEFAULT_CONVERGENCE, 2)).toBe(false);
    expect(isConverged(tight, wide, tight, DEFAULT_CONVERGENCE, 2)).toBe(false);
    expect(isConverged(tight, tight, wide, DEFAULT_CONVERGENCE, 2)).toBe(false);
  });

  it("returns false when models have too few games", () => {
    const fewGames = [
      makeWhrRating("modelA", 1550, 30, 1), // below minPairsPerModel (2)
      makeWhrRating("modelB", 1450, 25, 10),
    ];
    expect(isConverged(fewGames, fewGames, fewGames, DEFAULT_CONVERGENCE, 2)).toBe(false);
  });

  it("returns false for empty ratings", () => {
    expect(isConverged([], [], [], DEFAULT_CONVERGENCE, 0)).toBe(false);
  });

  it("converges when CIs are wide but non-overlapping", () => {
    const ratings = [
      makeWhrRating("modelA", 1800, 150, 10),
      makeWhrRating("modelB", 1200, 150, 10),
    ];
    // |1800-1200| = 600 > 150+150 = 300 → no overlap
    // Both have wide CIs (150 > 100) but models are distinguishable
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE, 2)).toBe(true);
  });

  it("does not converge when CIs are wide and overlapping", () => {
    const ratings = [
      makeWhrRating("modelA", 1550, 150, 10),
      makeWhrRating("modelB", 1450, 150, 10),
    ];
    // |1550-1450| = 100 < 150+150 = 300 → overlap
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE, 2)).toBe(false);
  });

  it("does not converge when minPairsPerModel is not met even without overlap", () => {
    const ratings = [
      makeWhrRating("modelA", 1800, 150, 1),
      makeWhrRating("modelB", 1200, 150, 10),
    ];
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE, 2)).toBe(false);
  });

  it("converges with single model after minimum pairs", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, 200, 5),
    ];
    // Single model, no overlap possible → converged
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE, 1)).toBe(true);
  });

  it("converges when one model has tight CI and another has wide but non-overlapping", () => {
    const ratings = [
      makeWhrRating("modelA", 1800, 30, 20),
      makeWhrRating("modelB", 1200, 150, 10),
    ];
    // |1800-1200| = 600 > 30+150 = 180 → no overlap
    expect(isConverged(ratings, ratings, ratings, DEFAULT_CONVERGENCE, 2)).toBe(true);
  });

  it("returns false when ratings are missing a configured model", () => {
    const tight = [
      makeWhrRating("modelA", 1550, 30, 10),
      makeWhrRating("modelB", 1450, 25, 10),
    ];
    // 3 models configured but only 2 have ratings → not converged
    expect(isConverged(tight, tight, tight, DEFAULT_CONVERGENCE, 3)).toBe(false);
    // 2 models configured and 2 have ratings → converged
    expect(isConverged(tight, tight, tight, DEFAULT_CONVERGENCE, 2)).toBe(true);
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
      workWith(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs).toHaveLength(0);
  });

  it("resolves non-overlapping pairs even when one model has wide CI", () => {
    // Non-overlapping pairs are always resolved regardless of CI width —
    // models are distinguishable. WHR is global, so data from other pairs
    // still helps narrow the wide-CI model.
    const ratings = [
      makeWhrRating("modelA", 1800, 150, 5),
      makeWhrRating("modelB", 1200, 50, 5),
    ];
    // |1800-1200| = 600 > 200 → no overlap → resolved
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      workWith(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs).toHaveLength(0);
  });

  it("generates needs for overlapping pairs", () => {
    const ratings = [
      makeWhrRating("modelA", 1550, 150, 5),
      makeWhrRating("modelB", 1450, 150, 5),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      workWith(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs.length).toBeGreaterThan(0);
  });

  it("only generates needs for overlapping pairs in 3-model scenario", () => {
    // All three models have enough matches (5 >= minPairsPerModel 2).
    // Non-overlapping pairs are resolved; only overlapping pairs generate needs.
    const ratings = [
      makeWhrRating("modelA", 1800, 50, 5),
      makeWhrRating("modelB", 1500, 50, 5),
      makeWhrRating("modelC", 1480, 50, 5),
    ];
    // A-B: |300| > 100 → no overlap → resolved
    // A-C: |320| > 100 → no overlap → resolved
    // B-C: |20| < 100 → overlap!
    const needs = identifyNeeds(
      ratings, convergedRatings(3), convergedRatings(3),
      workWith(), threeModels(), oneJudge(), onePrompt(),
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

  it("only generates needs for overlapping pairs regardless of CI width", () => {
    // In overlap mode (ciThreshold=0), non-overlapping pairs are always
    // resolved, even if one model has wide CI. Only overlapping pairs
    // generate needs.
    const ratings = [
      makeWhrRating("modelA", 1800, 50, 10),
      makeWhrRating("modelB", 1500, 150, 5),
      makeWhrRating("modelC", 1480, 50, 5),
    ];
    // A-B: |300| > 200 → no overlap → resolved
    // A-C: |320| > 100 → no overlap → resolved
    // B-C: |20| < 200 → overlap → generates needs
    const needs = identifyNeeds(
      ratings, convergedRatings(3), convergedRatings(3),
      workWith(), threeModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    const initialNeeds = needs.filter((n) => n.type === "initial_judgment");
    const pairs = new Set(initialNeeds.map((n) =>
      n.type === "initial_judgment" ? [n.modelA, n.modelB].sort().join(":") : "",
    ));
    expect(pairs.has("modelA:modelB")).toBe(false);  // non-overlapping → resolved
    expect(pairs.has("modelB:modelC")).toBe(true);   // overlapping → needs
    expect(pairs.has("modelA:modelC")).toBe(false);   // non-overlapping → resolved
  });

  it("generates needs for Infinity CI models (always overlap)", () => {
    const ratings = [
      makeWhrRating("modelA", 1500, Infinity, 0),
      makeWhrRating("modelB", 1500, 50, 10),
    ];
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      workWith(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs.length).toBeGreaterThan(0);
  });

  it("resolves overlapping pairs when both CIs are below threshold (threshold mode)", () => {
    const thresholdConfig: ConvergenceConfig = { ...DEFAULT_CONVERGENCE, ciThreshold: 100 };
    const ratings = [
      makeWhrRating("modelA", 1520, 50, 10),
      makeWhrRating("modelB", 1480, 50, 10),
    ];
    // |40| < 100 → overlap, but both CIs (50) ≤ threshold (100) → resolved
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      workWith(), twoModels(), oneJudge(), onePrompt(),
      thresholdConfig, 10, 1,
    );
    expect(needs).toHaveLength(0);
  });

  it("does not resolve overlapping pairs in overlap mode (ciThreshold=0)", () => {
    const ratings = [
      makeWhrRating("modelA", 1520, 50, 10),
      makeWhrRating("modelB", 1480, 50, 10),
    ];
    // |40| < 100 → overlap. ciThreshold=0 → can't resolve by threshold
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      workWith(), twoModels(), oneJudge(), onePrompt(),
      DEFAULT_CONVERGENCE, 10, 1,
    );
    expect(needs.length).toBeGreaterThan(0);
  });

  it("resolves non-overlapping wide-CI pairs with threshold mode", () => {
    // In threshold mode (ciThreshold > 0), non-overlapping pairs are
    // still resolved even when one model has CI above threshold.
    const thresholdConfig: ConvergenceConfig = { ...DEFAULT_CONVERGENCE, ciThreshold: 100 };
    const ratings = [
      makeWhrRating("modelA", 1800, 150, 5),
      makeWhrRating("modelB", 1200, 50, 5),
    ];
    // |600| > 200 → no overlap → resolved regardless of CI width
    const needs = identifyNeeds(
      ratings, convergedRatings(2), convergedRatings(2),
      workWith(), twoModels(), oneJudge(), onePrompt(),
      thresholdConfig, 10, 1,
    );
    expect(needs).toHaveLength(0);
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

  it("shows 'new' for models without ratings", () => {
    const need = makeInitialNeed("claude", "gpt-4o");
    const map = new Map<string, WhrRating>();
    // No ratings in the map at all
    expect(formatNeedDescription(need, map)).toBe(
      "writing: claude vs gpt-4o (new / new)",
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

function makeImprovementNeed(writer: string, feedbackModel: string, againstFeedbackModel = "otherFb"): Need {
  return {
    type: "improvement_judgment",
    writer,
    feedbackModel,
    againstFeedbackModel,
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

/** Build a CompletedWork with selective overrides, defaulting to empty. */
function workWith(overrides: Partial<CompletedWork> = {}): CompletedWork {
  return { ...emptyCompletedWork(), ...overrides };
}

function convergedRatings(n: number): WhrRating[] {
  // Space models 200 apart so CIs (±30) never overlap: gap ≥ 200 > 60
  return Array.from({ length: n }, (_, i) =>
    makeWhrRating(`model${String.fromCharCode(65 + i)}`, 1500 + i * 200, 30, 10)
  );
}

// ── Batch Dimension Coverage Tests ──────────────────

describe("batch dimension coverage", () => {
  it("includes improvement needs even when initial needs score higher", () => {
    // Simulate --skip-seeding: all three dimensions have empty ratings.
    // With feedbackWeight=0.25, improvement needs score 4x lower than
    // initial needs. With enough models/judges, the batch must still
    // include improvement needs or the feedback dimension can never converge.
    const emptyRatings: WhrRating[] = [];
    const models = Array.from({ length: 6 }, (_, i) =>
      makeModel(`model${String.fromCharCode(65 + i)}`),
    );
    const judges = Array.from({ length: 4 }, (_, i) =>
      makeModel(`judge${i}`),
    );
    const prompts = [makePrompt("p1"), makePrompt("p2")];

    // Batch size 60: smaller than total initial needs (C(6,2)*4*2 = 120).
    const needs = identifyNeeds(
      emptyRatings, emptyRatings, emptyRatings,
      workWith(), models, judges, prompts,
      DEFAULT_CONVERGENCE, 60, 1,
    );

    const hasImprovement = needs.some((n) => n.type === "improvement_judgment");
    const hasInitial = needs.some((n) => n.type === "initial_judgment");

    expect(hasInitial).toBe(true);
    expect(hasImprovement).toBe(true);
  });

  it("includes revised needs even when initial needs score higher", () => {
    const emptyRatings: WhrRating[] = [];
    const models = Array.from({ length: 6 }, (_, i) =>
      makeModel(`model${String.fromCharCode(65 + i)}`),
    );
    const judges = [makeModel("judge0")];
    const prompts = [makePrompt("p1"), makePrompt("p2")];

    const needs = identifyNeeds(
      emptyRatings, emptyRatings, emptyRatings,
      workWith(), models, judges, prompts,
      DEFAULT_CONVERGENCE, 30, 1,
    );

    const hasRevised = needs.some((n) => n.type === "revised_judgment");
    expect(hasRevised).toBe(true);
  });

  it("includes all three dimensions when ratings are empty", () => {
    const emptyRatings: WhrRating[] = [];
    const models = threeModels();
    const judges = oneJudge();
    const prompts = onePrompt();

    const needs = identifyNeeds(
      emptyRatings, emptyRatings, emptyRatings,
      workWith(), models, judges, prompts,
      DEFAULT_CONVERGENCE, 1000, 1,
    );

    const types = new Set(needs.map((n) => n.type));
    expect(types.has("initial_judgment")).toBe(true);
    expect(types.has("improvement_judgment")).toBe(true);
    expect(types.has("revised_judgment")).toBe(true);
  });

  it("allocates slots proportionally to cascade weights", () => {
    const emptyRatings: WhrRating[] = [];
    // Use enough models/judges/prompts so each dimension has plenty of
    // candidates — more than its proportional share of the batch.
    const models = Array.from({ length: 6 }, (_, i) =>
      makeModel(`model${String.fromCharCode(65 + i)}`),
    );
    const judges = Array.from({ length: 5 }, (_, i) =>
      makeModel(`judge${i}`),
    );
    const prompts = [makePrompt("p1"), makePrompt("p2"), makePrompt("p3")];

    const needs = identifyNeeds(
      emptyRatings, emptyRatings, emptyRatings,
      workWith(), models, judges, prompts,
      DEFAULT_CONVERGENCE, 200, 1,
    );

    const initialCount = needs.filter((n) => n.type === "initial_judgment").length;
    const improvementCount = needs.filter((n) => n.type === "improvement_judgment").length;
    const revisedCount = needs.filter((n) => n.type === "revised_judgment").length;

    // Writing weight 1.0, feedback 0.25, revised 0.4 → total 1.65
    // All three dimensions must be present
    expect(initialCount).toBeGreaterThan(0);
    expect(improvementCount).toBeGreaterThan(0);
    expect(revisedCount).toBeGreaterThan(0);
    // Writing (1.0) should get more slots than feedback (0.25)
    expect(initialCount).toBeGreaterThan(improvementCount);
    // Writing (1.0) should get more slots than revised (0.4)
    expect(initialCount).toBeGreaterThan(revisedCount);
  });

  it("covers multiple feedback model pairs in improvement needs", () => {
    // With 5 models, there are C(5,2)=10 feedback model pairs.
    // The improvement batch should cover multiple pairs, not just the first.
    const emptyRatings: WhrRating[] = [];
    const models = Array.from({ length: 5 }, (_, i) =>
      makeModel(`model${String.fromCharCode(65 + i)}`),
    );
    const judges = [makeModel("judge0")];
    const prompts = [makePrompt("p1"), makePrompt("p2")];

    const needs = identifyNeeds(
      emptyRatings, emptyRatings, emptyRatings,
      workWith(), models, judges, prompts,
      DEFAULT_CONVERGENCE, 50, 1,
    );

    // Collect unique feedback models from improvement needs
    const improvementNeeds = needs.filter(
      (n) => n.type === "improvement_judgment",
    ) as Array<Extract<Need, { type: "improvement_judgment" }>>;
    const feedbackModels = new Set<string>();
    for (const n of improvementNeeds) {
      feedbackModels.add(n.feedbackModel);
    }
    // Must cover more than 2 feedback models
    expect(feedbackModels.size).toBeGreaterThan(2);
  });

  it("covers multiple writer pairs in revised needs", () => {
    // With 5 models, there are C(5,2)=10 writer pairs.
    // The revised batch should cover multiple pairs, not just the first.
    const emptyRatings: WhrRating[] = [];
    const models = Array.from({ length: 5 }, (_, i) =>
      makeModel(`model${String.fromCharCode(65 + i)}`),
    );
    const judges = [makeModel("judge0")];
    const prompts = [makePrompt("p1"), makePrompt("p2")];

    const needs = identifyNeeds(
      emptyRatings, emptyRatings, emptyRatings,
      workWith(), models, judges, prompts,
      DEFAULT_CONVERGENCE, 50, 1,
    );

    // Collect unique writer pairs from revised needs
    const revisedNeeds = needs.filter(
      (n) => n.type === "revised_judgment",
    ) as Array<Extract<Need, { type: "revised_judgment" }>>;
    const writerPairs = new Set<string>();
    for (const n of revisedNeeds) {
      writerPairs.add([n.modelA, n.modelB].sort().join(":"));
    }
    // Must cover more than 1 writer pair
    expect(writerPairs.size).toBeGreaterThan(1);
  });
});

// ── Judge Quality Integration Tests ─────────────────

import type { JudgeQualityData } from "./judge-quality.js";

describe("identifyNeeds with judge quality", () => {
  it("excludes pruned judges from candidates", () => {
    const unconverged = [
      makeWhrRating("modelA", 1500, Infinity, 0),
      makeWhrRating("modelB", 1500, Infinity, 0),
    ];
    const models = twoModels();
    const judges = [makeModel("goodJudge"), makeModel("badJudge")];
    const jq: JudgeQualityData = {
      ratings: [],
      weights: new Map([
        ["goodJudge", 1.0],
        ["badJudge", DEFAULT_CONVERGENCE.judgePruneThreshold - 0.01],
      ]),
      active: true,
      instanceCount: 10,
    };

    const needs = identifyNeeds(
      unconverged, unconverged, unconverged,
      workWith(), models, judges, onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1, jq,
    );

    // Only goodJudge should produce needs
    const judgeLabels = new Set(needs.map((n) => n.judgeModel.label));
    expect(judgeLabels.has("goodJudge")).toBe(true);
    expect(judgeLabels.has("badJudge")).toBe(false);
  });

  it("scales scores by judge weight", () => {
    const unconverged = [
      makeWhrRating("modelA", 1500, Infinity, 0),
      makeWhrRating("modelB", 1500, Infinity, 0),
    ];
    const models = twoModels();
    const judges = [makeModel("heavyJudge"), makeModel("lightJudge")];
    const jq: JudgeQualityData = {
      ratings: [],
      weights: new Map([
        ["heavyJudge", 1.0],
        ["lightJudge", 0.6],
      ]),
      active: true,
      instanceCount: 10,
    };

    const needs = identifyNeeds(
      unconverged, unconverged, unconverged,
      workWith(), models, judges, onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1, jq,
    );

    const heavyNeed = needs.find((n) => n.judgeModel.label === "heavyJudge");
    const lightNeed = needs.find((n) => n.judgeModel.label === "lightJudge");
    expect(heavyNeed).toBeDefined();
    expect(lightNeed).toBeDefined();
    expect(heavyNeed!.score).toBeGreaterThan(lightNeed!.score);
  });

  it("generates needs for all judges during bootstrap", () => {
    const unconverged = [
      makeWhrRating("modelA", 1500, Infinity, 0),
      makeWhrRating("modelB", 1500, Infinity, 0),
    ];
    const models = twoModels();
    const judges = [makeModel("judge1"), makeModel("judge2")];
    const jq: JudgeQualityData = {
      ratings: [],
      weights: new Map([["judge1", 1.0], ["judge2", 1.0]]),
      active: false,
      instanceCount: 2,
    };

    const needs = identifyNeeds(
      unconverged, unconverged, unconverged,
      workWith(), models, judges, onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1, jq,
    );

    const judgeLabels = new Set(needs.map((n) => n.judgeModel.label));
    expect(judgeLabels.has("judge1")).toBe(true);
    expect(judgeLabels.has("judge2")).toBe(true);
  });

  it("never prunes the last judge", () => {
    const unconverged = [
      makeWhrRating("modelA", 1500, Infinity, 0),
      makeWhrRating("modelB", 1500, Infinity, 0),
    ];
    const models = twoModels();
    const judges = [makeModel("onlyJudge")];
    const jq: JudgeQualityData = {
      ratings: [],
      weights: new Map([["onlyJudge", 0.01]]), // very low weight
      active: true,
      instanceCount: 10,
    };

    const needs = identifyNeeds(
      unconverged, unconverged, unconverged,
      workWith(), models, judges, onePrompt(),
      DEFAULT_CONVERGENCE, 100, 1, jq,
    );

    // Single judge should NOT be pruned even though weight is below threshold
    expect(needs.length).toBeGreaterThan(0);
    expect(needs[0].judgeModel.label).toBe("onlyJudge");
  });
});
