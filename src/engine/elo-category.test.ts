import { describe, it, expect } from "bun:test";
import { computeWhr, judgmentsToGames } from "./whr.js";
import type { PairwiseJudgment } from "../types.js";

function makeJudgment(
  id: string,
  promptId: string,
  sampleA: string,
  sampleB: string,
  winner: "A" | "B" | "tie",
): PairwiseJudgment {
  return {
    id,
    judgeModel: "judge",
    promptId,
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

/** Compute WHR ratings from judgments using the standard pipeline. */
function ratingsFromJudgments(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
) {
  const games = judgmentsToGames(judgments, sampleToModel);
  return computeWhr(games).ratings;
}

describe("per-category ELO computation", () => {
  // Scenario: model A dominates in sermons, model B dominates in essays
  const sampleToModel = new Map([
    // Sermon samples
    ["sermon-a1", "modelA"],
    ["sermon-b1", "modelB"],
    // Essay samples
    ["essay-a1", "modelA"],
    ["essay-b1", "modelB"],
    // Story samples
    ["story-a1", "modelA"],
    ["story-b1", "modelB"],
  ]);

  const allJudgments: PairwiseJudgment[] = [
    // modelA wins all sermon judgments
    makeJudgment("j1", "sermon", "sermon-a1", "sermon-b1", "A"),
    makeJudgment("j2", "sermon", "sermon-a1", "sermon-b1", "A"),
    makeJudgment("j3", "sermon", "sermon-a1", "sermon-b1", "A"),
    // modelB wins all essay judgments
    makeJudgment("j4", "essay", "essay-a1", "essay-b1", "B"),
    makeJudgment("j5", "essay", "essay-a1", "essay-b1", "B"),
    makeJudgment("j6", "essay", "essay-a1", "essay-b1", "B"),
    // tie in stories
    makeJudgment("j7", "story", "story-a1", "story-b1", "tie"),
    makeJudgment("j8", "story", "story-a1", "story-b1", "tie"),
  ];

  it("overall ELO reflects mixed results", () => {
    const overall = ratingsFromJudgments(allJudgments, sampleToModel);
    // Both models should be close to 1500 since they split wins
    const modelA = overall.find((r) => r.model === "modelA")!;
    const modelB = overall.find((r) => r.model === "modelB")!;
    // The difference should be small since they each won 3 and tied 2
    expect(Math.abs(modelA.rating - modelB.rating)).toBeLessThan(50);
  });

  it("sermon category shows modelA dominant", () => {
    const sermonJudgments = allJudgments.filter(
      (j) => j.promptId === "sermon",
    );
    const sermonElo = ratingsFromJudgments(sermonJudgments, sampleToModel);
    const modelA = sermonElo.find((r) => r.model === "modelA")!;
    const modelB = sermonElo.find((r) => r.model === "modelB")!;
    expect(modelA.rating).toBeGreaterThan(modelB.rating);
    expect(modelA.wins).toBe(3);
    expect(modelB.losses).toBe(3);
  });

  it("essay category shows modelB dominant", () => {
    const essayJudgments = allJudgments.filter(
      (j) => j.promptId === "essay",
    );
    const essayElo = ratingsFromJudgments(essayJudgments, sampleToModel);
    const modelA = essayElo.find((r) => r.model === "modelA")!;
    const modelB = essayElo.find((r) => r.model === "modelB")!;
    expect(modelB.rating).toBeGreaterThan(modelA.rating);
    expect(modelB.wins).toBe(3);
    expect(modelA.losses).toBe(3);
  });

  it("story category is tied", () => {
    const storyJudgments = allJudgments.filter(
      (j) => j.promptId === "story",
    );
    const storyElo = ratingsFromJudgments(storyJudgments, sampleToModel);
    const modelA = storyElo.find((r) => r.model === "modelA")!;
    const modelB = storyElo.find((r) => r.model === "modelB")!;
    expect(modelA.rating).toBe(modelB.rating);
    expect(modelA.ties).toBe(2);
    expect(modelB.ties).toBe(2);
  });

  it("category ELO only uses judgments from that category", () => {
    // Filter just sermon — should have 0 matches for essay-only models
    const sermonJudgments = allJudgments.filter(
      (j) => j.promptId === "sermon",
    );
    const sermonElo = ratingsFromJudgments(sermonJudgments, sampleToModel);

    for (const r of sermonElo) {
      // All matches should come from sermon judgments only (3 judgments)
      expect(r.matchCount).toBe(3);
    }
  });

  it("empty category produces default ratings", () => {
    const emptyElo = ratingsFromJudgments([], sampleToModel);
    expect(emptyElo).toHaveLength(0);
  });
});
