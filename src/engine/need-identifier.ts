import { sigmoid, LOG10E_TIMES_400, hasOverlap, hasAnyOverlap } from "./whr.js";
import type { WhrRating } from "./whr.js";
import type { ModelConfig, PromptConfig, ConvergenceConfig } from "../types.js";
import type { JudgeQualityData } from "./judge-quality.js";
import { shouldPruneJudge } from "./judge-quality.js";

// ── Types ───────────────────────────────────────────

/** A single unit of work that can be pulled to reduce uncertainty. */
export type Need =
  | {
      type: "initial_judgment";
      modelA: ModelConfig;
      modelB: ModelConfig;
      outputIdxA: number;
      outputIdxB: number;
      promptId: string;
      judgeModel: ModelConfig;
      score: number;
    }
  | {
      type: "improvement_judgment";
      writer: ModelConfig;
      outputIdx: number;
      feedbackModel: ModelConfig;
      /** The opposing feedback model in this comparison (for batch diversification only). */
      againstFeedbackModel: ModelConfig;
      promptId: string;
      judgeModel: ModelConfig;
      score: number;
    }
  | {
      type: "revised_judgment";
      modelA: ModelConfig;
      modelB: ModelConfig;
      outputIdxA: number;
      outputIdxB: number;
      feedbackModel: ModelConfig;
      promptId: string;
      judgeModel: ModelConfig;
      score: number;
    };

/** Tracks which work has already been completed or scheduled. */
export interface CompletedWork {
  /** Set of judgment dedup keys (see judgmentKey()). */
  judgments: Set<string>;
  /** Missing samples keyed by canonical model ID, prompt, and output index. */
  missingSamples: Set<string>;
  /** Missing feedback keyed by canonical feedback/writer IDs, prompt, and output index. */
  missingFeedback: Set<string>;
  /** Missing revisions keyed by canonical writer/feedback IDs, prompt, and output index. */
  missingRevisions: Set<string>;
  /** Missing judgments:
   *  - initial/revised: canonical model pair, prompt, and output indices
   *  - improvement: canonical writer/feedback IDs, prompt, and output index
   *  All judges missed.
   */
  missingJudgments: Set<string>;
  /** Existing feedback artifacts (feedbackKey format). Used for cascade cost estimation. */
  existingFeedback: Set<string>;
  /** Existing revision artifacts (revisionKey format). Used for cascade cost estimation. */
  existingRevisions: Set<string>;
}

