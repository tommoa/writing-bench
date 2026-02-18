import { sigmoid, LOG10E_TIMES_400, hasOverlap, hasAnyOverlap } from "./whr.js";
import type { WhrRating } from "./whr.js";
import type { ModelConfig, PromptConfig } from "../types.js";

// ── Types ───────────────────────────────────────────

/** A single unit of work that can be pulled to reduce uncertainty. */
export type Need =
  | {
      type: "initial_judgment";
      modelA: string;
      modelB: string;
      outputIdxA: number;
      outputIdxB: number;
      promptId: string;
      judgeModel: ModelConfig;
      score: number;
    }
  | {
      type: "improvement_judgment";
      writer: string;
      outputIdx: number;
      feedbackModel: string;
      promptId: string;
      judgeModel: ModelConfig;
      score: number;
    }
  | {
      type: "revised_judgment";
      modelA: string;
      modelB: string;
      outputIdxA: number;
      outputIdxB: number;
      feedbackModel: string;
      promptId: string;
      judgeModel: ModelConfig;
      score: number;
    };

/** Configuration for adaptive convergence. */
export interface ConvergenceConfig {
  /** 95% CI half-width threshold in Elo points. Default: 100. */
  ciThreshold: number;
  /** Maximum number of adaptive rounds. Default: 30. */
  maxRounds: number;
  /** Minimum games per model before checking CI. Default: 3. */
  minPairsPerModel: number;
}

export const DEFAULT_CONVERGENCE: ConvergenceConfig = {
  ciThreshold: 100,
  maxRounds: 50,
  minPairsPerModel: 2,
};

/** Tracks which work has already been completed or scheduled. */
export interface CompletedWork {
  /** Set of judgment dedup keys (see judgmentKey()). */
  judgments: Set<string>;
}

// ── Helpers ─────────────────────────────────────────

/**
 * Compute information gain score for comparing two models.
 * Higher score = more informative comparison.
 *
 * score = (sigma_A^2 + sigma_B^2) * p * (1 - p)
 *
 * where sigma^2 is the posterior variance (ci95^2 / (1.96*173.72)^2)
 * and p is the predicted win probability.
 */
function informationGain(ratingA: WhrRating, ratingB: WhrRating): number {
  const scale = 1.96 * LOG10E_TIMES_400;

  const varA = ratingA.ci95 === Infinity ? 100 : (ratingA.ci95 / scale) ** 2;
  const varB = ratingB.ci95 === Infinity ? 100 : (ratingB.ci95 / scale) ** 2;

  // Predicted win probability for A vs B
  const rDiff = (ratingA.rating - ratingB.rating) / LOG10E_TIMES_400;
  const p = sigmoid(rDiff);

  return (varA + varB) * p * (1 - p);
}

/**
 * Check whether a model pair is already resolved and needs no further
 * comparisons. A pair is resolved if both models have individually
 * converged (tight CIs with enough games) or their CIs don't overlap
 * (models are already distinguishable).
 */
function pairResolved(
  a: WhrRating,
  b: WhrRating,
  convergence: ConvergenceConfig,
): boolean {
  const bothTight = a.ci95 <= convergence.ciThreshold
    && b.ci95 <= convergence.ciThreshold
    && a.matchCount >= convergence.minPairsPerModel
    && b.matchCount >= convergence.minPairsPerModel;
  return bothTight || !hasOverlap(a, b);
}

/**
 * Build a dedup key for a judgment.
 * For symmetric comparisons (initial, revised), models are sorted
 * (and output indices are swapped accordingly).
 * For asymmetric comparisons (improvement), models are NOT sorted
 * because writer and feedback model play different roles.
 */
