import { describe, it, expect } from "bun:test";
import {
  expectedScore,
  updateElo,
  computeEloFromJudgments,
  computeFeedbackElo,
  computeFeedbackEloFromImprovements,
  applyCumulativeFeedbackJudgments,
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

describe("computeFeedbackEloFromImprovements", () => {
  it("credits feedback model whose revision beat the original", () => {
    // Two improvement judgments for the same prompt+judge:
    // feedbackA's revision wins (B wins = revision beat original)
    // feedbackB's revision loses (A wins = original beat revision)
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "B", "improvement", "p1"),
      makeJudgment("j2", "orig2", "rev2", "A", "improvement", "p1"),
    ];

    const ratings = computeFeedbackEloFromImprovements(
      judgments,
      sampleToFeedbackModel
    );
    const fbA = ratings.find((r) => r.model === "feedbackA")!;
    const fbB = ratings.find((r) => r.model === "feedbackB")!;

    expect(fbA.rating).toBeGreaterThan(fbB.rating);
    expect(fbA.wins).toBe(1);
    expect(fbB.losses).toBe(1);
  });

  it("ties when both revisions beat (or both lose to) the original", () => {
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
    ]);
    // Both revisions beat the original
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "B", "improvement", "p1"),
      makeJudgment("j2", "orig2", "rev2", "B", "improvement", "p1"),
    ];

    const ratings = computeFeedbackEloFromImprovements(
      judgments,
      sampleToFeedbackModel
    );
    const fbA = ratings.find((r) => r.model === "feedbackA")!;
    const fbB = ratings.find((r) => r.model === "feedbackB")!;

    expect(fbA.rating).toBe(fbB.rating);
    expect(fbA.ties).toBe(1);
    expect(fbB.ties).toBe(1);
  });

  it("groups by promptId and judgeModel separately", () => {
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
      ["rev3", "feedbackA"],
      ["rev4", "feedbackB"],
    ]);
    // Different prompts — should be separate groups, each producing one match
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "B", "improvement", "p1"),
      makeJudgment("j2", "orig2", "rev2", "A", "improvement", "p1"),
      makeJudgment("j3", "orig3", "rev3", "B", "improvement", "p2"),
      makeJudgment("j4", "orig4", "rev4", "A", "improvement", "p2"),
    ];

    const ratings = computeFeedbackEloFromImprovements(
      judgments,
      sampleToFeedbackModel
    );
    const fbA = ratings.find((r) => r.model === "feedbackA")!;

    // Two groups (p1:judge, p2:judge), each produces one A win → 2 matches total
    expect(fbA.matchCount).toBe(2);
    expect(fbA.wins).toBe(2);
  });

  it("skips same feedback model comparisons", () => {
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackA"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "B", "improvement", "p1"),
      makeJudgment("j2", "orig2", "rev2", "A", "improvement", "p1"),
    ];

    const ratings = computeFeedbackEloFromImprovements(
      judgments,
      sampleToFeedbackModel
    );
    expect(ratings).toHaveLength(1);
    expect(ratings[0].matchCount).toBe(0);
  });
});

describe("applyCumulativeFeedbackJudgments", () => {
  it("updates existing ratings from improvement judgments", () => {
    const ratings = new Map([
      ["feedbackA", createRating("feedbackA")],
      ["feedbackB", createRating("feedbackB")],
    ]);
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "B", "improvement", "p1"),
      makeJudgment("j2", "orig2", "rev2", "A", "improvement", "p1"),
    ];

    applyCumulativeFeedbackJudgments(ratings, judgments, sampleToFeedbackModel);

    expect(ratings.get("feedbackA")!.rating).toBeGreaterThan(1500);
    expect(ratings.get("feedbackB")!.rating).toBeLessThan(1500);
    expect(ratings.get("feedbackA")!.wins).toBe(1);
    expect(ratings.get("feedbackB")!.losses).toBe(1);
  });

  it("preserves pre-existing ratings and accumulates", () => {
    // feedbackA already has a high rating from prior runs
    const ratings = new Map([
      [
        "feedbackA",
        { model: "feedbackA", rating: 1600, wins: 5, losses: 1, ties: 0, matchCount: 6 },
      ],
      [
        "feedbackB",
        { model: "feedbackB", rating: 1400, wins: 1, losses: 5, ties: 0, matchCount: 6 },
      ],
    ]);
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
    ]);
    // feedbackB's revision wins this time
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "A", "improvement", "p1"),
      makeJudgment("j2", "orig2", "rev2", "B", "improvement", "p1"),
    ];

    applyCumulativeFeedbackJudgments(ratings, judgments, sampleToFeedbackModel);

    const a = ratings.get("feedbackA")!;
    const b = ratings.get("feedbackB")!;
    // feedbackA still ahead but gap narrowed
    expect(a.rating).toBeGreaterThan(b.rating);
    expect(a.matchCount).toBe(7);
    expect(b.matchCount).toBe(7);
    expect(b.wins).toBe(2);
  });

  it("creates entries for new feedback models not yet in ratings", () => {
    const ratings = new Map<string, import("../types.js").EloRating>();
    const sampleToFeedbackModel = new Map([
      ["rev1", "newModelA"],
      ["rev2", "newModelB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "B", "improvement", "p1"),
      makeJudgment("j2", "orig2", "rev2", "A", "improvement", "p1"),
    ];

    applyCumulativeFeedbackJudgments(ratings, judgments, sampleToFeedbackModel);

    expect(ratings.has("newModelA")).toBe(true);
    expect(ratings.has("newModelB")).toBe(true);
    expect(ratings.get("newModelA")!.rating).toBeGreaterThan(1500);
  });

  it("does nothing with empty judgments", () => {
    const ratings = new Map([
      ["feedbackA", createRating("feedbackA")],
    ]);

    applyCumulativeFeedbackJudgments(ratings, [], new Map());

    expect(ratings.get("feedbackA")!.rating).toBe(1500);
    expect(ratings.get("feedbackA")!.matchCount).toBe(0);
  });
});

function makeJudgment(
  id: string,
  sampleA: string,
  sampleB: string,
  winner: "A" | "B" | "tie",
  stage: "initial" | "revised" | "improvement" = "initial",
  promptId: string = "p1"
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
