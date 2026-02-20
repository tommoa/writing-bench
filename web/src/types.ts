// Types mirroring the backend RunResult shape for the web viewer.
// These describe the JSON data loaded from the export files.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  total: number;
  totalUncached: number;
}

export interface ModelSpeed {
  totalLatencyMs: number;
  totalOutputTokens: number;
  tokensPerSecond: number;
  calls: number;
  avgLatencyMs: number;
}

export interface ModelInfo {
  name: string;
  family: string;
  releaseDate?: string;
  openWeights: boolean;
  contextLimit: number;
  outputLimit: number;
  costPer1MInput: number;
  costPer1MOutput: number;
}

export interface PromptConfig {
  id: string;
  name: string;
  tags: string[];
  description: string;
  prompt: string;
  judgingCriteria: string[];
}

export interface ModelConfig {
  provider: string;
  model: string;
  label: string;
}

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
  feedbackRatings?: EloRating[];
  byTag?: Record<string, EloRating[]>;
}

// ── Legacy full RunResult types (kept for reference) ─

export interface WritingSample {
  id: string;
  model: string;
  promptId: string;
  outputIndex: number;
  text: string;
  stage: "initial" | "revised";
  originalSampleId?: string;
  feedbackUsed?: string;
  feedbackModel?: string;
  fromCache?: boolean;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

export interface Feedback {
  id: string;
  sourceModel: string;
  targetSampleId: string;
  text: string;
  fromCache?: boolean;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

export interface PairwiseJudgment {
  id: string;
  judgeModel: string;
  promptId: string;
  sampleA: string;
  sampleB: string;
  winner: "A" | "B" | "tie";
  reasoning: string;
  stage: "initial" | "revised" | "improvement";
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

export interface RunResult {
  config: {
    id: string;
    models: ModelConfig[];
    judges?: ModelConfig[];
    prompts: PromptConfig[];
    outputsPerModel: number;
    reasoning: boolean;
    timestamp: string;
  };
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
  };
  modelInfo: Record<string, ModelInfo>;
}

// ── Judge Quality ───────────────────────────────────

/** Serialized judge quality entry from web export. */
export interface JudgeQualityEntry {
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

/** Pre-computed alternative rating sets. */
export interface AlternativeRatings {
  equalWeight: {
    initial: EloRating[];
    revised: EloRating[];
    feedback: EloRating[];
  };
  noBiasCorrection: {
    initial: EloRating[];
    revised: EloRating[];
    feedback: EloRating[];
  };
}

// ── Tiered data: Run Manifest (Tier 1) ──────────────

/** Sample structural metadata without text or per-call cost detail. */
export interface SampleMeta {
  id: string;
  model: string;
  promptId: string;
  outputIndex: number;
  stage: "initial" | "revised";
  originalSampleId?: string;
  feedbackUsed?: string;
  feedbackModel?: string;
  fromCache?: boolean;
}

/** Feedback structural metadata without text or per-call cost detail. */
export interface FeedbackMeta {
  id: string;
  sourceModel: string;
  targetSampleId: string;
  fromCache?: boolean;
}

/** Judgment structural metadata without reasoning, id, or per-call cost. */
export interface JudgmentMeta {
  judgeModel: string;
  promptId: string;
  sampleA: string;
  sampleB: string;
  winner: "A" | "B" | "tie";
  stage: "initial" | "revised" | "improvement";
  positionSwapped?: boolean;
}

/** Lean run data loaded as the first tier (immediate page load). */
export interface RunManifest {
  config: {
    id: string;
    models: ModelConfig[];
    judges?: ModelConfig[];
    prompts: PromptConfig[];
    outputsPerModel: number;
    reasoning: boolean;
    timestamp: string;
  };
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
  };
  modelInfo: Record<string, ModelInfo>;
  samples: SampleMeta[];
  feedback: FeedbackMeta[];
  judgments: JudgmentMeta[];
  /** Maps each promptId to its contiguous slice in the judgments array. */
  promptJudgmentSlices: Record<string, { start: number; count: number }>;
  /** Judge quality data (absent for old runs or single-judge runs). */
  judgeQuality?: JudgeQualityEntry[];
  /** Pre-computed alternative rating sets (absent for single-judge runs). */
  alternativeRatings?: AlternativeRatings;
}

// ── Tiered data: Per-prompt Content (Tier 2) ────────

/** Text + cost detail for a single sample, loaded on-demand. */
export interface SampleContent {
  text: string;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

/** Text + cost detail for a single feedback, loaded on-demand. */
export interface FeedbackContent {
  text: string;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

/** Per-prompt content bundle loaded when the user expands a prompt section. */
export interface PromptContent {
  samples: Record<string, SampleContent>;
  feedback: Record<string, FeedbackContent>;
  reasoning: string[];
}

// ── Tag Alternatives (lazy-loaded for dashboard) ────

/** Per-tag alternative ratings, loaded from data/tag-alternatives.json. */
export interface TagAlternatives {
  equalWeight: Record<string, { initial: EloRating[]; revised: EloRating[] }>;
  noBiasCorrection: Record<string, { initial: EloRating[]; revised: EloRating[] }>;
}

// ── Dashboard types ─────────────────────────────────

export interface EloEntry {
  model: string;
  rating: number;
  matchCount: number;
  /** 95% CI half-width in Elo points (present when computed via WHR). */
  ci95?: number;
  costByStage?: Record<string, number>;
  totalCost?: number;
  tokensByStage?: Record<string, number>;
  totalTokens?: number;
}

export interface RunIndexEntry {
  id: string;
  timestamp: string;
  models: string[];
  promptCount: number;
  outputsPerModel: number;
  totalCost: number;
  totalCostUncached?: number;
  costByModel?: Record<string, number>;
  costByModelByStage?: Record<string, Record<string, number>>;
  tokensByModel?: Record<string, number>;
  tokensByModelByStage?: Record<string, Record<string, number>>;
  totalTokens?: number;
  durationMs: number;
  elo: {
    initial: Array<{ model: string; rating: number; ci95?: number }>;
    revised: Array<{ model: string; rating: number; ci95?: number }>;
  };
}

export interface RunsIndex {
  runs: RunIndexEntry[];
  cumulativeElo: {
    writing: EloEntry[];
    feedback: EloEntry[];
    byTag?: Record<string, EloEntry[]>;
  };
  eloHistory: Array<{
    runId: string;
    timestamp: string;
    ratings: Record<string, number>;
  }>;
  /** Cumulative judge quality (aggregated across all runs). */
  cumulativeJudgeQuality?: JudgeQualityEntry[];
  /** Cumulative alternative rating sets. */
  cumulativeAlternativeRatings?: AlternativeRatings;
}
