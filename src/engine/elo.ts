import type { EloRating, PairwiseJudgment } from "../types.js";

const DEFAULT_RATING = 1500;
const DEFAULT_K = 32;
const BASE = 400;

/**
 * Calculate the expected score for player A against player B.
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / BASE));
}

/**
 * Update ELO ratings for a single match result.
 * Returns the new ratings for [A, B].
 */
export function updateElo(
  ratingA: number,
  ratingB: number,
  result: "A" | "B" | "tie",
  k: number = DEFAULT_K
): [number, number] {
  const eA = expectedScore(ratingA, ratingB);
  const eB = 1 - eA;

  let sA: number, sB: number;
  if (result === "A") {
    sA = 1;
    sB = 0;
  } else if (result === "B") {
    sA = 0;
    sB = 1;
  } else {
    sA = 0.5;
    sB = 0.5;
  }

  return [
    Math.round(ratingA + k * (sA - eA)),
    Math.round(ratingB + k * (sB - eB)),
  ];
}

/**
 * Create a fresh ELO rating for a model.
 */
export function createRating(model: string): EloRating {
  return {
    model,
    rating: DEFAULT_RATING,
    wins: 0,
    losses: 0,
    ties: 0,
    matchCount: 0,
  };
}

/**
 * Process a list of judgments and compute ELO ratings for all models.
 *
 * @param judgments - Pairwise comparison results
 * @param sampleToModel - Map from sample ID to model label
 * @param k - ELO K-factor
 * @returns Array of ELO ratings sorted by rating descending
 */
export function computeEloFromJudgments(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
  k: number = DEFAULT_K
): EloRating[] {
  const ratings = new Map<string, EloRating>();

  // Ensure all models have entries
  for (const model of new Set(sampleToModel.values())) {
    ratings.set(model, createRating(model));
  }

  // Process each judgment
  for (const j of judgments) {
    const modelA = sampleToModel.get(j.sampleA);
    const modelB = sampleToModel.get(j.sampleB);
    if (!modelA || !modelB) continue;

    // Skip self-comparisons (same model)
    if (modelA === modelB) continue;

    const rA = ratings.get(modelA)!;
    const rB = ratings.get(modelB)!;

    const [newA, newB] = updateElo(rA.rating, rB.rating, j.winner, k);

    rA.rating = newA;
    rB.rating = newB;
    rA.matchCount++;
    rB.matchCount++;

    if (j.winner === "A") {
      rA.wins++;
      rB.losses++;
    } else if (j.winner === "B") {
      rB.wins++;
      rA.losses++;
    } else {
      rA.ties++;
      rB.ties++;
    }
  }

  return Array.from(ratings.values()).sort((a, b) => b.rating - a.rating);
}

/**
 * Compute feedback ELO from revised-stage judgments.
 * Credits the feedback provider whose feedback was used in the winning sample.
 *
 * @param judgments - Revised-stage pairwise judgments
 * @param sampleToFeedbackModel - Map from revised sample ID to the model that provided feedback
 * @param k - ELO K-factor
 */
export function computeFeedbackElo(
  judgments: PairwiseJudgment[],
  sampleToFeedbackModel: Map<string, string>,
  k: number = DEFAULT_K
): EloRating[] {
  const ratings = new Map<string, EloRating>();

  // Ensure all feedback models have entries
  for (const model of new Set(sampleToFeedbackModel.values())) {
    ratings.set(model, createRating(model));
  }

  for (const j of judgments) {
    const feedbackA = sampleToFeedbackModel.get(j.sampleA);
    const feedbackB = sampleToFeedbackModel.get(j.sampleB);
    if (!feedbackA || !feedbackB) continue;
    if (feedbackA === feedbackB) continue;

    const rA = ratings.get(feedbackA)!;
    const rB = ratings.get(feedbackB)!;

    const [newA, newB] = updateElo(rA.rating, rB.rating, j.winner, k);

    rA.rating = newA;
    rB.rating = newB;
    rA.matchCount++;
    rB.matchCount++;

    if (j.winner === "A") {
      rA.wins++;
      rB.losses++;
    } else if (j.winner === "B") {
      rB.wins++;
      rA.losses++;
    } else {
      rA.ties++;
      rB.ties++;
    }
  }

  return Array.from(ratings.values()).sort((a, b) => b.rating - a.rating);
}