export function judgmentKey(
  stage: string,
  modelA: string,
  modelB: string,
  promptId: string,
  judgeLabel: string,
  outputIdxA: number = 0,
  outputIdxB: number = 0,
): string {
  if (stage === "improvement") {
    // Asymmetric: modelA = writer, modelB = feedbackModel
    // outputIdxA = writer output index, outputIdxB unused
    return `${stage}:${modelA}:${outputIdxA}:${modelB}:${promptId}:${judgeLabel}`;
  }
  // Symmetric: sort models, swap indices to match
  if (modelA <= modelB) {
    return `${stage}:${modelA}:${outputIdxA}:${modelB}:${outputIdxB}:${promptId}:${judgeLabel}`;
  }
  return `${stage}:${modelB}:${outputIdxB}:${modelA}:${outputIdxA}:${promptId}:${judgeLabel}`;
}

// ── Public API ──────────────────────────────────────

/**
 * Identify the most impactful needs for reducing rating uncertainty.
 *
 * Given current WHR ratings across all three dimensions, candidate
 * models/prompts/judges, and a set of already-completed work, returns
 * a prioritized batch of needs scored by expected information gain.
 *
 * `outputsPerModel` controls how many output indices per model per
 * prompt are considered for comparisons. Default is 1 (single output).
 * The runner passes min(cap, currentMax + 1) to allow adaptive growth.
 */
