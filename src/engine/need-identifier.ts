import { sigmoid, LOG10E_TIMES_400, hasOverlap, hasAnyOverlap } from "./whr.js";
import type { WhrRating } from "./whr.js";
import type { ModelConfig, PromptConfig, ConvergenceConfig } from "../types.js";

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

/** Tracks which work has already been completed or scheduled. */
export interface CompletedWork {
  /** Set of judgment dedup keys (see judgmentKey()). */
  judgments: Set<string>;
  /** Missing samples: "model:promptId:outputIndex" */
  missingSamples: Set<string>;
  /** Missing feedback: "fbModel:writerModel:promptId:outputIndex" */
  missingFeedback: Set<string>;
  /** Missing revisions: "writerModel:fbModel:promptId:outputIndex" */
  missingRevisions: Set<string>;
  /** Missing judgments: "modelA:modelB:promptId:idxA:idxB" (models sorted). All judges missed. */
  missingJudgments: Set<string>;
}

/** Create an empty CompletedWork with all sets initialized. */
export function emptyCompletedWork(): CompletedWork {
  return {
    judgments: new Set(),
    missingSamples: new Set(),
    missingFeedback: new Set(),
    missingRevisions: new Set(),
    missingJudgments: new Set(),
  };
}

// ── Rating Map ──────────────────────────────────────

/** Build a dimension:label → WhrRating lookup map from all three dimensions. */
export function buildRatingMap(
  writingRatings: WhrRating[],
  revisedRatings: WhrRating[],
  feedbackRatings: WhrRating[],
): Map<string, WhrRating> {
  const map = new Map<string, WhrRating>();
  for (const r of writingRatings) map.set(`writing:${r.model}`, r);
  for (const r of revisedRatings) map.set(`revised:${r.model}`, r);
  for (const r of feedbackRatings) map.set(`feedback:${r.model}`, r);
  return map;
}

// ── Convergence Helpers ─────────────────────────────

/** Format a convergence target for display: "±N" or "no overlap". */
export function formatConvergenceTarget(ciThreshold: number): string {
  return ciThreshold > 0 ? `±${ciThreshold}` : "no overlap";
}

/** Format a full convergence goal description for dry-run / log output. */
export function formatConvergenceDescription(ciThreshold: number): string {
  return ciThreshold > 0
    ? `all 95% CI half-widths are within ${formatConvergenceTarget(ciThreshold)} Elo points`
    : `no model's CI overlaps any other model's CI`;
}

/**
 * Check whether a model's CI is below the convergence threshold.
 * Always false in overlap-based mode (ciThreshold = 0), where
 * convergence is decided solely by overlap checks.
 */
function ciMeetsThreshold(r: WhrRating, convergence: ConvergenceConfig): boolean {
  return convergence.ciThreshold > 0 && r.ci95 <= convergence.ciThreshold;
}

// ── Formatting ──────────────────────────────────────

/** Look up a model's CI half-width from a dimension:label keyed map. */
function lookupCi(
  map: Map<string, WhrRating>,
  dimension: string,
  model: string,
): string {
  const r = map.get(`${dimension}:${model}`);
  if (!r) return "new";
  if (!Number.isFinite(r.ci95)) return "±∞";
  return `±${Math.round(r.ci95)}`;
}

/**
 * Format a concise human-readable description of a need, including
 * the rating dimension and CI values for the involved models.
 */
export function formatNeedDescription(
  need: Need,
  ratingMap: Map<string, WhrRating>,
): string {
  if (need.type === "initial_judgment") {
    const ciA = lookupCi(ratingMap, "writing", need.modelA);
    const ciB = lookupCi(ratingMap, "writing", need.modelB);
    return `writing: ${need.modelA} vs ${need.modelB} (${ciA} / ${ciB})`;
  }
  if (need.type === "improvement_judgment") {
    const ci = lookupCi(ratingMap, "feedback", need.feedbackModel);
    return `feedback: ${need.feedbackModel} on ${need.writer} (${ci})`;
  }
  // revised_judgment
  const ciA = lookupCi(ratingMap, "revised", need.modelA);
  const ciB = lookupCi(ratingMap, "revised", need.modelB);
  return `revision: ${need.modelA} vs ${need.modelB} fb:${need.feedbackModel} (${ciA} / ${ciB})`;
}

