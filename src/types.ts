// ── Provider Layer ──────────────────────────────────

export type ProviderName =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "ollama";

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  label: string; // Display name (provider:model or custom)
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
  input: number; // USD — actual (accounts for cached token pricing)
  output: number; // USD
  total: number; // USD — actual
  totalUncached: number; // USD — what it would cost with no cache hits
}

// ── Model Metadata (models.dev) ─────────────────────

export interface ModelInfo {
  name: string;
  family: string;
  releaseDate?: string;
  openWeights: boolean;
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
  category: string;
  description: string;
  prompt: string;
  judgingCriteria: string[];
  feedbackPrompt?: string;
  revisionPrompt?: string;
  maxWords?: number;
}

// ── Run Data ────────────────────────────────────────

export interface RunConfig {
  id: string; // ISO timestamp-based
  models: ModelConfig[];
  judges?: ModelConfig[]; // If absent, models are used for judging
  prompts: PromptConfig[];
  outputsPerModel: number; // 1-3
  reasoning: boolean; // Include reasoning in judgments
  noCache: boolean; // Skip reading from cache (still writes to cache)
  timestamp: string;
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
}

export interface EloSnapshot {
  stage: "initial" | "revised";
  ratings: EloRating[];
  feedbackRatings?: EloRating[]; // Only in revised stage
  byCategory?: Record<string, EloRating[]>; // ELO per prompt category
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
    speedByModel: Record<string, ModelSpeed>;
    durationMs: number;
    errors?: Array<{ message: string; model?: string }>;
  };
  modelInfo: Record<string, ModelInfo>;
}

// ── Cumulative ELO ──────────────────────────────────

export interface CumulativeElo {
  lastUpdated: string;
  writing: Record<string, EloRating>;
  feedbackGiving: Record<string, EloRating>;
  writingByCategory: Record<string, Record<string, EloRating>>; // category -> model -> rating
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
  stageTotal: number; // Total operations in stage
  stageDone: number; // Completed operations
  currentOp: string; // Human-readable current operation
  elo: {
    initial: EloRating[];
    revised: EloRating[];
    feedback: EloRating[];
  };
  totalCost: number;
  totalCostUncached: number;
  costByModel: Record<string, number>;
  costByStage: Record<string, number>;
  costByModelByStage: Record<string, Record<string, number>>;
  speedByModel: Record<string, ModelSpeed>;
  speedByModelByStage: Record<string, Record<string, ModelSpeed>>;
  cacheSavings: CacheSavings;
}

export type BenchmarkEvent =
  | { type: "progress"; data: BenchmarkProgress }
  | { type: "sampleComplete"; data: WritingSample }
  | { type: "judgmentComplete"; data: PairwiseJudgment }
  | { type: "feedbackComplete"; data: Feedback }
  | { type: "stageComplete"; data: { stage: BenchmarkStage } }
  | { type: "error"; data: { message: string; model?: string } }
  | { type: "complete"; data: RunResult };
