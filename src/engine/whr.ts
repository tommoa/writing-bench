import type { EloRating, PairwiseRecord } from "../types.js";

// ── Constants ───────────────────────────────────────

export const DEFAULT_RATING = 1500;
const WHR_MAX_ITER = 50;
const WHR_TOLERANCE = 1e-6;

/**
 * 400 * log10(e) ≈ 173.72
 * Converts natural-log-scale strength to Elo-scale rating.
 */
export const LOG10E_TIMES_400 = 400 * Math.LOG10E;

/**
 * Prior variance for regularization (on natural-log scale).
 * sigma = 0.5 ≈ 87 Elo points SD. Tighter than σ=1 so each game
 * contributes more to posterior precision, allowing CIs to shrink
 * faster and the adaptive loop to converge with fewer judgments.
 */
const PRIOR_VARIANCE = 0.25;
const PRIOR_PRECISION = 1 / PRIOR_VARIANCE;

// ── Types ───────────────────────────────────────────

/** A single pairwise comparison for WHR computation. */
export interface WhrGame {
  playerWhite: string;
  playerBlack: string;
  /** 1.0 = white wins, 0.0 = black wins, 0.5 = tie */
  result: number;
}

/** WHR rating with confidence interval (extends EloRating shape). */
export interface WhrRating extends EloRating {
  /** 95% CI half-width in Elo points. */
  ci95: number;
}

/** Result of a WHR computation. */
export interface WhrResult {
  ratings: WhrRating[];
  converged: boolean;
  iterations: number;
}

// ── Helpers ─────────────────────────────────────────

/** Sigmoid function: 1 / (1 + exp(-x)). */
export function sigmoid(x: number): number {
  if (x >= 0) {
    return 1 / (1 + Math.exp(-x));
  }
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

/**
 * Check whether two models' 95% CI ranges overlap.
 * Overlap means the models are not yet clearly distinguishable:
 * |ratingA - ratingB| < ci95_A + ci95_B
 *
 * Infinity CI always overlaps (model has no data yet).
 */
export function hasOverlap(a: WhrRating, b: WhrRating): boolean {
  if (a.ci95 === Infinity || b.ci95 === Infinity) return true;
  return Math.abs(a.rating - b.rating) < a.ci95 + b.ci95;
}

/**
 * Check whether a model's CI range overlaps with ANY other model.
 * Returns true if the model has at least one neighbor it can't be
 * distinguished from. A single-model list always returns false.
 */
export function hasAnyOverlap(
  model: WhrRating,
  allRatings: WhrRating[],
): boolean {
  for (const other of allRatings) {
    if (other.model === model.model) continue;
    if (hasOverlap(model, other)) return true;
  }
  return false;
}

/** Convert natural-log strength to Elo-scale rating. */
function naturalToElo(r: number): number {
  return Math.round(LOG10E_TIMES_400 * r + DEFAULT_RATING);
}

// ── Core WHR Algorithm ──────────────────────────────

/**
 * Build the data structures needed for Newton's method from raw games.
 * Returns model names (sorted for determinism) and per-pair game counts.
 */
function buildGameData(games: WhrGame[]): {
  models: string[];
  /** winsWhite[i][j] = times model i beat model j */
  winsWhite: number[][];
  /** tieCount[i][j] = ties between i and j (symmetric: both directions populated) */
  tieCount: number[][];
} {
  const modelSet = new Set<string>();
  for (const g of games) {
    modelSet.add(g.playerWhite);
    modelSet.add(g.playerBlack);
  }
  const models = Array.from(modelSet).sort();
  const n = models.length;
  const modelIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) modelIndex.set(models[i], i);

  const winsWhite: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const tieCount: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (const g of games) {
    const wi = modelIndex.get(g.playerWhite)!;
    const bi = modelIndex.get(g.playerBlack)!;
    if (wi === bi) continue; // skip self-comparisons

    if (g.result === 1.0) {
      winsWhite[wi][bi]++;
    } else if (g.result === 0.0) {
      winsWhite[bi][wi]++;
    } else {
      // Tie — store symmetrically so both directions can be read
      tieCount[wi][bi]++;
      tieCount[bi][wi]++;
    }
  }

  return { models, winsWhite, tieCount };
}

