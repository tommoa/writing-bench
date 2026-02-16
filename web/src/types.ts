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
  category: string;
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
}

export interface EloSnapshot {
  stage: "initial" | "revised";
  ratings: EloRating[];
  feedbackRatings?: EloRating[];
  byCategory?: Record<string, EloRating[]>;
}

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
    speedByModel: Record<string, ModelSpeed>;
    durationMs: number;
  };
  modelInfo: Record<string, ModelInfo>;
}

export interface EloEntry {
  model: string;
  rating: number;
  matchCount: number;
}

export interface RunIndexEntry {
  id: string;
  timestamp: string;
  models: string[];
  promptCount: number;
  outputsPerModel: number;
  totalCost: number;
  durationMs: number;
  elo: {
    initial: Array<{ model: string; rating: number }>;
    revised: Array<{ model: string; rating: number }>;
  };
}

export interface RunsIndex {
  runs: RunIndexEntry[];
  cumulativeElo: {
    writing: EloEntry[];
    feedback: EloEntry[];
    byCategory?: Record<string, EloEntry[]>;
  };
  eloHistory: Array<{
    runId: string;
    timestamp: string;
    ratings: Record<string, number>;
  }>;
}
