import type { EloRating, PairwiseJudgment, PairwiseRecord } from "../types.js";

const DEFAULT_RATING = 1500;
const BT_MAX_ITER = 50;
const BT_TOLERANCE = 1e-6;

/**
 * Calculate the expected score for player A against player B.
 * P(A beats B) = p_A / (p_A + p_B), equivalent to the logistic formula.
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
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

// ── Pairwise Win Matrix ─────────────────────────────

/**
 * A pairwise win matrix indexed by model name.
 * wins[a][b] = number of times model a beat model b.
 * ties[a][b] = number of ties between a and b (symmetric).
 */
interface WinMatrix {
  models: string[];
  wins: Map<string, Map<string, number>>;
  ties: Map<string, Map<string, number>>;
}

function createWinMatrix(models: string[]): WinMatrix {
  const wins = new Map<string, Map<string, number>>();
  const ties = new Map<string, Map<string, number>>();
  for (const m of models) {
    wins.set(m, new Map());
    ties.set(m, new Map());
  }
  return { models, wins, ties };
}

function addWin(matrix: WinMatrix, winner: string, loser: string): void {
  const row = matrix.wins.get(winner);
  if (row) row.set(loser, (row.get(loser) ?? 0) + 1);
}

function addTie(matrix: WinMatrix, a: string, b: string): void {
  const rowA = matrix.ties.get(a);
  const rowB = matrix.ties.get(b);
  if (rowA) rowA.set(b, (rowA.get(b) ?? 0) + 1);
  if (rowB) rowB.set(a, (rowB.get(a) ?? 0) + 1);
}

function getWins(matrix: WinMatrix, a: string, b: string): number {
  return matrix.wins.get(a)?.get(b) ?? 0;
}

function getTies(matrix: WinMatrix, a: string, b: string): number {
  return matrix.ties.get(a)?.get(b) ?? 0;
}

/**
 * Total matches between a and b (wins_a + wins_b + ties).
 */
function totalMatches(matrix: WinMatrix, a: string, b: string): number {
  return getWins(matrix, a, b) + getWins(matrix, b, a) + getTies(matrix, a, b);
}

// ── Bradley-Terry Core ──────────────────────────────

/**
 * Compute Bradley-Terry strength estimates from a pairwise win matrix.
 * Returns a Map of model -> strength parameter.
 *
 * Uses the iterative multiplicative update:
 *   score_i = wins_i + 0.5 * ties_i
 *   expected_i = sum_j N_ij * p_i / (p_i + p_j)
 *   p_i <- score_i / expected_i * p_i
 *   normalize by geometric mean
 */
function bradleyTerry(matrix: WinMatrix): Map<string, number> {
  const { models } = matrix;
  if (models.length === 0) return new Map();

  // Initialize all strengths to 1
  const p = new Map<string, number>();
  for (const m of models) p.set(m, 1.0);

  for (let iter = 0; iter < BT_MAX_ITER; iter++) {
    let maxDelta = 0;

    for (const i of models) {
      // Observed score: wins + 0.5 * ties
      let score = 0;
      let expected = 0;

      for (const j of models) {
        if (i === j) continue;
        const nij = totalMatches(matrix, i, j);
        if (nij === 0) continue;

        score += getWins(matrix, i, j) + 0.5 * getTies(matrix, i, j);

        const pi = p.get(i)!;
        const pj = p.get(j)!;
        expected += nij * pi / (pi + pj);
      }

      if (expected > 0 && score > 0) {
        const oldP = p.get(i)!;
        const newP = (score / expected) * oldP;
        p.set(i, newP);
        maxDelta = Math.max(maxDelta, Math.abs(newP - oldP) / oldP);
      }
    }

    // Normalize by geometric mean
    const logSum = Array.from(p.values()).reduce((s, v) => s + Math.log(v), 0);
    const geoMean = Math.exp(logSum / models.length);
    for (const m of models) p.set(m, p.get(m)! / geoMean);

    if (maxDelta < BT_TOLERANCE) break;
  }

  return p;
}

/**
 * Convert BT strengths to ELO-scale ratings.
 * rating = 400 * log10(strength) + 1500
 */
function strengthToRating(strength: number): number {
  return Math.round(400 * Math.log10(strength) + DEFAULT_RATING);
}

