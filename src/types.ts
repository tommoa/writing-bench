// ── Provider Layer ──────────────────────────────────

export type ProviderName =
  | "openai"
  | "anthropic"
  | "google"
  | "google-vertex"
  | "google-vertex-anthropic"
  | "openrouter"
  | "opencode"
  | "ollama";

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  label: string; // Display name (resolved from models.dev or explicit)
  registryId: string; // "provider:model" for SDK resolution and cache
  temperature?: number;
  maxTokens?: number;
  apiBase?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Extract a TokenUsage from an AI SDK result.usage object.
 * AI SDK v6 exposes cache details via inputTokenDetails.
 */
export function extractUsage(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  } | undefined
): TokenUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? undefined,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? undefined,
  };
}

export interface CostBreakdown {
  input: number; // USD -- actual (accounts for cached token pricing)
  output: number; // USD
  total: number; // USD -- actual
  totalUncached: number; // USD -- what it would cost with no cache hits
}

// ── Model Metadata (models.dev) ─────────────────────

export interface ModelInfo {
  name: string;
  family: string;
  releaseDate?: string;
  openWeights: boolean;
  supportsTemperature: boolean;
  supportsStructuredOutput: boolean;
  contextLimit: number;
  outputLimit: number;
  costPer1MInput: number;
  costPer1MOutput: number;
  costPer1MCacheRead?: number;
  costPer1MCacheWrite?: number;
}

// ── Prompt Config ───────────────────────────────────

export interface PromptConfig {
  id: string; // Derived from filename
  name: string;
  tags: string[];
  description: string;
  prompt: string;
  judgingCriteria: string[];
  feedbackPrompt?: string;
  revisionPrompt?: string;
  maxWords?: number;
}

// ── Convergence ─────────────────────────────────────

/** Signal used to compute judge quality weights. */
export type JudgeQualityMode = "consensus" | "writing" | "feedback" | "revised";

/** Configuration for adaptive convergence. */
export interface ConvergenceConfig {
  /** 95% CI half-width threshold in Elo points. 0 = overlap-based convergence. Default: 0. */
  ciThreshold: number;
  /** Maximum number of adaptive rounds. Default: 50. */
  maxRounds: number;
  /** Minimum games per model before checking CI. Default: 2. */
  minPairsPerModel: number;
  /** Priority weight for writing (initial) judgments. Default: 1.0. */
  writingWeight: number;
  /** Cascade cost multiplier for feedback (improvement) judgments. Default: 0.25. */
  feedbackWeight: number;
  /** Cascade cost multiplier for revised judgments. Default: 0.4. */
  revisedWeight: number;
  /** Enable judge quality estimation and weighted ratings. Default: true. */
  judgeQuality: boolean;
  /** Signal for judge quality weighting. Default: "consensus". */
  judgeQualityMode: JudgeQualityMode;
  /** Exponential decay rate for judge weights. Higher = sharper differentiation. Half-life = ln(2)/k Elo points. Default: 0.03. */
  judgeDecay: number;
  /** Judge prune threshold. Judges with weight below this are excluded from need generation. Default: 0.5. */
  judgePruneThreshold: number;
}

export const DEFAULT_CONVERGENCE: ConvergenceConfig = {
  ciThreshold: 0,
  maxRounds: 50,
  minPairsPerModel: 2,
  writingWeight: 1.0,
  feedbackWeight: 0.25,
  revisedWeight: 0.4,
  judgeQuality: true,
  judgeQualityMode: "consensus",
  judgeDecay: 0.03,
  judgePruneThreshold: 0.5,
};

export const DEFAULT_CONCURRENCY = 8;

/** Sensitivity presets for judge quality weighting and pruning. */
export const JUDGE_PRESETS: Record<"low" | "medium" | "high", { judgeDecay: number; judgePruneThreshold: number }> = {
  low:    { judgeDecay: 0.007, judgePruneThreshold: 0.3 },
  medium: { judgeDecay: 0.015, judgePruneThreshold: 0.5 },
  high:   { judgeDecay: DEFAULT_CONVERGENCE.judgeDecay, judgePruneThreshold: DEFAULT_CONVERGENCE.judgePruneThreshold },
};

// ── Run Data ────────────────────────────────────────

export interface RunConfig {
  id: string; // ISO timestamp-based
  models: ModelConfig[];
  judges?: ModelConfig[]; // If absent, models are used for judging
  prompts: PromptConfig[];
  outputsPerModel: number; // Max per model/prompt (Infinity = adaptive)
  reasoning: boolean; // Include reasoning in judgments
  noCache: boolean; // Skip reading from cache (still writes to cache)
  cacheOnly: boolean; // Only use cached data, no API calls in ensure methods
  skipSeeding: boolean; // Skip Phase 1 cache scan; adaptive loop discovers cache lazily
  timestamp: string;
  /** Max needs fulfilled concurrently. Controls overall API pressure.
   *  Each need may trigger 1-6 sequential API calls across different
   *  models. Needs are interleaved by model, so effective per-model
   *  concurrency is roughly concurrency / num_models.
   *  TODO: Support per-provider concurrency limits for mixed-provider
   *  setups where providers have different rate limits. */
  concurrency: number;
  /** Convergence settings (defaults from DEFAULT_CONVERGENCE). */
  convergence: ConvergenceConfig;
}