/**
 * Compute feedback ELO from improvement judgments (revision vs original).
 * Each improvement judgment compares a revision against its original.
 * sampleA = original, sampleB = revision. If the revision wins, the
 * feedback provider that guided it gets credit.
 *
 * Models compete by comparing their improvement rates across the same
 * writer's work — when writer W revises with feedback from model X
 * and separately with feedback from model Y, we compare their
 * improvement wins/losses to rank feedback providers.
 */
export function computeFeedbackEloFromImprovements(
  improvementJudgments: PairwiseJudgment[],
  sampleToFeedbackModel: Map<string, string>,
  k: number = DEFAULT_K
): EloRating[] {
  const ratings = new Map<string, EloRating>();

  for (const model of new Set(sampleToFeedbackModel.values())) {
    ratings.set(model, createRating(model));
  }

  // Group improvement results by (writer, prompt, judge) to find
  // matchups: same writer, same prompt, same judge, different feedback
  type ImpResult = {
    feedbackModel: string;
    winner: "A" | "B" | "tie";
    revisedSampleId: string;
  };
  const groups = new Map<string, ImpResult[]>();

  for (const j of improvementJudgments) {
    // sampleB is the revised sample
    const fbModel = sampleToFeedbackModel.get(j.sampleB);
    if (!fbModel) continue;

    // Group key: writerModel + promptId + judgeModel
    // We need writer model — get it from the revised sample's model
    // which is stored as the judgment's sampleB model. But we only
    // have sample IDs here. Use promptId + judgeModel as group key
    // and let the feedback models compete within each group.
    const groupKey = `${j.promptId}:${j.judgeModel}`;
    const group = groups.get(groupKey) ?? [];
    group.push({
      feedbackModel: fbModel,
      winner: j.winner,
      revisedSampleId: j.sampleB,
    });
    groups.set(groupKey, group);
  }

  // Within each group, pair up different feedback models
  for (const results of groups.values()) {
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i];
        const b = results[j];
        if (a.feedbackModel === b.feedbackModel) continue;

        const rA = ratings.get(a.feedbackModel)!;
        const rB = ratings.get(b.feedbackModel)!;

        // Compare outcomes: B wins the improvement judgment means
        // the revision beat the original. Higher improvement = better feedback.
        const aImproved = a.winner === "B"; // revision beat original
        const bImproved = b.winner === "B";

        let matchResult: "A" | "B" | "tie";
        if (aImproved && !bImproved) matchResult = "A";
        else if (!aImproved && bImproved) matchResult = "B";
        else matchResult = "tie";

        const [newA, newB] = updateElo(rA.rating, rB.rating, matchResult, k);
        rA.rating = newA;
        rB.rating = newB;
        rA.matchCount++;
        rB.matchCount++;

        if (matchResult === "A") { rA.wins++; rB.losses++; }
        else if (matchResult === "B") { rB.wins++; rA.losses++; }
        else { rA.ties++; rB.ties++; }
      }
    }
  }

  return Array.from(ratings.values()).sort((a, b) => b.rating - a.rating);
}

/**
 * Apply a set of judgments to existing cumulative ratings.
 * Mutates the ratings map in-place.
 */
export function applyCumulativeJudgments(
  ratings: Map<string, EloRating>,
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
  k: number = DEFAULT_K
): void {
  // Ensure all models exist
  for (const model of new Set(sampleToModel.values())) {
    if (!ratings.has(model)) {
      ratings.set(model, createRating(model));
    }
  }

  for (const j of judgments) {
    const modelA = sampleToModel.get(j.sampleA);
    const modelB = sampleToModel.get(j.sampleB);
    if (!modelA || !modelB || modelA === modelB) continue;

    const rA = ratings.get(modelA)!;
    const rB = ratings.get(modelB)!;

    const [newA, newB] = updateElo(rA.rating, rB.rating, j.winner, k);

    rA.rating = newA;
    rB.rating = newB;
    rA.matchCount++;
    rB.matchCount++;

    if (j.winner === "A") {
      rA.wins++;
      rB.losses++;
    } else if (j.winner === "B") {
      rB.wins++;
      rA.losses++;
    } else {
      rA.ties++;
      rB.ties++;
    }
  }
}
