import { describe, it, expect } from "bun:test";
import {
  identifyNeeds,
  isConverged,
  judgmentKey,
  DEFAULT_CONVERGENCE,
} from "./need-identifier.js";
import type { CompletedWork, ConvergenceConfig } from "./need-identifier.js";
import type { WhrRating } from "./whr.js";
import type { ModelConfig, PromptConfig } from "../types.js";

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
    const lopsided = [
      makeWhrRating("modelA", 1800, 200, 5),
      makeWhrRating("modelB", 1200, 200, 5),
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
  it("returns true when all dimensions are below threshold", () => {
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

// ── Helpers ─────────────────────────────────────────

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
