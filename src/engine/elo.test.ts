import { describe, it, expect } from "bun:test";
import {
  expectedScore,
  computeEloFromJudgments,
  computeFeedbackElo,
  computeFeedbackEloFromImprovements,
  extractPairwiseRecords,
  extractFeedbackPairwiseRecords,
  mergeRecords,
  computeRatingsFromRecords,
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

describe("Bradley-Terry order independence", () => {
  it("produces identical ratings regardless of judgment order", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
      ["s2", "modelB"],
      ["s3", "modelC"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "s1", "s2", "A"),
      makeJudgment("j2", "s2", "s3", "B"),
      makeJudgment("j3", "s1", "s3", "A"),
      makeJudgment("j4", "s1", "s2", "B"),
      makeJudgment("j5", "s2", "s3", "A"),
    ];

    const forward = computeEloFromJudgments(judgments, sampleToModel);
    const reversed = computeEloFromJudgments(
      [...judgments].reverse(),
      sampleToModel
    );
    const shuffled = computeEloFromJudgments(
      [judgments[3], judgments[0], judgments[4], judgments[2], judgments[1]],
      sampleToModel
    );

    for (const model of ["modelA", "modelB", "modelC"]) {
      const fwd = forward.find((r) => r.model === model)!;
      const rev = reversed.find((r) => r.model === model)!;
      const shf = shuffled.find((r) => r.model === model)!;
      expect(fwd.rating).toBe(rev.rating);
      expect(fwd.rating).toBe(shf.rating);
      expect(fwd.wins).toBe(rev.wins);
      expect(fwd.losses).toBe(rev.losses);
      expect(fwd.ties).toBe(rev.ties);
    }
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

describe("pairwise record extraction and merging", () => {
  it("extractPairwiseRecords captures win/loss/tie counts", () => {
    const sampleToModel = new Map([
      ["s1", "modelA"],
      ["s2", "modelB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "s1", "s2", "A"),
      makeJudgment("j2", "s1", "s2", "B"),
      makeJudgment("j3", "s1", "s2", "tie"),
    ];

    const records = extractPairwiseRecords(judgments, sampleToModel);
    expect(records).toHaveLength(1);

    const r = records[0];
    expect(r.winsA + r.winsB).toBe(2);
    expect(r.ties).toBe(1);
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
    // Normalized to sorted order: modelA, modelB
    // existing flipped: modelA=1 win, modelB=3 wins
    // incoming: modelA=2 wins, modelB=0 wins
    // merged: modelA=3, modelB=3
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

  it("computeRatingsFromRecords produces correct relative rankings", () => {
    const records = [
      { modelA: "modelA", modelB: "modelB", winsA: 5, winsB: 1, ties: 0 },
      { modelA: "modelA", modelB: "modelC", winsA: 3, winsB: 3, ties: 0 },
      { modelA: "modelB", modelB: "modelC", winsA: 0, winsB: 4, ties: 0 },
    ];

    const ratings = computeRatingsFromRecords(records);
    const a = ratings.find((r) => r.model === "modelA")!;
    const b = ratings.find((r) => r.model === "modelB")!;
    const c = ratings.find((r) => r.model === "modelC")!;

    // A beats B convincingly, C beats B convincingly, A ties with C
    expect(a.rating).toBeGreaterThan(b.rating);
    expect(c.rating).toBeGreaterThan(b.rating);
  });

  it("computeRatingsFromRecords returns empty for empty records", () => {
    const ratings = computeRatingsFromRecords([]);
    expect(ratings).toHaveLength(0);
  });

  it("computeRatingsFromRecords is order-independent", () => {
    const records = [
      { modelA: "modelA", modelB: "modelB", winsA: 3, winsB: 1, ties: 0 },
      { modelA: "modelB", modelB: "modelC", winsA: 2, winsB: 2, ties: 1 },
      { modelA: "modelA", modelB: "modelC", winsA: 1, winsB: 4, ties: 0 },
    ];

    const forward = computeRatingsFromRecords(records);
    const reversed = computeRatingsFromRecords([...records].reverse());

    for (const model of ["modelA", "modelB", "modelC"]) {
      const fwd = forward.find((r) => r.model === model)!;
      const rev = reversed.find((r) => r.model === model)!;
      expect(fwd.rating).toBe(rev.rating);
    }
  });

  it("extractFeedbackPairwiseRecords works for improvement judgments", () => {
    const sampleToFeedbackModel = new Map([
      ["rev1", "feedbackA"],
      ["rev2", "feedbackB"],
    ]);
    const judgments: PairwiseJudgment[] = [
      makeJudgment("j1", "orig1", "rev1", "B", "improvement", "p1"),
      makeJudgment("j2", "orig2", "rev2", "A", "improvement", "p1"),
    ];

    const records = extractFeedbackPairwiseRecords(
      judgments,
      sampleToFeedbackModel
    );
    expect(records).toHaveLength(1);

    // feedbackA improved (B won), feedbackB didn't (A won)
    // So feedbackA beat feedbackB in this pairing
    const r = records[0];
    const total = r.winsA + r.winsB + r.ties;
    expect(total).toBe(1);
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