export interface WritingSample {
  id: string;
  model: string; // ModelConfig.label
  promptId: string;
  outputIndex: number;
  text: string;
  stage: "initial" | "revised";
  originalSampleId?: string; // WritingSample.id this revision is based on
  feedbackUsed?: string; // Feedback.id incorporated (stage 3)
  feedbackModel?: string; // Which model gave the feedback
  fromCache?: boolean; // True if loaded from disk cache (no API call this run)
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

export interface Feedback {
  id: string;
  sourceModel: string; // Who gave feedback
  targetSampleId: string; // Which sample received feedback
  text: string;
  fromCache?: boolean; // True if loaded from disk cache (no API call this run)
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

export interface PairwiseJudgment {
  id: string;
  judgeModel: string;
  promptId: string;
  sampleA: string; // WritingSample.id
  sampleB: string;
  winner: "A" | "B" | "tie";
  reasoning: string;
  stage: "initial" | "revised" | "improvement";
  /** Whether the pair was swapped for position-bias randomization.
   *  true = judge saw (B,A) but winner/sampleA/sampleB are corrected back.
   *  undefined for cached judgments where swap info was not persisted. */
  positionSwapped?: boolean;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

// ── ELO ─────────────────────────────────────────────

export interface EloRating {
  model: string;
  rating: number;
  wins: number;
  losses: number;
  ties: number;
  matchCount: number;
  /** 95% CI half-width in Elo points (present when computed via WHR). */
  ci95?: number;
}

export interface EloSnapshot {
  stage: "initial" | "revised";
  ratings: EloRating[];
  feedbackRatings?: EloRating[]; // Only in revised stage
  byTag?: Record<string, EloRating[]>; // ELO per prompt tag
}

// ── Errors ──────────────────────────────────────────

export interface TaskError {
  message: string;
  model?: string;
  /** HTTP status code from the API, if available */
  statusCode?: number;
  /** Raw response body from the API (truncated) */
  responseBody?: string;
  /** The URL that was called */
  url?: string;
  /** Whether the SDK considered this retryable */
  isRetryable?: boolean;
  /** Stack trace of the original error */
  stack?: string;
}

/**
 * Unwrap an AI SDK error into a TaskError with full diagnostic detail.
 *
 * Handles RetryError (unwraps to lastError), APICallError (extracts
 * statusCode, responseBody, url), and plain Error (preserves stack).
 */
export function extractTaskError(err: unknown, model?: string): TaskError {
  // Unwrap RetryError to get the actual cause
  let root: unknown = err;
  if (root instanceof Error && "errors" in root && Array.isArray((root as any).errors)) {
    // RetryError -- use lastError for detail
    root = (root as any).lastError ?? (root as any).errors[(root as any).errors.length - 1] ?? root;
  }

  const result: TaskError = {
    message: root instanceof Error ? root.message : String(root),
    model,
  };

  if (root instanceof Error) {
    result.stack = root.stack;

    // APICallError fields
    if ("statusCode" in root) result.statusCode = (root as any).statusCode;
    if ("url" in root) result.url = (root as any).url;
    if ("isRetryable" in root) result.isRetryable = (root as any).isRetryable;
    if ("responseBody" in root) {
      const body = String((root as any).responseBody);
      result.responseBody = body.length > 500 ? body.slice(0, 500) + "…" : body;
    }

    // If the unwrapped error has a cause, include its message too
    if (root.cause instanceof Error && root.cause.message !== result.message) {
      result.message = `${result.message} (cause: ${root.cause.message})`;
    }
  }

  return result;
}

// ── Run Result ──────────────────────────────────────

export interface ModelSpeed {
  totalLatencyMs: number; // Sum of all API call latencies for this model
  totalOutputTokens: number; // Total output tokens generated
  tokensPerSecond: number; // Output tokens / total latency
  calls: number; // Number of API calls
  avgLatencyMs: number; // Average latency per call
}

export interface RunResult {
  config: RunConfig;
  samples: WritingSample[];
  feedback: Feedback[];
  judgments: PairwiseJudgment[];
  elo: {
    initial: EloSnapshot;
    revised: EloSnapshot;
  };
  meta: {
    totalTokens: number;
    totalCost: number;
    totalCostUncached: number;
    costByModel: Record<string, number>;
    costByStage: Record<string, number>;
    costByModelByStage: Record<string, Record<string, number>>;
    costByModelUncached?: Record<string, number>;
    costByModelByStageUncached?: Record<string, Record<string, number>>;
    tokensByModel?: Record<string, number>;
    tokensByModelByStage?: Record<string, Record<string, number>>;
    speedByModel: Record<string, ModelSpeed>;
    durationMs: number;
    errors?: TaskError[];
  };
  modelInfo: Record<string, ModelInfo>;
}

// ── Judge Quality Export ────────────────────────────

/** Serialized judge quality entry for web export. */
export interface JudgeQualityExport {
  model: string;
  rating: number;
  ci95: number;
  wins: number;
  losses: number;
  ties: number;
  weight: number;
  selfBias: number | null;
  positionBias: number | null;
  selfBiasSufficient: boolean;
  positionBiasSufficient: boolean;
  status: "active" | "pruned";
}

// ── Pairwise Records ────────────────────────────────

/** Accumulated pairwise outcomes between two models. */
export interface PairwiseRecord {
  modelA: string;
  modelB: string;
  winsA: number;
  winsB: number;
  ties: number;
}

// ── Cumulative ELO ──────────────────────────────────

export interface CumulativeElo {
  lastUpdated: string;
  writing: Record<string, EloRating>;
  feedbackGiving: Record<string, EloRating>;
  writingByTag: Record<string, Record<string, EloRating>>; // tag -> model -> rating
  /** Accumulated pairwise outcomes for WHR recomputation. */
  pairwise?: {
    writing: PairwiseRecord[];
    feedbackGiving: PairwiseRecord[];
    writingByTag: Record<string, PairwiseRecord[]>;
  };
  history: Array<{
    runId: string;
    timestamp: string;
    snapshot: Record<string, number>; // model -> rating
  }>;
}

// ── Engine Events (for UI) ──────────────────────────

export type BenchmarkStage =
  | "initialWriting"
  | "initialJudging"
  | "feedback"
  | "revisedWriting"
  | "revisedJudging"
  | "computingElo"
  | "seeding"
  | "adaptive"
  | "complete";

export interface CacheStageSavings {
  cached: number;
  fresh: number;
  savedCost: number;
}

export interface CacheSavings {
  writes: CacheStageSavings;
  feedback: CacheStageSavings;
  revisions: CacheStageSavings;
  judgments: CacheStageSavings;
}

export interface BenchmarkProgress {
  stage: BenchmarkStage; // Kept for the "complete" terminal state
  activeStages: BenchmarkStage[]; // Stages with inflight work right now
  stageProgress: number; // 0-1
  stageDone: number; // Completed operations
  currentOp: string; // Human-readable current operation
  elo: {
    initial: EloRating[];
    revised: EloRating[];
    feedback: EloRating[];
    /** Judge reliability ratings (only present when judge quality is active). */
    judgeQuality?: EloRating[];
  };
  /** Judge label -> normalized weight (only present when judge quality is active). */
  judgeWeights?: Record<string, number>;
  /** Runtime judge prune threshold for UI display. */
  judgePruneThreshold?: number;
  /** Judge quality mode for UI display. */
  judgeQualityMode?: JudgeQualityMode;
  totalCost: number;
  totalCostUncached: number;
  costByModel: Record<string, number>;
  costByStage: Record<string, number>;
  costByModelByStage: Record<string, Record<string, number>>;
  speedByModel: Record<string, ModelSpeed>;
  speedByModelByStage: Record<string, Record<string, ModelSpeed>>;
  cacheSavings: CacheSavings;
  /** Current adaptive judging round (pull loop iteration). */
  judgingRound?: number;
  /** Current maximum 95% CI half-width across all models (Elo points). */
  maxCi?: number;
  /** Target CI threshold (Elo points). */
  ciThreshold?: number;
  /** Human-readable description of the need driving the current action. */
  needDescription?: string;
  /** Summary of needs in the current adaptive batch. */
  batchSummary?: string;
  /** Models suspended this batch due to rate-limit / server errors. */
  suspendedModels?: string[];
  /** Per-judge bias statistics (only present when judge quality is active). */
  judgeBias?: {
    selfPreference: Record<string, {
      selfJudgmentCount: number;
      selfWinRate: number;
      expectedWinRate: number;
      biasDelta: number;
      sufficient: boolean;
    }>;
    positionBias: Record<string, {
      positionKnownCount: number;
      positionARate: number;
      positionBiasDelta: number;
      sufficient: boolean;
    }>;
  };
}

export type BenchmarkEvent =
  | { type: "progress"; data: BenchmarkProgress }
  | { type: "sampleComplete"; data: WritingSample }
  | { type: "judgmentComplete"; data: PairwiseJudgment }
  | { type: "feedbackComplete"; data: Feedback }
  | { type: "stageComplete"; data: { stage: BenchmarkStage } }
  | { type: "error"; data: TaskError }
  | { type: "complete"; data: RunResult };