/**
 * Run Newton's method to find MAP Bradley-Terry strength parameters.
 *
 * Uses a Gaussian prior r_i ~ N(0, PRIOR_VARIANCE) to regularize
 * the system. This makes the Hessian negative definite (no gauge
 * invariance) and prevents MLE divergence for all-wins cases.
 *
 * Returns the strength parameters (natural-log scale) and centered
 * posterior variances (gauge-mode removed via centering projection).
 */
function newtonBradleyTerry(
  models: string[],
  winsWhite: number[][],
  tieCount: number[][],
): {
  ratings: number[];
  variances: number[];
  converged: boolean;
  iterations: number;
} {
  const n = models.length;
  if (n === 0) return { ratings: [], variances: [], converged: true, iterations: 0 };
  if (n === 1) return { ratings: [0], variances: [PRIOR_VARIANCE], converged: true, iterations: 0 };

  // Initialize all ratings to 0 (equal strength)
  const r = new Float64Array(n);

  let converged = false;
  let iter = 0;

  for (iter = 0; iter < WHR_MAX_ITER; iter++) {
    // Compute gradient and negative Hessian (-H, which is positive definite)
    const gradient = new Float64Array(n);
    const negH = Array.from({ length: n }, () => new Float64Array(n));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const nij = winsWhite[i][j] + winsWhite[j][i] + tieCount[i][j];
        if (nij === 0) continue;

        const p = sigmoid(r[i] - r[j]); // P(i beats j)

        // Score for i from this pair: wins_i + 0.5 * ties_ij
        const scoreI = winsWhite[i][j] + 0.5 * tieCount[i][j];
        // Gradient contribution: observed - expected
        const gradContrib = scoreI - nij * p;
        gradient[i] += gradContrib;
        gradient[j] -= gradContrib;

        // Fisher information: nij * p * (1 - p)
        const info = nij * p * (1 - p);
        negH[i][i] += info;
        negH[j][j] += info;
        negH[i][j] -= info;
        negH[j][i] -= info;
      }
    }

    // Add prior contribution: d/dr_i [-0.5 * r_i^2 / sigma^2] = -r_i / sigma^2
    // Hessian of prior: -1/sigma^2 → adds PRIOR_PRECISION to -H diagonal
    for (let i = 0; i < n; i++) {
      gradient[i] -= PRIOR_PRECISION * r[i];
      negH[i][i] += PRIOR_PRECISION;
    }

    // Solve (-H) * delta = gradient via Gaussian elimination
    // This gives delta = (-H)^{-1} * gradient = -H^{-1} * gradient
    // Newton update for maximization: r_new = r - H^{-1} * gradient = r + delta ✓
    const A = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) =>
        j < n ? negH[i][j] : gradient[i]
      )
    );

    gaussianElimination(A, n);

    // Back substitution
    const delta = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let sum = A[i][n];
      for (let j = i + 1; j < n; j++) {
        sum -= A[i][j] * delta[j];
      }
      delta[i] = Math.abs(A[i][i]) > 1e-15 ? sum / A[i][i] : 0;
    }

    // Update ratings
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      r[i] += delta[i];
      maxDelta = Math.max(maxDelta, Math.abs(delta[i]));
    }

    if (maxDelta < WHR_TOLERANCE) {
      converged = true;
      iter++;
      break;
    }
  }

  // Center ratings so the mean is 0 (removes prior bias on the mean)
  let sum = 0;
  for (let i = 0; i < n; i++) sum += r[i];
  const mean = sum / n;
  for (let i = 0; i < n; i++) r[i] -= mean;

  // Compute posterior variances from the inverse of -H at the converged point
  const negHfinal = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const nij = winsWhite[i][j] + winsWhite[j][i] + tieCount[i][j];
      if (nij === 0) continue;

      const p = sigmoid(r[i] - r[j]);
      const info = nij * p * (1 - p);
      negHfinal[i][i] += info;
      negHfinal[j][j] += info;
      negHfinal[i][j] -= info;
      negHfinal[j][i] -= info;
    }
    negHfinal[i][i] += PRIOR_PRECISION;
  }

  const variances = centeredVariances(negHfinal, n);

  return { ratings: Array.from(r), variances, converged, iterations: iter };
}