/** Summarize a batch of needs by type count. */
export function formatBatchSummary(needs: Need[]): string {
  let w = 0, f = 0, r = 0;
  for (const n of needs) {
    if (n.type === "initial_judgment") w++;
    else if (n.type === "improvement_judgment") f++;
    else r++;
  }
  return [
    w && `${w} writing`,
    f && `${f} feedback`,
    r && `${r} revision`,
  ].filter(Boolean).join(", ");
}

// ── Key Builders ────────────────────────────────────

/** Build a missing-sample key: "model:promptId:outputIndex". */
export function sampleKey(model: string, promptId: string, outputIdx: number): string {
  return `${model}:${promptId}:${outputIdx}`;
}

/** Build a missing-feedback key: "fbModel:writerModel:promptId:outputIndex". */
export function feedbackKey(fbModel: string, writerModel: string, promptId: string, outputIdx: number): string {
  return `${fbModel}:${writerModel}:${promptId}:${outputIdx}`;
}

/** Build a missing-revision key: "writerModel:fbModel:promptId:outputIndex". */
export function revisionKey(writerModel: string, fbModel: string, promptId: string, outputIdx: number): string {
  return `${writerModel}:${fbModel}:${promptId}:${outputIdx}`;
}

/** Build a judgment group key: "modelA:modelB:promptId:idxA:idxB" (models sorted, indices swapped to match). */
export function judgmentGroupKey(modelA: string, modelB: string, promptId: string, outputIdxA: number, outputIdxB: number): string {
  return modelA <= modelB
    ? `${modelA}:${modelB}:${promptId}:${outputIdxA}:${outputIdxB}`
    : `${modelB}:${modelA}:${promptId}:${outputIdxB}:${outputIdxA}`;
}

/**
 * Check whether a model's cascade (sample → feedback → revision) is
 * known-broken for a given prompt and output index.
 */
function isCascadeBroken(
  work: CompletedWork,
  model: string,
  fbModel: string,
  promptId: string,
  outputIdx: number,
): boolean {
  return work.missingSamples.has(sampleKey(model, promptId, outputIdx))
    || work.missingFeedback.has(feedbackKey(fbModel, model, promptId, outputIdx))
    || work.missingRevisions.has(revisionKey(model, fbModel, promptId, outputIdx));
}