/**
 * Build EloRating[] from a win matrix using Bradley-Terry.
 */
function ratingsFromMatrix(matrix: WinMatrix): EloRating[] {
  const strengths = bradleyTerry(matrix);
  const ratings: EloRating[] = [];

  for (const model of matrix.models) {
    let wins = 0, losses = 0, ties = 0, matchCount = 0;

    for (const opp of matrix.models) {
      if (model === opp) continue;
      wins += getWins(matrix, model, opp);
      losses += getWins(matrix, opp, model);
      ties += getTies(matrix, model, opp);
    }
    matchCount = wins + losses + ties;

    ratings.push({
      model,
      rating: matchCount > 0 ? strengthToRating(strengths.get(model) ?? 1) : DEFAULT_RATING,
      wins,
      losses,
      ties,
      matchCount,
    });
  }

  return ratings.sort((a, b) => b.rating - a.rating);
}

// ── Public API ──────────────────────────────────────

/**
 * Build a win matrix from pairwise judgments.
 */
function buildMatrixFromJudgments(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
): WinMatrix {
  const modelSet = new Set(sampleToModel.values());
  const matrix = createWinMatrix(Array.from(modelSet));

  for (const j of judgments) {
    const modelA = sampleToModel.get(j.sampleA);
    const modelB = sampleToModel.get(j.sampleB);
    if (!modelA || !modelB || modelA === modelB) continue;

    // Ensure models are in the matrix (might not be if set was incomplete)
    if (!matrix.wins.has(modelA)) {
      matrix.models.push(modelA);
      matrix.wins.set(modelA, new Map());
      matrix.ties.set(modelA, new Map());
    }
    if (!matrix.wins.has(modelB)) {
      matrix.models.push(modelB);
      matrix.wins.set(modelB, new Map());
      matrix.ties.set(modelB, new Map());
    }

    if (j.winner === "A") addWin(matrix, modelA, modelB);
    else if (j.winner === "B") addWin(matrix, modelB, modelA);
    else addTie(matrix, modelA, modelB);
  }

  return matrix;
}

/**
 * Process a list of judgments and compute ratings for all models
 * using Bradley-Terry maximum likelihood estimation.
 * Order-independent: the same set of judgments always produces
 * the same ratings regardless of input order.
 */
export function computeEloFromJudgments(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
): EloRating[] {
  const matrix = buildMatrixFromJudgments(judgments, sampleToModel);
  return ratingsFromMatrix(matrix);
}

/**
 * Compute feedback ELO from revised-stage judgments.
 * Credits the feedback provider whose feedback was used in the winning sample.
 */
export function computeFeedbackElo(
  judgments: PairwiseJudgment[],
  sampleToFeedbackModel: Map<string, string>,
): EloRating[] {
  // Same as writer ELO but keyed by feedback model
  const matrix = buildMatrixFromJudgments(judgments, sampleToFeedbackModel);
  return ratingsFromMatrix(matrix);
}

/**
 * Compute feedback ELO from improvement judgments.
 * Groups by (promptId, judgeModel), then pairs different feedback
 * providers and compares their improvement rates.
 */
export function computeFeedbackEloFromImprovements(
  improvementJudgments: PairwiseJudgment[],
  sampleToFeedbackModel: Map<string, string>,
): EloRating[] {
  const matrix = buildImprovementMatrix(improvementJudgments, sampleToFeedbackModel);
  return ratingsFromMatrix(matrix);
}

/**
 * Build a win matrix from improvement judgments using the grouped-pairing logic.
 */