/**
 * Gaussian elimination with partial pivoting (in-place).
 * A is an n × (n+1) augmented matrix.
 */
function gaussianElimination(A: number[][], n: number): void {
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxVal = Math.abs(A[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > maxVal) {
        maxVal = Math.abs(A[row][col]);
        maxRow = row;
      }
    }
    if (maxRow !== col) {
      [A[col], A[maxRow]] = [A[maxRow], A[col]];
    }

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-15) continue;

    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / pivot;
      for (let k = col; k <= n; k++) {
        A[row][k] -= factor * A[col][k];
      }
    }
  }
}

/**
 * Compute centered posterior variances from the precision matrix
 * (negative Hessian) using full Gauss-Jordan inversion.
 *
 * "Centered" means the variance of r_i - mean(r), which removes
 * the gauge-mode contribution. The BT model has a gauge symmetry
 * (shifting all strengths by a constant doesn't change predictions).
 * The Bayesian prior breaks this weakly, creating a "uniform mode"
 * eigenvalue of just PRIOR_PRECISION in the precision matrix. For
 * n models this contributes 1/(n·τ) to each raw variance, producing
 * a CI floor of ~1.96·√(1/(n·τ))·173.72 Elo regardless of game
 * count. Centering projects out this mode so CIs reflect actual
 * distinguishability between models.
 *
 * Formula: Var(r̃_i) = Σ_ii - (2/n)·rowSum_i + (1/n²)·totalSum
 * where Σ = P⁻¹ is the full posterior covariance.
 */
function centeredVariances(M: Float64Array[], n: number): number[] {
  if (n === 0) return [];
  if (n === 1) return [Math.abs(M[0][0]) > 1e-15 ? 1 / M[0][0] : Infinity];

  // Build [M | I] augmented matrix for full inversion
  const A = Array.from({ length: n }, (_, i) =>
    Array.from({ length: 2 * n }, (_, j) =>
      j < n ? M[i][j] : (i === j - n ? 1 : 0)
    )
  );

  // Gauss-Jordan elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    let maxVal = Math.abs(A[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > maxVal) {
        maxVal = Math.abs(A[row][col]);
        maxRow = row;
      }
    }
    if (maxRow !== col) {
      [A[col], A[maxRow]] = [A[maxRow], A[col]];
    }

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-15) continue;

    // Scale row
    for (let k = 0; k < 2 * n; k++) {
      A[col][k] /= pivot;
    }

    // Eliminate column in ALL other rows (Gauss-Jordan)
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = A[row][col];
      for (let k = 0; k < 2 * n; k++) {
        A[row][k] -= factor * A[col][k];
      }
    }
  }

  // Compute row sums and total sum of covariance matrix Σ for centering
  const rowSums = new Array<number>(n);
  let totalSum = 0;
  for (let i = 0; i < n; i++) {
    let rs = 0;
    for (let j = 0; j < n; j++) {
      rs += A[i][n + j];
    }
    rowSums[i] = rs;
    totalSum += rs;
  }
  const meanOfSigma = totalSum / (n * n);

  // Centered variance: Σ_ii - (2/n)·rowSum_i + meanOfSigma
  const result = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const centered = A[i][n + i] - 2 * rowSums[i] / n + meanOfSigma;
    result[i] = Math.max(centered, 0); // floor at 0 for numerical safety
  }
  return result;
}

// ── Public API ──────────────────────────────────────

/**
 * Shared core: run WHR from pre-built game data matrices.
 */