/** Sum of all completed/missing entries for stall detection. */
export function completedWorkSize(work: CompletedWork): number {
  return work.judgments.size
    + work.missingSamples.size
    + work.missingFeedback.size
    + work.missingRevisions.size
    + work.missingJudgments.size;
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
 * comparisons. A pair is resolved when both models have enough games
 * AND either their CIs don't overlap (distinguishable) or both CIs
 * are individually below the CI threshold.
 */
function pairResolved(
  a: WhrRating,
  b: WhrRating,
  convergence: ConvergenceConfig,
): boolean {
  if (a.matchCount < convergence.minPairsPerModel
    || b.matchCount < convergence.minPairsPerModel) return false;
  return !hasOverlap(a, b)
    || (ciMeetsThreshold(a, convergence) && ciMeetsThreshold(b, convergence));
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
 * Scores are penalized by 1/(1 + maxOutputIndex) to enforce
 * breadth-first exploration: all prompts at output index N are
 * preferred before any prompt advances to N+1.
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
): { needs: Need[]; ratingMap: Map<string, WhrRating> } {
  const candidates: Need[] = [];
  const ratingMap = buildRatingMap(writingRatings, revisedRatings, feedbackRatings);

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

      const gain = informationGain(rA, rB) * convergence.writingWeight;

      for (let oi = 0; oi < outputsPerModel; oi++) {
        for (let oj = 0; oj < outputsPerModel; oj++) {
          for (const prompt of prompts) {
            // Prune: skip if either sample is known-missing
            if (completedWork.missingSamples.has(sampleKey(models[i].label, prompt.id, oi))
              || completedWork.missingSamples.has(sampleKey(models[j].label, prompt.id, oj))) continue;

            // Prune: skip if all judges missed this judgment group
            if (completedWork.missingJudgments.has(judgmentGroupKey(models[i].label, models[j].label, prompt.id, oi, oj))) continue;

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
                score: gain / (1 + Math.max(oi, oj)),
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

      const gain = informationGain(fbA, fbB) * convergence.feedbackWeight;

      // Each improvement comparison needs a writer to apply both feedbacks to
      for (const writer of models) {
        for (let oi = 0; oi < outputsPerModel; oi++) {
          for (const prompt of prompts) {
            // Pre-check per-side cascade deps and triple pruning (independent of judge).
            // isCascadeBroken checks sample, feedback, and revision for each side.
            const sideAMissing =
              isCascadeBroken(completedWork, writer.label, models[i].label, prompt.id, oi)
              || completedWork.missingJudgments.has(judgmentGroupKey(writer.label, models[i].label, prompt.id, oi, 0));
            const sideBMissing =
              isCascadeBroken(completedWork, writer.label, models[j].label, prompt.id, oi)
              || completedWork.missingJudgments.has(judgmentGroupKey(writer.label, models[j].label, prompt.id, oi, 0));
            if (sideAMissing && sideBMissing) continue;

            for (const judge of judgeModels) {
              // Emit needs for whichever side is incomplete
              const keyA = judgmentKey("improvement", writer.label, models[i].label, prompt.id, judge.label, oi);
              const keyB = judgmentKey("improvement", writer.label, models[j].label, prompt.id, judge.label, oi);
              if (completedWork.judgments.has(keyA) && completedWork.judgments.has(keyB)) continue;

              if (!sideAMissing && !completedWork.judgments.has(keyA)) {
                candidates.push({
                  type: "improvement_judgment",
                  writer: writer.label,
                  outputIdx: oi,
                  feedbackModel: models[i].label,
                  promptId: prompt.id,
                  judgeModel: judge,
                  score: gain / (1 + oi),
                });
              }
              if (!sideBMissing && !completedWork.judgments.has(keyB)) {
                candidates.push({
                  type: "improvement_judgment",
                  writer: writer.label,
                  outputIdx: oi,
                  feedbackModel: models[j].label,
                  promptId: prompt.id,
                  judgeModel: judge,
                  score: gain / (1 + oi),
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

      const gain = informationGain(rA, rB) * convergence.revisedWeight;

      for (let oi = 0; oi < outputsPerModel; oi++) {
        for (let oj = 0; oj < outputsPerModel; oj++) {
          for (const fbModel of models) {
            for (const prompt of prompts) {
              // Prune: skip if either side's cascade is broken or the triple is missing.
              // Both sides are required for revised comparisons (A's revision vs B's revision).
              if (isCascadeBroken(completedWork, models[i].label, fbModel.label, prompt.id, oi)
                || isCascadeBroken(completedWork, models[j].label, fbModel.label, prompt.id, oj)
                || completedWork.missingJudgments.has(judgmentGroupKey(models[i].label, models[j].label, `${prompt.id}:${fbModel.label}`, oi, oj))) continue;

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
                  score: gain / (1 + Math.max(oi, oj)),
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

  return { needs: selected, ratingMap };
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
    if (!ciMeetsThreshold(r, convergence) && hasAnyOverlap(r, ratings)) {
      return false;
    }
  }
  return true;
}
