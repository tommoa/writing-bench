import type { PairwiseJudgment } from "../types.js";
import { MIN_JUDGE_WEIGHT } from "./judge-quality.js";

// ── Constants ───────────────────────────────────────

/** Minimum decisive self-judgments before self-preference bias is reported. */
export const MIN_SELF_JUDGMENTS = 8;

/** Minimum judgments with position data before position bias is reported. */
export const MIN_POSITION_JUDGMENTS = 10;

/** Bias magnitude below which no correction is applied. */
export const BIAS_DEAD_ZONE = 0.05;

// ── Types ───────────────────────────────────────────

/** Per-judge self-preference bias statistics. */
export interface SelfPreferenceBias {
  /** Total judgments where this judge evaluated a pair containing its own writing. */
  selfJudgmentCount: number;
  /** Of those, how many the judge voted for its own sample (excluding ties). */
  selfWins: number;
  /** Of those, how many were ties. */
  selfTies: number;
  /** selfWins / (selfJudgmentCount - selfTies). NaN if no decisive self-judgments. */
  selfWinRate: number;
  /** Expected win rate for this judge's model based on OTHER judges' verdicts
   *  on the same pairs. NaN if insufficient cross-judge data. */
  expectedWinRate: number;
  /** selfWinRate - expectedWinRate. Positive = favors own writing. */
  biasDelta: number;
  /** Whether we have enough data to report this bias. */
  sufficient: boolean;
}

/** Per-judge position bias statistics. */
export interface PositionBias {
  /** Total judgments with known position data (positionSwapped !== undefined). */
  positionKnownCount: number;
  /** Wins for the sample presented in position A (as seen by judge, before correction). */
  presentedAWins: number;
  /** Ties. */
  presentedTies: number;
  /** presentedAWins / (positionKnownCount - presentedTies). NaN if no decisive judgments. */
  positionARate: number;
  /** Deviation from 0.5. Positive = favors position A. */
  positionBiasDelta: number;
  /** Whether we have enough data to report this bias. */
  sufficient: boolean;
}

/** Combined bias data for all judges. */
export interface JudgeBiasData {
  selfPreference: Map<string, SelfPreferenceBias>;
  positionBias: Map<string, PositionBias>;
}

// ── Self-Preference Bias ────────────────────────────

/**
 * Compute per-judge self-preference bias statistics.
 *
 * A "self-judgment" is one where the judge model label matches one of
 * the two compared samples' model labels (looked up via sampleToModel).
 *
 * The expected win rate is computed from OTHER judges' verdicts on pairs
 * between the same model pair (grouped by writer labels, not exact sample
 * IDs). This aggregation across output indices and prompts provides a
 * robust baseline even when the adaptive loop converges before every
 * judge covers the same exact sample pairs.
 */
export function computeSelfPreferenceBias(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
  judgeLabels: string[],
): Map<string, SelfPreferenceBias> {
  // Build a set of judge labels for fast lookup
  const judgeLabelSet = new Set(judgeLabels);

  // Per-judge self-judgment accumulators
  const selfCounts = new Map<string, { count: number; wins: number; ties: number }>();
  for (const label of judgeLabels) {
    selfCounts.set(label, { count: 0, wins: 0, ties: 0 });
  }

  // Group all verdicts by (writerModelA, writerModelB, stage) for pairs
  // where at least one side was written by a judge model. Each verdict
  // stores the judge, winner, and which writer model is on which side
  // (since different sample orderings within the same model-pair group
  // may swap A/B positions).
  type Verdict = {
    judgeModel: string;
    winner: "A" | "B" | "tie";
    modelALabel: string;
    modelBLabel: string;
  };
  const modelPairGroups = new Map<string, Verdict[]>();

  for (const j of judgments) {
    const modelA = sampleToModel.get(j.sampleA);
    const modelB = sampleToModel.get(j.sampleB);
    if (!modelA || !modelB) continue;

    // Track self-judgment counts
    const isSelfA = j.judgeModel === modelA;
    const isSelfB = j.judgeModel === modelB;
    if (isSelfA || isSelfB) {
      const ownSide: "A" | "B" = isSelfA ? "A" : "B";
      const acc = selfCounts.get(j.judgeModel);
      if (acc) {
        acc.count++;
        if (j.winner === "tie") acc.ties++;
        else if (j.winner === ownSide) acc.wins++;
      }
    }

    // Only group pairs where at least one side is a judge model
    if (!judgeLabelSet.has(modelA) && !judgeLabelSet.has(modelB)) continue;

    // Canonical key: sort model labels so (A-vs-B) and (B-vs-A) map to same group
    const [sortedFirst, sortedSecond] = modelA < modelB
      ? [modelA, modelB] : [modelB, modelA];
    const pairKey = `${sortedFirst}\0${sortedSecond}\0${j.stage}`;
    let group = modelPairGroups.get(pairKey);
    if (!group) {
      group = [];
      modelPairGroups.set(pairKey, group);
    }
    group.push({
      judgeModel: j.judgeModel,
      winner: j.winner,
      modelALabel: modelA,
      modelBLabel: modelB,
    });
  }

  // Compute expected win rate per judge from other judges' verdicts on
  // model pairs involving that judge's model.
  const result = new Map<string, SelfPreferenceBias>();

  for (const label of judgeLabels) {
    const acc = selfCounts.get(label)!;
    const decisive = acc.count - acc.ties;
    const selfWinRate = decisive > 0 ? acc.wins / decisive : NaN;

    let expectedWins = 0;
    let expectedDecisive = 0;

    for (const verdicts of modelPairGroups.values()) {
      for (const v of verdicts) {
        // Only use verdicts from OTHER judges
        if (v.judgeModel === label) continue;
        if (v.winner === "tie") continue;

        // Determine which side this judge's model is on for THIS verdict
        let ownSide: "A" | "B" | null = null;
        if (v.modelALabel === label) ownSide = "A";
        else if (v.modelBLabel === label) ownSide = "B";
        if (!ownSide) continue;

        expectedDecisive++;
        if (v.winner === ownSide) expectedWins++;
      }
    }

    const expectedWinRate = expectedDecisive > 0 ? expectedWins / expectedDecisive : NaN;
    const biasDelta = selfWinRate - expectedWinRate;

    result.set(label, {
      selfJudgmentCount: acc.count,
      selfWins: acc.wins,
      selfTies: acc.ties,
      selfWinRate,
      expectedWinRate,
      biasDelta,
      sufficient: !isNaN(biasDelta) && decisive >= MIN_SELF_JUDGMENTS,
    });
  }

  return result;
}