function computeWhrFromGameData(
  models: string[],
  winsWhite: number[][],
  tieCount: number[][],
): WhrResult {
  const n = models.length;

  if (n === 0) {
    return { ratings: [], converged: true, iterations: 0 };
  }

  const { ratings: r, variances, converged, iterations } = newtonBradleyTerry(
    models, winsWhite, tieCount,
  );

  // Build WhrRating[] from results
  const result: WhrRating[] = [];
  for (let idx = 0; idx < n; idx++) {
    const model = models[idx];

    // Count wins, losses, ties for this model
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (let j = 0; j < n; j++) {
      if (idx === j) continue;
      wins += winsWhite[idx][j];
      losses += winsWhite[j][idx];
      ties += tieCount[idx][j];
    }
    // tieCount[][] is symmetric — each tie game increments both [i][j]
    // and [j][i]. When we sum tieCount[idx][j] for all j, each tie is
    // counted once per opponent (not doubled), so no division needed.
    const matchCount = wins + losses + ties;

    // CI from posterior variance
    const variance = variances[idx];
    const ci95 = variance !== Infinity && variance >= 0 && isFinite(variance)
      ? Math.round(1.96 * Math.sqrt(variance) * LOG10E_TIMES_400)
      : Infinity;

    result.push({
      model,
      rating: matchCount > 0 ? naturalToElo(r[idx]) : DEFAULT_RATING,
      ci95,
      wins,
      losses,
      ties,
      matchCount,
    });
  }

  return {
    ratings: result.sort((a, b) => b.rating - a.rating),
    converged,
    iterations,
  };
}

/**
 * Build game data matrices directly from pairwise records,
 * skipping the intermediate WhrGame[] expansion.
 */
function buildGameDataFromRecords(records: PairwiseRecord[]): {
  models: string[];
  winsWhite: number[][];
  tieCount: number[][];
} {
  const modelSet = new Set<string>();
  for (const r of records) {
    modelSet.add(r.modelA);
    modelSet.add(r.modelB);
  }
  const models = Array.from(modelSet).sort();
  const n = models.length;
  const modelIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) modelIndex.set(models[i], i);

  const winsWhite: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const tieCount: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (const r of records) {
    const ai = modelIndex.get(r.modelA)!;
    const bi = modelIndex.get(r.modelB)!;
    if (ai === bi) continue;

    winsWhite[ai][bi] += r.winsA;
    winsWhite[bi][ai] += r.winsB;
    tieCount[ai][bi] += r.ties;
    tieCount[bi][ai] += r.ties;
  }

  return { models, winsWhite, tieCount };
}

/**
 * Compute WHR ratings from a list of pairwise games.
 *
 * Uses Newton's method on the Bradley-Terry log-posterior (with a
 * Gaussian prior for regularization) to find MAP strength estimates.
 * Confidence intervals are derived from centered posterior variances
 * (gauge-mode removed) so CIs reflect distinguishability, not prior.
 *
 * Order-independent: the same set of games always produces the same
 * ratings regardless of input order.
 */
export function computeWhr(games: WhrGame[]): WhrResult {
  const { models, winsWhite, tieCount } = buildGameData(games);
  return computeWhrFromGameData(models, winsWhite, tieCount);
}

/**
 * Compute WHR ratings directly from pairwise records.
 * Builds game matrices directly without expanding records into
 * individual game objects.
 */
export function computeWhrFromRecords(records: PairwiseRecord[]): WhrResult {
  const { models, winsWhite, tieCount } = buildGameDataFromRecords(records);
  return computeWhrFromGameData(models, winsWhite, tieCount);
}

/**
 * Convenience: compute WHR and return only the ratings array.
 */
export function whrRatings(games: WhrGame[]): WhrRating[] {
  return computeWhr(games).ratings;
}

/**
 * Convenience: compute WHR from pairwise records, return only ratings.
 */
export function whrRatingsFromRecords(records: PairwiseRecord[]): WhrRating[] {
  return computeWhrFromRecords(records).ratings;
}

/**
 * Return the largest 95% CI half-width across models that still have
 * overlapping CIs with at least one other model. Models whose CIs are
 * fully separated from all others are "effectively converged" and
 * excluded, so the progress display reflects real remaining uncertainty.
 *
 * Returns Infinity if any overlapping model has infinite CI (e.g., no games).
 * Returns 0 if no models have overlapping CIs or the result is empty.
 */
export function maxCiHalfWidth(result: WhrResult): number {
  if (result.ratings.length === 0) return 0;
  let max = 0;
  for (const r of result.ratings) {
    if (!hasAnyOverlap(r, result.ratings)) continue;
    if (r.ci95 === Infinity) return Infinity;
    if (r.ci95 > max) max = r.ci95;
  }
  return max;
}

// ── Convergence Estimation ─────────────────────────

