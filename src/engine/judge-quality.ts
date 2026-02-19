import type { PairwiseJudgment } from "../types.js";
import type { WhrGame, WhrRating } from "./whr.js";
import { computeWhr } from "./whr.js";

// ── Constants ───────────────────────────────────────

/** Minimum evaluation instances (with >=2 judges) before judge ratings are used. */
export const MIN_JUDGE_INSTANCES = 5;

/** Floor for judge weights — never fully zero out a judge. */
export const MIN_JUDGE_WEIGHT = 0.1;

// ── Types ───────────────────────────────────────────

/** Judge quality data computed from cross-evaluation. */
export interface JudgeQualityData {
  /** WHR ratings for judges. Empty if insufficient data. */
  ratings: WhrRating[];
  /** Judge label -> normalized weight for writer BT. All 1.0 during bootstrap. */
  weights: Map<string, number>;
  /** Whether we have enough data to use judge quality (past bootstrap). */
  active: boolean;
  /** Number of evaluation instances with >=2 judges used. */
  instanceCount: number;
}

// ── Evaluation Instance Grouping ────────────────────

/** Canonical key for an evaluation instance. */
function instanceKey(j: PairwiseJudgment): string {
  const [a, b] = j.sampleA <= j.sampleB
    ? [j.sampleA, j.sampleB]
    : [j.sampleB, j.sampleA];
  return `${j.stage}:${j.promptId}:${a}:${b}`;
}

/**
 * Normalize a verdict to canonical sample order.
 * When the judgment's samples are in non-canonical order (sampleA > sampleB),
 * we flip the verdict so it's consistent with the canonical ordering.
 */
function normalizeVerdict(
  j: PairwiseJudgment,
): "A" | "B" | "tie" {
  if (j.sampleA <= j.sampleB) return j.winner;
  if (j.winner === "A") return "B";
  if (j.winner === "B") return "A";
  return "tie";
}

export interface InstanceData {
  consensus: "A" | "B" | "tie";
  verdicts: Map<string, "A" | "B" | "tie">;
}

/**
 * Group judgments by evaluation instance and compute consensus.
 * Returns only instances with >=2 judges.
 */
function groupByInstance(
  judgments: PairwiseJudgment[],
): Map<string, InstanceData> {
  // Group: instanceKey -> Map<judgeModel, verdict>
  const groups = new Map<string, Map<string, "A" | "B" | "tie">>();

  for (const j of judgments) {
    const key = instanceKey(j);
    let group = groups.get(key);
    if (!group) {
      group = new Map();
      groups.set(key, group);
    }
    group.set(j.judgeModel, normalizeVerdict(j));
  }

  // Filter to instances with >=2 judges and compute consensus
  const result = new Map<string, InstanceData>();

  for (const [key, verdicts] of groups) {
    if (verdicts.size < 2) continue;

    let votesA = 0;
    let votesB = 0;
    let votesTie = 0;
    for (const v of verdicts.values()) {
      if (v === "A") votesA++;
      else if (v === "B") votesB++;
      else votesTie++;
    }

    let consensus: "A" | "B" | "tie";
    if (votesA > votesB && votesA > votesTie) consensus = "A";
    else if (votesB > votesA && votesB > votesTie) consensus = "B";
    else consensus = "tie";

    result.set(key, { consensus, verdicts });
  }

  return result;
}

// ── Judge Games ─────────────────────────────────────

/**
 * Build pairwise games between judges based on consensus agreement.
 * For each evaluation instance with >=2 judges, for each pair of judges:
 *   - If j1 agrees with consensus and j2 doesn't: j1 wins
 *   - If j2 agrees and j1 doesn't: j2 wins
 *   - Both agree or both disagree: tie
 *
 * Accepts either raw judgments (groups internally) or pre-computed instances.
 */
export function buildJudgeGames(
  judgmentsOrInstances: PairwiseJudgment[] | Map<string, InstanceData>,
): WhrGame[] {
  const instances = judgmentsOrInstances instanceof Map
    ? judgmentsOrInstances
    : groupByInstance(judgmentsOrInstances);
  const games: WhrGame[] = [];

  for (const { consensus, verdicts } of instances.values()) {
    const judges = [...verdicts.entries()];
    for (let i = 0; i < judges.length; i++) {
      for (let j = i + 1; j < judges.length; j++) {
        const [j1, v1] = judges[i];
        const [j2, v2] = judges[j];
        const j1Agrees = v1 === consensus;
        const j2Agrees = v2 === consensus;

        if (j1Agrees && !j2Agrees) {
          games.push({ playerWhite: j1, playerBlack: j2, result: 1.0 });
        } else if (j2Agrees && !j1Agrees) {
          games.push({ playerWhite: j2, playerBlack: j1, result: 1.0 });
        } else {
          // Both agree or both disagree -> tie
          games.push({ playerWhite: j1, playerBlack: j2, result: 0.5 });
        }
      }
    }
  }

  return games;
}

