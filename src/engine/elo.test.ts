import { describe, it, expect } from "bun:test";
import {
  expectedScore,
  updateElo,
  computeEloFromJudgments,
  computeFeedbackElo,
  createRating,
} from "./elo.js";
import type { PairwiseJudgment } from "../types.js";

describe("expectedScore", () => {
  it("returns 0.5 for equal ratings", () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5);
  });

  it("returns higher score for stronger player", () => {
    const score = expectedScore(1600, 1400);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it("returns lower score for weaker player", () => {
    const score = expectedScore(1400, 1600);
    expect(score).toBeLessThan(0.5);
    expect(score).toBeGreaterThan(0);
  });

  it("is symmetric (scores sum to 1)", () => {
    const eA = expectedScore(1600, 1400);
    const eB = expectedScore(1400, 1600);
    expect(eA + eB).toBeCloseTo(1);
  });
});

describe("updateElo", () => {
  it("winner gains, loser loses for equal ratings", () => {
    const [newA, newB] = updateElo(1500, 1500, "A");
    expect(newA).toBeGreaterThan(1500);
    expect(newB).toBeLessThan(1500);
  });

  it("tie preserves equal ratings", () => {
    const [newA, newB] = updateElo(1500, 1500, "tie");
    expect(newA).toBe(1500);
    expect(newB).toBe(1500);
  });

  it("upset causes larger rating change", () => {
    // Weaker player beats stronger player
    const [newA, newB] = updateElo(1300, 1700, "A");
    const gainA = newA - 1300;

    // Expected win causes smaller change
    const [newC, newD] = updateElo(1700, 1300, "A");
    const gainC = newC - 1700;

    expect(gainA).toBeGreaterThan(gainC);
  });

  it("total rating points are conserved", () => {
    const [newA, newB] = updateElo(1600, 1400, "A");
    expect(newA + newB).toBe(1600 + 1400);
  });
});

describe("computeEloFromJudgments", () => {
  it("handles empty judgments", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
      ["s2", "modelB"],
    ]);
    const ratings = computeEloFromJudgments([], sampleToModel);
    expect(ratings).toHaveLength(2);
    expect(ratings[0].rating).toBe(1500);
    expect(ratings[1].rating).toBe(1500);
  });

  it("correctly scores when one model always wins", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
      ["s2", "modelB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "s1", "s2", "A"),
      makeJudgment("j2", "s1", "s2", "A"),
      makeJudgment("j3", "s1", "s2", "A"),
    ];

    const ratings = computeEloFromJudgments(judgments, sampleToModel);
    const modelA = ratings.find((r) => r.model === "modelA")!;
    const modelB = ratings.find((r) => r.model === "modelB")!;

    expect(modelA.rating).toBeGreaterThan(1500);
    expect(modelB.rating).toBeLessThan(1500);
    expect(modelA.wins).toBe(3);
    expect(modelB.losses).toBe(3);
  });

  it("skips self-comparisons", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
      ["s2", "modelA"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "s1", "s2", "A"),
    ];

    const ratings = computeEloFromJudgments(judgments, sampleToModel);
    expect(ratings).toHaveLength(1);
    expect(ratings[0].rating).toBe(1500);
    expect(ratings[0].matchCount).toBe(0);
  });

  it("tracks ties correctly", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
      ["s2", "modelB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "s1", "s2", "tie"),
    ];

    const ratings = computeEloFromJudgments(judgments, sampleToModel);
    expect(ratings[0].ties).toBe(1);
    expect(ratings[1].ties).toBe(1);
  });
});

describe("computeFeedbackElo", () => {
  it("credits feedback provider of winning sample", () => {
    const sampleToFeedbackModel = new Map([
      ["s1", "feedbackA"],
      ["s2", "feedbackB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "s1", "s2", "A"),
      makeJudgment("j2", "s1", "s2", "A"),
    ];

    const ratings = computeFeedbackElo(judgments, sampleToFeedbackModel);
    const fbA = ratings.find((r) => r.model === "feedbackA")!;
    const fbB = ratings.find((r) => r.model === "feedbackB")!;

    expect(fbA.rating).toBeGreaterThan(1500);
    expect(fbB.rating).toBeLessThan(1500);
  });
});

function makeJudgment(
  id: string,
  sampleA: string,
  sampleB: string,
  winner: "A" | "B" | "tie"
): PairwiseJudgment {
  return {
    id,
    judgeModel: "judge",
    promptId: "p1",
    sampleA,
    sampleB,
    winner,
    reasoning: "test",
    stage: "initial",
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: { input: 0, output: 0, total: 0, totalUncached: 0 },
    latencyMs: 0,
  };
}