/**
 * Compute the CI half-width at which a model becomes non-overlapping
 * with all other models. This is the tightest constraint across all
 * currently-overlapping neighbors.
 *
 * For each neighbor, the threshold is max(gap - neighbor_ci95, gap / 2).
 * The gap / 2 fallback assumes both models' CIs will shrink at roughly
 * the same rate (splitting the gap evenly).
 *
 * Returns Infinity if already non-overlapping with all models.
 * Returns null if a neighbor has infinite CI or gap ≈ 0 (identical ratings).
 */
export function overlapFreeThreshold(
  model: WhrRating,
  allRatings: WhrRating[],
): number | null {
  let minThreshold = Infinity;
  for (const other of allRatings) {
    if (other.model === model.model) continue;
    if (!hasOverlap(model, other)) continue;
    // Can't estimate against a model with no data
    if (!isFinite(other.ci95)) return null;
    const gap = Math.abs(model.rating - other.rating);
    // Best case: neighbor's CI is already tight enough that shrinking
    // ours alone separates (gap - other.ci95). Otherwise, assume both
    // models' CIs will shrink and split the gap evenly (gap / 2).
    const threshold = Math.max(gap - other.ci95, gap / 2);
    if (threshold <= 0) return null;  // gap ≈ 0 → can't separate
    if (threshold < minThreshold) minThreshold = threshold;
  }
  return minThreshold;
}

/**
 * Estimate how many additional pairwise judgments a model needs before
 * it converges. Convergence can happen via two paths:
 *   1. CI shrinks below ciThreshold
 *   2. CI shrinks enough that the model no longer overlaps any neighbor
 *
 * When nonOverlapThreshold is provided and positive, the effective
 * target is max(ciThreshold, nonOverlapThreshold) — whichever path
 * the model reaches first (a higher threshold means fewer games).
 *
 * Returns null when no estimate is possible (no games played, infinite CI).
 * Returns 0 when the model has already converged.
 */
export function estimateRemainingJudgments(
  ci95: number,
  matchCount: number,
  ciThreshold: number,
  nonOverlapThreshold?: number | null,
): number | null {
  // Infinite or non-finite CI → can't estimate
  if (!isFinite(ci95) || ci95 <= 0) return null;

  // Effective threshold: use the more generous of the two convergence paths.
  // A higher threshold means the model needs to shrink less → fewer games.
  const effectiveThreshold =
    nonOverlapThreshold != null && nonOverlapThreshold > ciThreshold
      ? nonOverlapThreshold
      : ciThreshold;

  // No feasible target (e.g. ciThreshold=0 and overlap can't be resolved
  // by shrinking this model's CI alone) → can't estimate
  if (effectiveThreshold <= 0) return null;
  // Already converged via whichever path is easier
  if (ci95 <= effectiveThreshold) return 0;
  // No games → can't derive per-game precision empirically
  if (matchCount <= 0) return null;

  const SCALE = 1.96 * LOG10E_TIMES_400;

  const currentPrecision = (SCALE / ci95) ** 2;
  const targetPrecision = (SCALE / effectiveThreshold) ** 2;
  const additionalPrecision = targetPrecision - currentPrecision;

  if (additionalPrecision <= 0) return 0; // float rounding edge case

  // Derive empirical precision-per-game from this model's history.
  // Prior contributes PRIOR_PRECISION to total precision, so
  // game-contributed precision = currentPrecision - PRIOR_PRECISION.
  // With very few games (≤2), this estimate is noisy; fall back to
  // theoretical maximum of 0.25 (equal-strength opponents).
  let avgPrecisionPerGame: number;
  if (matchCount <= 2) {
    avgPrecisionPerGame = 0.25;
  } else {
    const gamePrecision = currentPrecision - PRIOR_PRECISION;
    avgPrecisionPerGame = gamePrecision > 0
      ? gamePrecision / matchCount
      : 0.25;
  }

  return Math.ceil(additionalPrecision / avgPrecisionPerGame);
}

/**
 * Convert PairwiseJudgment data into WhrGame format.
 * Caller provides a mapping from sample IDs to model names.
 */