// ── Weight Computation ──────────────────────────────

/**
 * Convert judge WHR ratings to weights via exponential decay from best.
 * The best judge gets weight 1.0; others decay as exp(k * (rating - best)).
 * Half-life = ln(2)/k Elo points.
 *
 * @param k Exponential decay rate. Higher = sharper differentiation.
 */
export function ratingsToWeights(ratings: WhrRating[], k: number): Map<string, number> {
  const weights = new Map<string, number>();
  if (ratings.length === 0) return weights;

  // Best rating anchors at weight 1.0 — no normalization needed
  let bestRating = -Infinity;
  for (const r of ratings) {
    if (r.rating > bestRating) bestRating = r.rating;
  }

  // Exponential decay: weight = exp(k * (rating - best))
  // k controls sharpness; half-life = ln(2)/k Elo points
  for (const r of ratings) {
    const w = Math.max(MIN_JUDGE_WEIGHT, Math.exp(k * (r.rating - bestRating)));
    weights.set(r.model, w);
  }

  return weights;
}

// ── Public API ──────────────────────────────────────

/**
 * Compute judge quality data from all accumulated judgments.
 *
 * Groups judgments by evaluation instance, computes consensus,
 * builds judge-vs-judge games, runs WHR, and derives weights.
 * Returns unweighted (all 1.0) data during bootstrap period.
 */
export function computeJudgeQuality(
  judgments: PairwiseJudgment[],
  judgeLabels: string[],
  k: number,
): JudgeQualityData {
  const instances = groupByInstance(judgments);
  const instanceCount = instances.size;

  // Default: all weights = 1.0
  const defaultWeights = new Map<string, number>();
  for (const label of judgeLabels) {
    defaultWeights.set(label, 1.0);
  }

  // Bootstrap check
  if (instanceCount < MIN_JUDGE_INSTANCES) {
    return {
      ratings: [],
      weights: defaultWeights,
      active: false,
      instanceCount,
    };
  }

  const games = buildJudgeGames(instances);
  if (games.length === 0) {
    return {
      ratings: [],
      weights: defaultWeights,
      active: false,
      instanceCount,
    };
  }

  const result = computeWhr(games);
  const weights = ratingsToWeights(result.ratings, k);

  // Fill in any judges not in the games (no multi-judge instances yet)
  for (const label of judgeLabels) {
    if (!weights.has(label)) {
      weights.set(label, 1.0);
    }
  }

  return {
    ratings: result.ratings,
    weights,
    active: true,
    instanceCount,
  };
}

/**
 * Compute judge quality from a model's ELO rating in a chosen dimension.
 *
 * Instead of consensus-based cross-evaluation, this uses the model's
 * performance rating (writing, feedback, or revised) as a proxy for
 * judge quality. Better writers/feedback-givers are assumed to be
 * better judges.
 *
 * Returns bootstrap (all weights 1.0) when fewer than 2 judges have ratings.
 */
export function computeEloBasedJudgeQuality(
  dimensionRatings: WhrRating[],
  judgeLabels: string[],
  k: number,
): JudgeQualityData {
  const defaultWeights = new Map<string, number>();
  for (const label of judgeLabels) {
    defaultWeights.set(label, 1.0);
  }

  // Filter dimension ratings to only judges
  const judgeSet = new Set(judgeLabels);
  const judgeRatings = dimensionRatings.filter((r) => judgeSet.has(r.model));

  // Need at least 2 judges with ratings for meaningful differentiation
  if (judgeRatings.length < 2) {
    return {
      ratings: judgeRatings,
      weights: defaultWeights,
      active: false,
      instanceCount: 0,
    };
  }

  const weights = ratingsToWeights(judgeRatings, k);

  // Fill in judges not yet in the rating dimension with weight 1.0
  for (const label of judgeLabels) {
    if (!weights.has(label)) {
      weights.set(label, 1.0);
    }
  }

  return {
    ratings: judgeRatings,
    weights,
    active: true,
    instanceCount: 0, // Not applicable for ELO-based mode
  };
}

/**
 * Get the weight for a specific judge. Returns 1.0 if not found.
 */
export function getJudgeWeight(
  data: JudgeQualityData,
  judgeLabel: string,
): number {
  return data.weights.get(judgeLabel) ?? 1.0;
}

/**
 * Check whether a judge should be excluded from need generation.
 * Only prunes when judge quality is active (past bootstrap).
 */
export function shouldPruneJudge(
  data: JudgeQualityData,
  judgeLabel: string,
  threshold: number,
): boolean {
  if (!data.active) return false;
  const weight = data.weights.get(judgeLabel) ?? 1.0;
  return weight < threshold;
}