// ── Position Bias ───────────────────────────────────

/**
 * Compute per-judge position bias statistics.
 *
 * Uses the positionSwapped field to determine which position each sample
 * was presented in. Only considers judgments where positionSwapped is defined.
 *
 * A presented-A win means the judge chose whichever sample was in the A
 * position AS PRESENTED TO THE JUDGE (before correction):
 *   - If !swapped and winner === "A": judge picked presented-A → presented-A win
 *   - If swapped and winner === "B": judge picked what was originally presented
 *     as A (now corrected to B) → presented-A win
 */
export function computePositionBias(
  judgments: PairwiseJudgment[],
  judgeLabels: string[],
): Map<string, PositionBias> {
  const acc = new Map<string, { count: number; aWins: number; ties: number }>();
  for (const label of judgeLabels) {
    acc.set(label, { count: 0, aWins: 0, ties: 0 });
  }

  for (const j of judgments) {
    if (j.positionSwapped == null) continue;
    const entry = acc.get(j.judgeModel);
    if (!entry) continue;

    entry.count++;
    if (j.winner === "tie") {
      entry.ties++;
    } else {
      const presentedAWon =
        (!j.positionSwapped && j.winner === "A") ||
        (j.positionSwapped && j.winner === "B");
      if (presentedAWon) entry.aWins++;
    }
  }

  const result = new Map<string, PositionBias>();
  for (const label of judgeLabels) {
    const a = acc.get(label)!;
    const decisive = a.count - a.ties;
    const positionARate = decisive > 0 ? a.aWins / decisive : NaN;
    result.set(label, {
      positionKnownCount: a.count,
      presentedAWins: a.aWins,
      presentedTies: a.ties,
      positionARate,
      positionBiasDelta: positionARate - 0.5,
      sufficient: decisive >= MIN_POSITION_JUDGMENTS,
    });
  }

  return result;
}

// ── Combined Computation ────────────────────────────

/**
 * Compute all bias statistics for all judges.
 */
export function computeJudgeBias(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
  judgeLabels: string[],
): JudgeBiasData {
  return {
    selfPreference: computeSelfPreferenceBias(judgments, sampleToModel, judgeLabels),
    positionBias: computePositionBias(judgments, judgeLabels),
  };
}

// ── Adaptive Correction ─────────────────────────────

/**
 * Compute per-judgment bias correction factors.
 *
 * For each self-judgment (judge evaluating pair containing its own model):
 *   - If the judge voted for its own model AND bias is significant:
 *     factor = max(MIN_JUDGE_WEIGHT, 1 - biasDelta)
 *   - If the judge voted against its own model or tied: factor = 1.0
 *   - During bootstrap (insufficient data): factor = 1.0
 *
 * For non-self judgments: factor = 1.0 (no correction).
 *
 * Only positive bias (self-preference) triggers down-weighting.
 * Negative bias (disfavoring own work) does not trigger any correction.
 */
export function computeBiasCorrections(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
  biasData: JudgeBiasData,
): Map<string, number> {
  const corrections = new Map<string, number>();

  for (const j of judgments) {
    const modelA = sampleToModel.get(j.sampleA);
    const modelB = sampleToModel.get(j.sampleB);

    const isSelfA = j.judgeModel === modelA;
    const isSelfB = j.judgeModel === modelB;

    // Only self-judgments can be corrected; non-self default to 1.0 via
    // the fallback in composeWeights, so we keep the map sparse.
    if (!isSelfA && !isSelfB) continue;

    const bias = biasData.selfPreference.get(j.judgeModel);
    if (!bias || !bias.sufficient || bias.biasDelta <= BIAS_DEAD_ZONE) continue;

    // Only correct when the judge voted FOR its own model
    const ownSide: "A" | "B" = isSelfA ? "A" : "B";
    if (j.winner !== ownSide) continue;

    // Proportional correction: down-weight by the excess bias
    const factor = Math.max(MIN_JUDGE_WEIGHT, 1.0 - bias.biasDelta);
    corrections.set(j.id, factor);
  }

  return corrections;
}

// ── Weight Composition ──────────────────────────────

/**
 * Build per-judgment effective weights by composing judge quality weights
 * with per-judgment bias corrections.
 *
 * effectiveWeight = (judgeWeights[judgeModel] ?? 1.0) * biasCorrections[id]
 */
export function composeWeights(
  judgments: PairwiseJudgment[],
  judgeWeights: Map<string, number> | undefined,
  biasCorrections: Map<string, number>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const j of judgments) {
    const qualityWeight = judgeWeights?.get(j.judgeModel) ?? 1.0;
    const biasCorrection = biasCorrections.get(j.id) ?? 1.0;
    result.set(j.id, Math.max(MIN_JUDGE_WEIGHT, qualityWeight * biasCorrection));
  }
  return result;
}