export function identifyNeeds(
  writingRatings: WhrRating[],
  revisedRatings: WhrRating[],
  feedbackRatings: WhrRating[],
  completedWork: CompletedWork,
  models: ModelConfig[],
  judgeModels: ModelConfig[],
  prompts: PromptConfig[],
  convergence: ConvergenceConfig,
  batchSize: number,
  outputsPerModel: number,
): Need[] {
  const candidates: Need[] = [];
  const ratingMap = new Map<string, WhrRating>();

  // Build lookup maps
  for (const r of writingRatings) ratingMap.set(`writing:${r.model}`, r);
  for (const r of revisedRatings) ratingMap.set(`revised:${r.model}`, r);
  for (const r of feedbackRatings) ratingMap.set(`feedback:${r.model}`, r);

  // Default rating for models not yet in WHR
  const defaultRating: WhrRating = {
    model: "", rating: 1500, ci95: Infinity,
    wins: 0, losses: 0, ties: 0, matchCount: 0,
  };

  // ── Initial judgment needs ────────────────────────
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const rA = ratingMap.get(`writing:${models[i].label}`) ?? { ...defaultRating, model: models[i].label };
      const rB = ratingMap.get(`writing:${models[j].label}`) ?? { ...defaultRating, model: models[j].label };

      if (pairResolved(rA, rB, convergence)) continue;

      const gain = informationGain(rA, rB);

      for (let oi = 0; oi < outputsPerModel; oi++) {
        for (let oj = 0; oj < outputsPerModel; oj++) {
          for (const prompt of prompts) {
            for (const judge of judgeModels) {
              const key = judgmentKey(
                "initial", models[i].label, models[j].label,
                prompt.id, judge.label, oi, oj,
              );
              if (completedWork.judgments.has(key)) continue;

              candidates.push({
                type: "initial_judgment",
                modelA: models[i].label,
                modelB: models[j].label,
                outputIdxA: oi,
                outputIdxB: oj,
                promptId: prompt.id,
                judgeModel: judge,
                score: gain,
              });
            }
          }
        }
      }
    }
  }

  // ── Improvement judgment needs ────────────────────
  // For improvement, the "players" are feedback models. We pair them
  // using information gain on the feedback rating dimension.
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const fbA = ratingMap.get(`feedback:${models[i].label}`) ?? { ...defaultRating, model: models[i].label };
      const fbB = ratingMap.get(`feedback:${models[j].label}`) ?? { ...defaultRating, model: models[j].label };

      if (pairResolved(fbA, fbB, convergence)) continue;

      const gain = informationGain(fbA, fbB) * 0.25; // cascade cost discount

      // Each improvement comparison needs a writer to apply both feedbacks to
      for (const writer of models) {
        for (let oi = 0; oi < outputsPerModel; oi++) {
          for (const prompt of prompts) {
            for (const judge of judgeModels) {
              // Emit needs for whichever side is incomplete
              const keyA = judgmentKey("improvement", writer.label, models[i].label, prompt.id, judge.label, oi);
              const keyB = judgmentKey("improvement", writer.label, models[j].label, prompt.id, judge.label, oi);
              if (completedWork.judgments.has(keyA) && completedWork.judgments.has(keyB)) continue;

              if (!completedWork.judgments.has(keyA)) {
                candidates.push({
                  type: "improvement_judgment",
                  writer: writer.label,
                  outputIdx: oi,
                  feedbackModel: models[i].label,
                  promptId: prompt.id,
                  judgeModel: judge,
                  score: gain,
                });
              }
              if (!completedWork.judgments.has(keyB)) {
                candidates.push({
                  type: "improvement_judgment",
                  writer: writer.label,
                  outputIdx: oi,
                  feedbackModel: models[j].label,
                  promptId: prompt.id,
                  judgeModel: judge,
                  score: gain,
                });
              }
            }
          }
        }
      }
    }
  }

  // ── Revised judgment needs ────────────────────────
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const rA = ratingMap.get(`revised:${models[i].label}`) ?? { ...defaultRating, model: models[i].label };
      const rB = ratingMap.get(`revised:${models[j].label}`) ?? { ...defaultRating, model: models[j].label };

      if (pairResolved(rA, rB, convergence)) continue;

      const gain = informationGain(rA, rB) * 0.2; // cascade cost discount

      for (let oi = 0; oi < outputsPerModel; oi++) {
        for (let oj = 0; oj < outputsPerModel; oj++) {
          for (const fbModel of models) {
            for (const prompt of prompts) {
              for (const judge of judgeModels) {
                const key = judgmentKey(
                  "revised", models[i].label, models[j].label,
                  `${prompt.id}:${fbModel.label}`, judge.label, oi, oj,
                );
                if (completedWork.judgments.has(key)) continue;

                candidates.push({
                  type: "revised_judgment",
                  modelA: models[i].label,
                  modelB: models[j].label,
                  outputIdxA: oi,
                  outputIdxB: oj,
                  feedbackModel: fbModel.label,
                  promptId: prompt.id,
                  judgeModel: judge,
                  score: gain,
                });
              }
            }
          }
        }
      }
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Select top batch, diversifying across model pairs and prompts
  const selected: Need[] = [];
  const pairCount = new Map<string, number>();
  const maxPerPair = Math.max(2, Math.ceil(batchSize / models.length));

  for (const candidate of candidates) {
    if (selected.length >= batchSize) break;

    const pairKey = candidate.type === "improvement_judgment"
      ? `imp:${candidate.writer}:${candidate.feedbackModel}`
      : candidate.type === "initial_judgment"
      ? `init:${[candidate.modelA, candidate.modelB].sort().join(":")}`
      : `rev:${[candidate.modelA, candidate.modelB].sort().join(":")}:${candidate.feedbackModel}`;

    const count = pairCount.get(pairKey) ?? 0;
    if (count >= maxPerPair) continue;

    selected.push(candidate);
    pairCount.set(pairKey, count + 1);
  }

  return selected;
}

/**
 * Check whether all three dimensions have converged.
 */
export function isConverged(
  writingRatings: WhrRating[],
  revisedRatings: WhrRating[],
  feedbackRatings: WhrRating[],
  convergence: ConvergenceConfig,
): boolean {
  return (
    dimensionConverged(writingRatings, convergence) &&
    dimensionConverged(revisedRatings, convergence) &&
    dimensionConverged(feedbackRatings, convergence)
  );
}

/**
 * Check whether a single rating dimension has converged.
 * A model is effectively converged if:
 *   - it has enough games (matchCount >= minPairsPerModel), AND
 *   - its CI is below threshold, OR its CI doesn't overlap with any
 *     other model (meaning it's already clearly distinguishable).
 */
function dimensionConverged(
  ratings: WhrRating[],
  convergence: ConvergenceConfig,
): boolean {
  if (ratings.length === 0) return false;
  for (const r of ratings) {
    if (r.matchCount < convergence.minPairsPerModel) return false;
    if (r.ci95 > convergence.ciThreshold && hasAnyOverlap(r, ratings)) {
      return false;
    }
  }
  return true;
}