export function judgmentsToGames(
  judgments: Array<{ sampleA: string; sampleB: string; winner: "A" | "B" | "tie" }>,
  sampleToModel: Map<string, string>,
): WhrGame[] {
  const games: WhrGame[] = [];
  for (const j of judgments) {
    const modelA = sampleToModel.get(j.sampleA);
    const modelB = sampleToModel.get(j.sampleB);
    if (!modelA || !modelB || modelA === modelB) continue;

    games.push({
      playerWhite: modelA,
      playerBlack: modelB,
      result: j.winner === "A" ? 1.0 : j.winner === "B" ? 0.0 : 0.5,
    });
  }
  return games;
}

/**
 * Convert improvement judgments into WhrGame format using the
 * grouped-pairing logic. Groups by (promptId, judgeModel, sampleA)
 * so that feedback providers are only compared when tested on the
 * same base text. Within each group, pairs different feedback
 * providers.
 *
 * If feedback model A's revision beat the original but B's didn't,
 * A wins. Both improved or both failed = tie.
 */
export function improvementJudgmentsToGames(
  improvementJudgments: Array<{
    sampleA: string;
    sampleB: string;
    winner: "A" | "B" | "tie";
    promptId: string;
    judgeModel: string;
  }>,
  sampleToFeedbackModel: Map<string, string>,
): WhrGame[] {
  const games: WhrGame[] = [];

  // Group by (promptId, judgeModel, sampleA) -- sampleA is the original
  // sample ID, ensuring feedback models are only paired when tested on
  // the same base text.
  type ImpResult = { feedbackModel: string; winner: "A" | "B" | "tie" };
  const groups = new Map<string, ImpResult[]>();

  for (const j of improvementJudgments) {
    const fbModel = sampleToFeedbackModel.get(j.sampleB);
    if (!fbModel) continue;
    const groupKey = `${j.promptId}:${j.judgeModel}:${j.sampleA}`;
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

        if (aImproved && !bImproved) {
          games.push({ playerWhite: a.feedbackModel, playerBlack: b.feedbackModel, result: 1.0 });
        } else if (!aImproved && bImproved) {
          games.push({ playerWhite: b.feedbackModel, playerBlack: a.feedbackModel, result: 1.0 });
        } else {
          games.push({ playerWhite: a.feedbackModel, playerBlack: b.feedbackModel, result: 0.5 });
        }
      }
    }
  }

  return games;
}

// ── Pairwise Record Helpers ─────────────────────────

/** Canonical key for a model pair (sorted so order doesn't matter). */
function pairKey(a: string, b: string): [string, string, string] {
  return a < b ? [a, b, `${a}:${b}`] : [b, a, `${b}:${a}`];
}

/**
 * Convert WhrGames into aggregated PairwiseRecords.
 * Each unique model pair gets one record with accumulated win/tie counts.
 */
export function gamesToRecords(games: WhrGame[]): PairwiseRecord[] {
  const map = new Map<string, PairwiseRecord>();
  for (const g of games) {
    const [first, second, key] = pairKey(g.playerWhite, g.playerBlack);
    const flipped = first !== g.playerWhite;

    let rec = map.get(key);
    if (!rec) {
      rec = { modelA: first, modelB: second, winsA: 0, winsB: 0, ties: 0 };
      map.set(key, rec);
    }

    if (g.result === 0.5) {
      rec.ties++;
    } else if ((g.result === 1.0 && !flipped) || (g.result === 0.0 && flipped)) {
      rec.winsA++;
    } else {
      rec.winsB++;
    }
  }
  return Array.from(map.values());
}

/** Accumulate a pairwise record into a map, normalizing to sorted model order. */
function addToRecordMap(map: Map<string, PairwiseRecord>, r: PairwiseRecord): void {
  const [a, b, key] = pairKey(r.modelA, r.modelB);
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

/**
 * Merge new PairwiseRecords into existing ones.
 * Records are keyed by sorted (modelA, modelB) pair.
 */
export function mergeRecords(
  existing: PairwiseRecord[],
  incoming: PairwiseRecord[],
): PairwiseRecord[] {
  const map = new Map<string, PairwiseRecord>();
  for (const r of existing) addToRecordMap(map, r);
  for (const r of incoming) addToRecordMap(map, r);
  return Array.from(map.values());
}