function buildImprovementMatrix(
  improvementJudgments: PairwiseJudgment[],
  sampleToFeedbackModel: Map<string, string>,
): WinMatrix {
  const allModels = new Set(sampleToFeedbackModel.values());
  const matrix = createWinMatrix(Array.from(allModels));

  // Group by (promptId, judgeModel)
  type ImpResult = { feedbackModel: string; winner: "A" | "B" | "tie" };
  const groups = new Map<string, ImpResult[]>();

  for (const j of improvementJudgments) {
    const fbModel = sampleToFeedbackModel.get(j.sampleB);
    if (!fbModel) continue;
    const groupKey = `${j.promptId}:${j.judgeModel}`;
    const group = groups.get(groupKey) ?? [];
    group.push({ feedbackModel: fbModel, winner: j.winner });
    groups.set(groupKey, group);
  }

  // Within each group, pair up different feedback models
  for (const results of groups.values()) {
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i];
        const b = results[j];
        if (a.feedbackModel === b.feedbackModel) continue;

        const aImproved = a.winner === "B"; // revision beat original
        const bImproved = b.winner === "B";

        if (aImproved && !bImproved) addWin(matrix, a.feedbackModel, b.feedbackModel);
        else if (!aImproved && bImproved) addWin(matrix, b.feedbackModel, a.feedbackModel);
        else addTie(matrix, a.feedbackModel, b.feedbackModel);
      }
    }
  }

  return matrix;
}

// ── Pairwise Record Helpers ─────────────────────────

/**
 * Extract PairwiseRecords from a win matrix (for cumulative storage).
 */
export function matrixToRecords(matrix: WinMatrix): PairwiseRecord[] {
  const records: PairwiseRecord[] = [];
  const { models } = matrix;

  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i];
      const b = models[j];
      const wA = getWins(matrix, a, b);
      const wB = getWins(matrix, b, a);
      const t = getTies(matrix, a, b);
      if (wA + wB + t > 0) {
        records.push({ modelA: a, modelB: b, winsA: wA, winsB: wB, ties: t });
      }
    }
  }

  return records;
}

/**
 * Merge new PairwiseRecords into existing ones.
 * Records are keyed by sorted (modelA, modelB) pair.
 */
export function mergeRecords(
  existing: PairwiseRecord[],
  incoming: PairwiseRecord[],
): PairwiseRecord[] {
  const map = new Map<string, PairwiseRecord>();

  for (const r of existing) {
    const [a, b] = [r.modelA, r.modelB].sort();
    const key = `${a}:${b}`;
    const flipped = a !== r.modelA;
    map.set(key, {
      modelA: a,
      modelB: b,
      winsA: flipped ? r.winsB : r.winsA,
      winsB: flipped ? r.winsA : r.winsB,
      ties: r.ties,
    });
  }

  for (const r of incoming) {
    const [a, b] = [r.modelA, r.modelB].sort();
    const key = `${a}:${b}`;
    const flipped = a !== r.modelA;
    const wA = flipped ? r.winsB : r.winsA;
    const wB = flipped ? r.winsA : r.winsB;
    const prev = map.get(key);
    if (prev) {
      prev.winsA += wA;
      prev.winsB += wB;
      prev.ties += r.ties;
    } else {
      map.set(key, { modelA: a, modelB: b, winsA: wA, winsB: wB, ties: r.ties });
    }
  }

  return Array.from(map.values());
}

/**
 * Compute ratings from PairwiseRecords using Bradley-Terry.
 */
export function computeRatingsFromRecords(records: PairwiseRecord[]): EloRating[] {
  const modelSet = new Set<string>();
  for (const r of records) {
    modelSet.add(r.modelA);
    modelSet.add(r.modelB);
  }
  const matrix = createWinMatrix(Array.from(modelSet));

  for (const r of records) {
    for (let i = 0; i < r.winsA; i++) addWin(matrix, r.modelA, r.modelB);
    for (let i = 0; i < r.winsB; i++) addWin(matrix, r.modelB, r.modelA);
    for (let i = 0; i < r.ties; i++) addTie(matrix, r.modelA, r.modelB);
  }

  return ratingsFromMatrix(matrix);
}

// ── Cumulative API ──────────────────────────────────

/**
 * Extract pairwise records from judgments for cumulative storage.
 */
export function extractPairwiseRecords(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
): PairwiseRecord[] {
  const matrix = buildMatrixFromJudgments(judgments, sampleToModel);
  return matrixToRecords(matrix);
}

/**
 * Extract pairwise records from improvement judgments for cumulative storage.
 */
export function extractFeedbackPairwiseRecords(
  improvementJudgments: PairwiseJudgment[],
  sampleToFeedbackModel: Map<string, string>,
): PairwiseRecord[] {
  const matrix = buildImprovementMatrix(improvementJudgments, sampleToFeedbackModel);
  return matrixToRecords(matrix);
}