/** Create an empty CompletedWork with all sets initialized. */
export function emptyCompletedWork(): CompletedWork {
  return {
    judgments: new Set(),
    missingSamples: new Set(),
    missingFeedback: new Set(),
    missingRevisions: new Set(),
    missingJudgments: new Set(),
    existingFeedback: new Set(),
    existingRevisions: new Set(),
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

/**
 * Check whether a single model's rating is settled within a dimension.
 * Settled means: enough games AND (CI below threshold OR no overlap with neighbors).
 * Used by both dimensionConverged (for all models) and output cap gating (per model).
 */
export function isModelSettled(
  r: WhrRating,
  allRatings: WhrRating[],
  convergence: ConvergenceConfig,
): boolean {
  return r.matchCount >= convergence.minPairsPerModel
    && (ciMeetsThreshold(r, convergence) || !hasAnyOverlap(r, allRatings));
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
    const ciA = lookupCi(ratingMap, "writing", need.modelA.label);
    const ciB = lookupCi(ratingMap, "writing", need.modelB.label);
    return `writing: ${need.modelA.label} vs ${need.modelB.label} (${ciA} / ${ciB})`;
  }
  if (need.type === "improvement_judgment") {
    const ci = lookupCi(ratingMap, "feedback", need.feedbackModel.label);
    return `feedback: ${need.feedbackModel.label} on ${need.writer.label} (${ci})`;
  }
  // revised_judgment
  const ciA = lookupCi(ratingMap, "revised", need.modelA.label);
  const ciB = lookupCi(ratingMap, "revised", need.modelB.label);
  return `revision: ${need.modelA.label} vs ${need.modelB.label} fb:${need.feedbackModel.label} (${ciA} / ${ciB})`;
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

/** Build an asymmetric improvement judgment group key. */
export function improvementJudgmentGroupKey(
  writerModel: string,
  feedbackModel: string,
  promptId: string,
  outputIdx: number,
): string {
  return `${writerModel}:${feedbackModel}:${promptId}:${outputIdx}`;
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

/**
 * Count uncached cascade steps (feedback + revision) for a single
 * (writer, fbModel, prompt, outputIdx) tuple. Each uncached level is
 * one additional API call on top of the judgment itself.
 */
export function uncachedSteps(
  work: CompletedWork,
  writer: string,
  fbModel: string,
  promptId: string,
  outputIdx: number,
): number {
  return (work.existingFeedback.has(feedbackKey(fbModel, writer, promptId, outputIdx)) ? 0 : 1)
    + (work.existingRevisions.has(revisionKey(writer, fbModel, promptId, outputIdx)) ? 0 : 1);
}

// ── Batch Selection Helpers ─────────────────────────

/** Compute diversification key based on the player pair in each dimension.
 *  Keys are scoped per-group so no prefix is needed. */
function playerPairKey(c: Need): string {
  switch (c.type) {
    case "improvement_judgment":
      return [c.feedbackModel.registryId, c.againstFeedbackModel.registryId].sort().join(":");
    case "initial_judgment":
    case "revised_judgment":
      return [c.modelA.registryId, c.modelB.registryId].sort().join(":");
  }
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
  judgeQuality?: JudgeQualityData,
  modelOutputCaps?: Map<string, number>,
  fairCursor?: number,
): { needs: Need[]; ratingMap: Map<string, WhrRating>; fairCursor: number } {
  const candidates: Need[] = [];
  const ratingMap = buildRatingMap(writingRatings, revisedRatings, feedbackRatings);

  // Default rating for models not yet in WHR
  const defaultRating: WhrRating = {
    model: "", rating: 1500, ci95: Infinity,
    wins: 0, losses: 0, ties: 0, matchCount: 0,
  };

  // Default judge quality data: all weights 1.0, no pruning.
  const jq: JudgeQualityData = judgeQuality ?? {
    ratings: [], weights: new Map(), active: false, instanceCount: 0,
  };

  // Pre-filter pruned judges (shouldPruneJudge handles bootstrap; fallback keeps all if all pruned)
  let effectiveJudges = judgeModels.filter(
    (j) => !shouldPruneJudge(jq, j.label, convergence.judgePruneThreshold),
  );
  if (effectiveJudges.length === 0) effectiveJudges = judgeModels;

  // Judge weights: use jq.weights directly (defaults to 1.0 for unknown judges)
  const jw = jq.weights;

  // Per-model output cap: breadth-first enforcement -- a model must cover
  // all prompts at depth N before advancing to N+1.
  const capFor = (model: ModelConfig) => modelOutputCaps?.get(model.registryId) ?? outputsPerModel;

  // ── Initial judgment needs ────────────────────────
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const rA = ratingMap.get(`writing:${models[i].label}`) ?? { ...defaultRating, model: models[i].label };
      const rB = ratingMap.get(`writing:${models[j].label}`) ?? { ...defaultRating, model: models[j].label };

      if (pairResolved(rA, rB, convergence)) continue;

      const gain = informationGain(rA, rB) * convergence.writingWeight;

      for (let oi = 0; oi < capFor(models[i]); oi++) {
        for (let oj = 0; oj < capFor(models[j]); oj++) {
          for (const prompt of prompts) {
            // Prune: skip if either sample is known-missing
            if (completedWork.missingSamples.has(sampleKey(models[i].registryId, prompt.id, oi))
              || completedWork.missingSamples.has(sampleKey(models[j].registryId, prompt.id, oj))) continue;

            // Prune: skip if all judges missed this judgment group
            if (completedWork.missingJudgments.has(judgmentGroupKey(models[i].registryId, models[j].registryId, prompt.id, oi, oj))) continue;

            for (const judge of effectiveJudges) {
              const key = judgmentKey(
                "initial", models[i].registryId, models[j].registryId,
                prompt.id, judge.registryId, oi, oj,
              );
              if (completedWork.judgments.has(key)) continue;

              const judgeWeight = jw.get(judge.label) ?? 1.0;
              candidates.push({
                type: "initial_judgment",
                modelA: models[i],
                modelB: models[j],
                outputIdxA: oi,
                outputIdxB: oj,
                promptId: prompt.id,
                judgeModel: judge,
                score: gain * judgeWeight / (1 + Math.max(oi, oj)),
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
        for (let oi = 0; oi < capFor(writer); oi++) {
          for (const prompt of prompts) {
            // Pre-check per-side cascade deps and triple pruning (independent of judge).
            // isCascadeBroken checks sample, feedback, and revision for each side.
            const sideAMissing =
              isCascadeBroken(completedWork, writer.registryId, models[i].registryId, prompt.id, oi)
              || completedWork.missingJudgments.has(improvementJudgmentGroupKey(
                writer.registryId,
                models[i].registryId,
                prompt.id,
                oi,
              ));
            const sideBMissing =
              isCascadeBroken(completedWork, writer.registryId, models[j].registryId, prompt.id, oi)
              || completedWork.missingJudgments.has(improvementJudgmentGroupKey(
                writer.registryId,
                models[j].registryId,
                prompt.id,
                oi,
              ));
            if (sideAMissing && sideBMissing) continue;

            // Cascade cost: 1 (judgment) + uncached intermediate steps.
            // Only computed for non-missing sides (missing sides emit no needs).
            const costA = sideAMissing ? 0
              : 1 + uncachedSteps(completedWork, writer.registryId, models[i].registryId, prompt.id, oi);
            const costB = sideBMissing ? 0
              : 1 + uncachedSteps(completedWork, writer.registryId, models[j].registryId, prompt.id, oi);

            for (const judge of effectiveJudges) {
              // Emit needs for whichever side is incomplete
              const keyA = judgmentKey("improvement", writer.registryId, models[i].registryId, prompt.id, judge.registryId, oi);
              const keyB = judgmentKey("improvement", writer.registryId, models[j].registryId, prompt.id, judge.registryId, oi);
              if (completedWork.judgments.has(keyA) && completedWork.judgments.has(keyB)) continue;

              const judgeWeight = jw.get(judge.label) ?? 1.0;
              if (!sideAMissing && !completedWork.judgments.has(keyA)) {
                candidates.push({
                  type: "improvement_judgment",
                  writer,
                  outputIdx: oi,
                  feedbackModel: models[i],
                  againstFeedbackModel: models[j],
                  promptId: prompt.id,
                  judgeModel: judge,
                  score: gain * judgeWeight / (1 + oi) / costA,
                });
              }
              if (!sideBMissing && !completedWork.judgments.has(keyB)) {
                candidates.push({
                  type: "improvement_judgment",
                  writer,
                  outputIdx: oi,
                  feedbackModel: models[j],
                  againstFeedbackModel: models[i],
                  promptId: prompt.id,
                  judgeModel: judge,
                  score: gain * judgeWeight / (1 + oi) / costB,
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

      for (let oi = 0; oi < capFor(models[i]); oi++) {
        for (let oj = 0; oj < capFor(models[j]); oj++) {
          for (const fbModel of models) {
            for (const prompt of prompts) {
              // Prune: skip if either side's cascade is broken or the triple is missing.
              // Both sides are required for revised comparisons (A's revision vs B's revision).
              if (isCascadeBroken(completedWork, models[i].registryId, fbModel.registryId, prompt.id, oi)
                || isCascadeBroken(completedWork, models[j].registryId, fbModel.registryId, prompt.id, oj)
                || completedWork.missingJudgments.has(judgmentGroupKey(models[i].registryId, models[j].registryId, `${prompt.id}:${fbModel.registryId}`, oi, oj))) continue;

              // Cascade cost: 1 (judgment) + uncached steps for both sides.
              const revisedCost = 1
                + uncachedSteps(completedWork, models[i].registryId, fbModel.registryId, prompt.id, oi)
                + uncachedSteps(completedWork, models[j].registryId, fbModel.registryId, prompt.id, oj);

              for (const judge of effectiveJudges) {
                const key = judgmentKey(
                  "revised", models[i].registryId, models[j].registryId,
                  `${prompt.id}:${fbModel.registryId}`, judge.registryId, oi, oj,
                );
                if (completedWork.judgments.has(key)) continue;

                const judgeWeight = jw.get(judge.label) ?? 1.0;
                candidates.push({
                  type: "revised_judgment",
                  modelA: models[i],
                  modelB: models[j],
                  outputIdxA: oi,
                  outputIdxB: oj,
                  feedbackModel: fbModel,
                  promptId: prompt.id,
                  judgeModel: judge,
                  score: gain * judgeWeight / (1 + Math.max(oi, oj)) / revisedCost,
                });
              }
            }
          }
        }
      }
    }
  }

  // ── Dimension-proportional batch selection ─────────
  // Split candidates by dimension, allocate exact quotas fairly, then
  // select top candidates per dimension with per-pair diversification.
  // Output size is bounded by construction; no post-hoc truncation.
  const initialCandidates: Need[] = [];
  const improvementCandidates: Need[] = [];
  const revisedCandidates: Need[] = [];

  for (const c of candidates) {
    if (c.type === "initial_judgment") initialCandidates.push(c);
    else if (c.type === "improvement_judgment") improvementCandidates.push(c);
    else revisedCandidates.push(c);
  }

  const groups = [
    { candidates: initialCandidates, weight: convergence.writingWeight },
    { candidates: improvementCandidates, weight: convergence.feedbackWeight },
    { candidates: revisedCandidates, weight: convergence.revisedWeight },
  ];
  for (const g of groups) g.candidates.sort((a, b) => b.score - a.score);
  const allocations = groups.map(() => 0);
  const activeIndices = groups
    .map((g, i) => (g.candidates.length > 0 ? i : -1))
    .filter((i) => i >= 0);
  const availableTotal = activeIndices.reduce((s, gi) => s + groups[gi].candidates.length, 0);
  const targetTotal = Math.min(Math.max(batchSize, 0), availableTotal);

  let nextFairCursor = fairCursor ?? 0;

  if (targetTotal > 0 && activeIndices.length > 0) {
    if (targetTotal < activeIndices.length) {
      const start = ((nextFairCursor % activeIndices.length) + activeIndices.length) % activeIndices.length;
      for (let k = 0; k < targetTotal; k++) {
        const gi = activeIndices[(start + k) % activeIndices.length];
        allocations[gi] = 1;
      }
      nextFairCursor += targetTotal;
    } else {
      for (const gi of activeIndices) allocations[gi] = 1;

      let remaining = targetTotal - activeIndices.length;
      const rooms = groups.map((g, gi) => g.candidates.length - allocations[gi]);

      const rawWeights = activeIndices.map((gi) => Math.max(0, groups[gi].weight));
      const totalWeight = rawWeights.reduce((s, w) => s + w, 0);
      const normalizedWeights = totalWeight > 0
        ? rawWeights.map((w) => w / totalWeight)
        : rawWeights.map(() => 1 / activeIndices.length);

      const remainders = new Map<number, number>();
      for (let i = 0; i < activeIndices.length; i++) {
        const gi = activeIndices[i];
        const raw = remaining * normalizedWeights[i];
        const base = Math.min(Math.floor(raw), rooms[gi]);
        allocations[gi] += base;
        rooms[gi] -= base;
        remainders.set(gi, raw - Math.floor(raw));
      }

      remaining = targetTotal - allocations.reduce((s, a) => s + a, 0);
      while (remaining > 0) {
        const candidatesWithRoom = activeIndices.filter((gi) => rooms[gi] > 0);
        if (candidatesWithRoom.length === 0) break;

        candidatesWithRoom.sort((a, b) => {
          const ra = remainders.get(a) ?? 0;
          const rb = remainders.get(b) ?? 0;
          if (rb !== ra) return rb - ra;
          return a - b;
        });

        const pick = candidatesWithRoom[0];
        allocations[pick]++;
        rooms[pick]--;
        remainders.set(pick, -1);
        remaining--;
      }
    }
  }

  // Select from each group with per-pair diversification.
  // Diversification keys are based on the *player pair* in each dimension:
  //   - Initial: sorted writer pair (modelA, modelB)
  //   - Improvement: sorted feedback model pair (feedbackModel, againstFeedbackModel)
  //   - Revised: sorted writer pair (modelA, modelB)
  // maxPerPair is computed per-group so small allocations still cover
  // multiple player pairs instead of concentrating on one.
  const selected: Need[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    if (allocations[gi] <= 0) continue;

    // Compute per-group maxPerPair based on unique player pairs
    const pairKeys = new Set<string>();
    for (const c of groups[gi].candidates) {
      pairKeys.add(playerPairKey(c));
    }
    const groupMaxPerPair = Math.max(
      2,
      Math.ceil(allocations[gi] / Math.max(1, pairKeys.size)),
    );

    const pairCount = new Map<string, number>();
    let groupSelected = 0;
    for (const candidate of groups[gi].candidates) {
      if (groupSelected >= allocations[gi]) break;

      const pk = playerPairKey(candidate);
      const count = pairCount.get(pk) ?? 0;
      if (count >= groupMaxPerPair) continue;

      selected.push(candidate);
      pairCount.set(pk, count + 1);
      groupSelected++;
    }

    // Backfill if diversification limits prevented filling the quota.
    if (groupSelected < allocations[gi]) {
      for (const candidate of groups[gi].candidates) {
        if (groupSelected >= allocations[gi]) break;
        if (selected.includes(candidate)) continue;
        selected.push(candidate);
        groupSelected++;
      }
    }
  }

  // ── Interleave by model for load spreading ────────
  // Group needs by their primary model (the model most likely to require
  // a fresh API call), then round-robin across groups. Within each group,
  // needs retain their score-descending order. This ensures the batch
  // hits different models early instead of saturating one model's
  // concurrency gate before touching others.
  return { needs: interleaveByModel(selected), ratingMap, fairCursor: nextFairCursor };
}

/**
 * Check whether all three dimensions have converged.
 */
export function isConverged(
  writingRatings: WhrRating[],
  revisedRatings: WhrRating[],
  feedbackRatings: WhrRating[],
  convergence: ConvergenceConfig,
  modelCount: number,
): boolean {
  return (
    dimensionConverged(writingRatings, convergence, modelCount) &&
    dimensionConverged(revisedRatings, convergence, modelCount) &&
    dimensionConverged(feedbackRatings, convergence, modelCount)
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
  modelCount: number,
): boolean {
  if (ratings.length === 0) return false;
  // All configured models must have ratings -- a model with zero games
  // is absent from WHR output and must not be silently "converged".
  if (ratings.length < modelCount) return false;
  for (const r of ratings) {
    if (!isModelSettled(r, ratings, convergence)) return false;
  }
  return true;
}

// ── Need Interleaving ───────────────────────────────

/**
 * Extract the primary canonical model ID from a need -- the model most likely to
 * trigger a fresh API call (the writer or first model in the pair).
 */
export function primaryModel(need: Need): string {
  return need.type === "improvement_judgment"
    ? need.writer.registryId : need.modelA.registryId;
}

/**
 * Interleave needs by primary model using round-robin. Within each
 * model's bucket, needs retain their original (score-descending) order.
 * This spreads concurrent API calls across models instead of front-loading
 * all requests for the highest-uncertainty pair.
 */
export function interleaveByModel(needs: Need[]): Need[] {
  if (needs.length <= 1) return needs;

  // Group by primary model, preserving insertion order; round-robin across groups
  const buckets = new Map<string, Need[]>();
  for (const n of needs) {
    const key = primaryModel(n);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(n);
  }
  const groups = [...buckets.values()];
  const result: Need[] = [];
  const maxLen = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < maxLen; i++) {
    for (const g of groups) {
      if (i < g.length) result.push(g[i]);
    }
  }
  return result;
}
