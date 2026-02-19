import { streamText } from "ai";
import { nanoid } from "nanoid";
import { resolveModel } from "../providers/registry.js";
import { withRetry, OutputTruncatedError } from "./retry.js";
import { resolveMaxOutputTokens, resolveTemperature } from "./model-utils.js";
import {
  getModelInfoMap,
  calculateCost,
} from "../providers/models.js";
import {
  judgePair,
  randomizePairOrder,
  correctForSwap,
} from "./judge.js";
import {
  computeWhr,
  whrRatings,
  maxCiHalfWidth,
  hasOverlap,
  judgmentsToGames,
  improvementJudgmentsToGames,
} from "./whr.js";
import type { WhrRating, WhrResult } from "./whr.js";
import { computeJudgeQuality, computeEloBasedJudgeQuality } from "./judge-quality.js";
import type { JudgeQualityData } from "./judge-quality.js";
import {
  SampleCache,
  type CachedWrite,
} from "../storage/sample-cache.js";
import {
  identifyNeeds,
  isConverged,
  judgmentKey,
  sampleKey,
  feedbackKey,
  revisionKey,
  judgmentGroupKey,
  completedWorkSize,
  emptyCompletedWork,
  formatNeedDescription,
  formatBatchSummary,
  formatConvergenceTarget,
} from "./need-identifier.js";
import type { Need, CompletedWork } from "./need-identifier.js";
import {
  extractUsage,
  extractTaskError,
  type RunConfig,
  type RunResult,
  type TaskError,
  type WritingSample,
  type Feedback,
  type PairwiseJudgment,
  type ModelConfig,
  type PromptConfig,
  type BenchmarkEvent,
  type CostBreakdown,
  type TokenUsage,
  type ModelInfo,
  type ModelSpeed,
  type BenchmarkStage,
  type EloRating,
} from "../types.js";

type EventHandler = (event: BenchmarkEvent) => void;

const ZERO_COST: CostBreakdown = Object.freeze({ input: 0, output: 0, total: 0, totalUncached: 0 });

/**
 * Pull-based adaptive benchmark runner. Instead of generating all work
 * upfront (push), this runner:
 *
 *   1. Seeds from cache — loads ALL cached artifacts at zero cost
 *   2. Computes WHR ratings with confidence intervals
 *   3. Pulls only the work needed to reduce uncertainty below threshold
 *   4. Repeats until all CIs converge or work is exhausted
 */
export class BenchmarkRunner {
  private handlers: EventHandler[] = [];
  private modelInfoMap: Record<string, ModelInfo> = {};
  private totalCost = 0;
  private totalCostUncached = 0;
  private costByModel: Record<string, number> = {};
  private costByStage: Record<string, number> = {};
  private costByModelByStage: Record<string, Record<string, number>> = {};
  private totalTokens = 0;
  // Per-model speed accumulators: [totalLatencyMs, totalOutputTokens, calls]
  private speedAccum: Record<string, [number, number, number]> = {};
  // Per-model-per-stage speed accumulators
  private speedAccumByStage: Record<string, Record<string, [number, number, number]>> = {};

  // ── Collected results ─────────────────────────────
  private initialSamples: WritingSample[] = [];
  private revisedSamples: WritingSample[] = [];
  private allFeedback: Feedback[] = [];
  private initialJudgments: PairwiseJudgment[] = [];
  private revisedJudgments: PairwiseJudgment[] = [];
  private improvementJudgments: PairwiseJudgment[] = [];
  private taskErrors: TaskError[] = [];

  // ── Pull-based tracking ───────────────────────────
  // Keyed stores for dedup and lookup
  private sampleStore = new Map<string, WritingSample>(); // "model:promptId:outputIndex" → sample
  private feedbackStore = new Map<string, Feedback>();     // "sourceModel:targetSampleId" → feedback
  private revisionStore = new Map<string, WritingSample>(); // "writer:originalSampleId:feedbackId" → revision
  private completedWork: CompletedWork = emptyCompletedWork();

  // Inflight dedup — coalesce concurrent requests for the same artifact
  private inflightSamples = new Map<string, Promise<WritingSample | null>>();
  private inflightFeedback = new Map<string, Promise<Feedback | null>>();
  private inflightRevisions = new Map<string, Promise<WritingSample | null>>();
  private inflightJudgments = new Map<string, Promise<PairwiseJudgment | null>>();

  // Cache for getCachedWrites to avoid repeated filesystem reads
  private cachedWritesCache = new Map<string, CachedWrite[]>();

  // Lookup maps for fast model/prompt resolution (built once in run())
  private modelMap = new Map<string, ModelConfig>();
  private promptMap = new Map<string, PromptConfig>();

  // WHR state
  private writingWhr: WhrResult = { ratings: [], converged: true, iterations: 0 };
  private revisedWhr: WhrResult = { ratings: [], converged: true, iterations: 0 };
  private feedbackWhr: WhrResult = { ratings: [], converged: true, iterations: 0 };

  // Judge quality state
  private judgeQuality: JudgeQualityData = {
    ratings: [], weights: new Map(), active: false, instanceCount: 0,
  };

  /** Judge weights when active, undefined during bootstrap. */
  private get activeJudgeWeights(): Map<string, number> | undefined {
    return this.judgeQuality.active ? this.judgeQuality.weights : undefined;
  }

  // Progress tracking
  private opsDone = 0;
  private judgingRound = 0;
  private lastRatingRecompute = 0;
  private maxOutputCount = 0;
  private inflight: Record<string, number> = {};
  // Cached progress values — recomputed in recomputeRatings() instead
  // of on every emitProgress call (avoids O(n²) per progress update).
  private cachedMaxCi = 0;
  private cachedOverlapProgress = 0;

  // Need context for UI
  private currentNeedDescription?: string;
  private currentBatchSummary?: string;
  private currentRatingMap = new Map<string, WhrRating>();

  // ── Cache provenance tracking ─────────────────────
  private cache = new SampleCache();
  private sampleToCacheId = new Map<string, string>();
  private feedbackToCacheId = new Map<string, string>();
  private cacheStats = {
    writes:     { cached: 0, fresh: 0, savedCost: 0 },
    feedback:   { cached: 0, fresh: 0, savedCost: 0 },
    revisions:  { cached: 0, fresh: 0, savedCost: 0 },
    judgments:   { cached: 0, fresh: 0, savedCost: 0 },
  };

  /** Models used for judging — separate from writers if --judges is set. */
  private judgeModels: ModelConfig[];

  constructor(private config: RunConfig) {
    this.judgeModels = config.judges?.length ? config.judges : config.models;
  }

  on(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /** Track the highest output count seen (updated incrementally in ensureSample). */
  private trackOutputCount(outputIndex: number): void {
    const count = outputIndex + 1;
    if (count > this.maxOutputCount) this.maxOutputCount = count;
  }

  private emit(event: BenchmarkEvent): void {
    for (const h of this.handlers) {
      h(event);
    }
  }

  /**
   * Coalesce concurrent async work for the same key. If a promise is
   * already in-flight for `key`, return it instead of starting `fn`.
   */
  private dedup<T>(
    map: Map<string, Promise<T>>,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const inflight = map.get(key);
    if (inflight) return inflight;
    const promise = fn();
    map.set(key, promise);
    promise.finally(() => map.delete(key));
    return promise;
  }

  private beginStage(stage: string): void {
    this.inflight[stage] = (this.inflight[stage] ?? 0) + 1;
  }

  private endStage(stage: string): void {
    this.inflight[stage] = Math.max(0, (this.inflight[stage] ?? 0) - 1);
  }

  private trackCost(
    model: string,
    stage: string,
    cost: CostBreakdown
  ): void {
    this.totalCost += cost.total;
    this.totalCostUncached += cost.totalUncached;
    this.costByModel[model] = (this.costByModel[model] ?? 0) + cost.total;
    this.costByStage[stage] = (this.costByStage[stage] ?? 0) + cost.total;
    const modelStages = this.costByModelByStage[model] ?? {};
    modelStages[stage] = (modelStages[stage] ?? 0) + cost.total;
    this.costByModelByStage[model] = modelStages;
  }

  private trackSpeed(
    model: string,
    stage: string,
    latencyMs: number,
    outputTokens: number
  ): void {
    const acc = this.speedAccum[model] ?? [0, 0, 0];
    acc[0] += latencyMs;
    acc[1] += outputTokens;
    acc[2] += 1;
    this.speedAccum[model] = acc;

    const byStage = this.speedAccumByStage[model] ?? {};
    const stageAcc = byStage[stage] ?? [0, 0, 0];
    stageAcc[0] += latencyMs;
    stageAcc[1] += outputTokens;
    stageAcc[2] += 1;
    byStage[stage] = stageAcc;
    this.speedAccumByStage[model] = byStage;
  }

  private computeSpeedByModel(): Record<string, ModelSpeed> {
    const result: Record<string, ModelSpeed> = {};
    for (const [model, accum] of Object.entries(this.speedAccum)) {
      result[model] = BenchmarkRunner.accumToSpeed(accum);
    }
    return result;
  }

  private static accumToSpeed([totalLatencyMs, totalOutputTokens, calls]: [number, number, number]): ModelSpeed {
    return {
      totalLatencyMs,
      totalOutputTokens,
      tokensPerSecond: totalLatencyMs > 0 ? (totalOutputTokens / totalLatencyMs) * 1000 : 0,
      calls,
      avgLatencyMs: calls > 0 ? Math.round(totalLatencyMs / calls) : 0,
    };
  }

  private computeSpeedByModelByStage(): Record<string, Record<string, ModelSpeed>> {
    const result: Record<string, Record<string, ModelSpeed>> = {};
    for (const [model, stages] of Object.entries(this.speedAccumByStage)) {
      result[model] = {};
      for (const [stage, acc] of Object.entries(stages)) {
        result[model][stage] = BenchmarkRunner.accumToSpeed(acc);
      }
    }
    return result;
  }

  private emitProgress(currentOp: string): void {
    const maxCi = this.cachedMaxCi;
    const ciThreshold = this.config.convergence.ciThreshold;

    const activeStages = (Object.entries(this.inflight)
      .filter(([, count]) => count > 0)
      .map(([stage]) => stage) as BenchmarkStage[]);

    this.emit({
      type: "progress",
      data: {
        stage: activeStages[0] ?? "initialWriting",
        activeStages,
        stageProgress: this.computeStageProgress(maxCi, ciThreshold),
        stageDone: this.opsDone,
        currentOp,
        elo: {
          initial: this.writingWhr.ratings,
          revised: this.revisedWhr.ratings,
          feedback: this.feedbackWhr.ratings,
          judgeQuality: this.judgeQuality.active ? this.judgeQuality.ratings : undefined,
        },
        judgeWeights: this.judgeQuality.active
          ? Object.fromEntries(this.judgeQuality.weights)
          : undefined,
        judgePruneThreshold: this.config.convergence.judgePruneThreshold,
        judgeQualityMode: this.config.convergence.judgeQualityMode,
        totalCost: this.totalCost,
        totalCostUncached: this.totalCostUncached,
        costByModel: { ...this.costByModel },
        costByStage: { ...this.costByStage },
        costByModelByStage: structuredClone(this.costByModelByStage),
        speedByModel: this.computeSpeedByModel(),
        speedByModelByStage: this.computeSpeedByModelByStage(),
        cacheSavings: {
          writes:    { ...this.cacheStats.writes },
          feedback:  { ...this.cacheStats.feedback },
          revisions: { ...this.cacheStats.revisions },
          judgments:  { ...this.cacheStats.judgments },
        },
        judgingRound: this.judgingRound,
        maxCi: maxCi === Infinity ? undefined : maxCi,
        ciThreshold,
        needDescription: this.currentNeedDescription,
        batchSummary: this.currentBatchSummary,
      },
    });
  }

  /**
   * Compute stage progress as a 0-1 fraction for the current convergence mode.
   * In CI-threshold mode: ratio of how close maxCi is to the threshold.
   * In overlap mode: fraction of resolved (non-overlapping) pairs.
   */
  private computeStageProgress(maxCi: number, ciThreshold: number): number {
    if (ciThreshold > 0) {
      return maxCi < Infinity
        ? Math.min(1, 1 - (maxCi - ciThreshold) / (maxCi + ciThreshold))
        : 0;
    }
    return this.cachedOverlapProgress;
  }

  /**
   * Compute convergence progress for overlap-based mode (ciThreshold = 0).
   * Returns the fraction of model pairs (across all 3 dimensions) that
   * are non-overlapping, weighted equally across dimensions.
   */
  private computeOverlapProgress(): number {
    const numModels = this.config.models.length;
    // Total pairs across 3 dimensions; missing models contribute unresolved pairs.
    const totalPairs = numModels >= 2 ? 3 * (numModels * (numModels - 1)) / 2 : 0;
    if (totalPairs === 0) return 0;

    let resolvedPairs = 0;
    for (const ratings of [this.writingWhr.ratings, this.revisedWhr.ratings, this.feedbackWhr.ratings]) {
      for (let i = 0; i < ratings.length; i++) {
        for (let j = i + 1; j < ratings.length; j++) {
          if (!hasOverlap(ratings[i], ratings[j])) resolvedPairs++;
        }
      }
    }
    return resolvedPairs / totalPairs;
  }

  // ── WHR Recomputation ─────────────────────────────

  /**
   * Recompute judge quality from all accumulated judgments.
   * Expensive (pools + groups all judgments, runs WHR on judge games).
   * Only called at round boundaries, not on throttled mid-batch updates.
   */
  private recomputeJudgeQuality(): void {
    if (!this.config.convergence.judgeQuality) return;
    const mode = this.config.convergence.judgeQualityMode;
    const judgeLabels = this.judgeModels.map((m) => m.label);
    const k = this.config.convergence.judgeDecay;

    if (mode === "consensus") {
      const allJudgments = [
        ...this.initialJudgments,
        ...this.revisedJudgments,
        ...this.improvementJudgments,
      ];
      this.judgeQuality = computeJudgeQuality(allJudgments, judgeLabels, k);
    } else {
      // ELO-based: use model's rating in the chosen dimension as proxy for judge quality.
      // Uses previous round's ratings (natural fixed-point iteration).
      const dimensionRatings =
        mode === "writing" ? this.writingWhr.ratings :
        mode === "feedback" ? this.feedbackWhr.ratings :
        this.revisedWhr.ratings;
      this.judgeQuality = computeEloBasedJudgeQuality(dimensionRatings, judgeLabels, k);
    }
  }

  // TODO: Maintain these maps incrementally (append in ensureSample/
  // ensureRevision) instead of rebuilding from full arrays each round.
  private recomputeRatings(): void {
    const sampleToModel = new Map(
      this.initialSamples.map((s) => [s.id, s.model])
    );
    const revisedSampleToModel = new Map(
      this.revisedSamples.map((s) => [s.id, s.model])
    );
    const sampleToFeedbackModel = new Map(
      this.revisedSamples
        .filter((s) => s.feedbackModel)
        .map((s) => [s.id, s.feedbackModel!])
    );

    // Pass judge weights when active — the unified functions default to
    // unweighted (weight=1.0) when no judgeWeights map is provided.
    const jw = this.activeJudgeWeights;
    this.writingWhr = computeWhr(judgmentsToGames(this.initialJudgments, sampleToModel, jw));
    this.revisedWhr = computeWhr(judgmentsToGames(this.revisedJudgments, revisedSampleToModel, jw));
    this.feedbackWhr = computeWhr(improvementJudgmentsToGames(this.improvementJudgments, sampleToFeedbackModel, jw));
    this.lastRatingRecompute = Date.now();

    // Update cached progress values so emitProgress doesn't recompute them
    this.cachedMaxCi = Math.max(
      maxCiHalfWidth(this.writingWhr),
      maxCiHalfWidth(this.revisedWhr),
      maxCiHalfWidth(this.feedbackWhr),
    );
    const ciThreshold = this.config.convergence.ciThreshold;
    this.cachedOverlapProgress = ciThreshold === 0 ? this.computeOverlapProgress() : 0;
  }

  /** Throttled recompute: at most once per 100ms, only during the adaptive loop. */
  private maybeRecomputeRatings(): void {
    if (this.judgingRound <= 0) return;
    if (Date.now() - this.lastRatingRecompute < 100) return;
    this.recomputeRatings();
  }

  // ── Ensure* Pattern (cache-first, lazy generation) ─

  /**
   * Ensure a writing sample exists for (model, prompt, outputIndex).
   * Checks in-memory → cache → generates fresh.
   * Returns null in cacheOnly mode when not available.
   */
  private ensureSample(
    modelCfg: ModelConfig,
    prompt: PromptConfig,
    outputIndex: number,
    cacheOnly = false,
  ): Promise<WritingSample | null> {
    const storeKey = `${modelCfg.label}:${prompt.id}:${outputIndex}`;
    const existing = this.sampleStore.get(storeKey);
    if (existing) return Promise.resolve(existing);

    return this.dedup(this.inflightSamples, storeKey, async () => {
      // Check cache (memoized to avoid repeated filesystem reads)
      if (!this.config.noCache) {
        const cacheKey = `${modelCfg.provider}:${modelCfg.model}:${prompt.prompt}`;
        let cached = this.cachedWritesCache.get(cacheKey);
        if (!cached) {
          cached = await this.cache.getCachedWrites(
            modelCfg.provider, modelCfg.model, prompt.prompt,
          );
          this.cachedWritesCache.set(cacheKey, cached);
        }
        if (cached.length > outputIndex) {
          const cs = cached[outputIndex];
          const sample: WritingSample = {
            id: nanoid(),
            model: modelCfg.label,
            promptId: prompt.id,
            outputIndex,
            text: cs.text,
            stage: "initial",
            fromCache: true,
            usage: cs.usage,
            cost: ZERO_COST,
            latencyMs: 0,
          };
          this.sampleToCacheId.set(sample.id, cs.cacheId);
          this.cacheStats.writes.cached++;
          this.cacheStats.writes.savedCost += cs.cost.total;
          this.initialSamples.push(sample);
          this.sampleStore.set(storeKey, sample);
          this.trackOutputCount(outputIndex);
          this.opsDone++;
          this.emit({ type: "sampleComplete", data: sample });
          return sample;
        }
      }

      if (cacheOnly) return null;

      // Generate fresh
      this.beginStage("initialWriting");
      this.emitProgress(`${modelCfg.label} writing "${prompt.name}" (${outputIndex + 1})`);

      try {
        const sample = await this.generateSample(modelCfg, prompt, outputIndex, "initial");
        const cacheId = sample.id;
        this.sampleToCacheId.set(sample.id, cacheId);

        await this.cache.addCachedWrite(
          modelCfg.provider, modelCfg.model, prompt.prompt,
          {
            cacheId,
            text: sample.text,
            usage: sample.usage,
            cost: sample.cost,
            latencyMs: sample.latencyMs,
            createdAt: new Date().toISOString(),
          },
        );

        // Invalidate memoized cache so subsequent lookups see the new entry
        this.cachedWritesCache.delete(
          `${modelCfg.provider}:${modelCfg.model}:${prompt.prompt}`,
        );

        this.cacheStats.writes.fresh++;
        this.initialSamples.push(sample);
        this.sampleStore.set(storeKey, sample);
        this.trackOutputCount(outputIndex);
        this.opsDone++;
        this.emit({ type: "sampleComplete", data: sample });
        return sample;
      } finally {
        this.endStage("initialWriting");
      }
    });
  }

  /**
   * Ensure feedback exists from sourceModel on targetSample.
   * Checks in-memory → cache → generates fresh.
   */
  private ensureFeedback(
    sourceModel: ModelConfig,
    targetSample: WritingSample,
    prompt: PromptConfig,
    cacheOnly = false,
  ): Promise<Feedback | null> {
    const storeKey = `${sourceModel.label}:${targetSample.id}`;
    const existing = this.feedbackStore.get(storeKey);
    if (existing) return Promise.resolve(existing);

    return this.dedup(this.inflightFeedback, storeKey, async () => {
      // Check cache
      const writeCacheId = this.sampleToCacheId.get(targetSample.id);
      if (writeCacheId && !this.config.noCache) {
        const cached = await this.cache.getCachedFeedback(
          sourceModel.provider, sourceModel.model, writeCacheId,
        );
        if (cached) {
          const feedback: Feedback = {
            id: nanoid(),
            sourceModel: sourceModel.label,
            targetSampleId: targetSample.id,
            text: cached.text,
            fromCache: true,
            usage: cached.usage,
            cost: ZERO_COST,
            latencyMs: 0,
          };
          this.feedbackToCacheId.set(feedback.id, cached.cacheId);
          this.cacheStats.feedback.cached++;
          this.cacheStats.feedback.savedCost += cached.cost.total;
          this.allFeedback.push(feedback);
          this.feedbackStore.set(storeKey, feedback);
          this.opsDone++;
          this.emit({ type: "feedbackComplete", data: feedback });
          return feedback;
        }
      }

      if (cacheOnly) return null;

      // Generate fresh
      this.beginStage("feedback");
      this.emitProgress(`${sourceModel.label} reviewing ${targetSample.model}'s "${prompt.name}"`);

      try {
        const feedback = await this.generateFeedback(sourceModel, prompt, targetSample);
        const fbCacheId = feedback.id;
        this.feedbackToCacheId.set(feedback.id, fbCacheId);

        if (writeCacheId) {
          await this.cache.addCachedFeedback(
            sourceModel.provider, sourceModel.model, writeCacheId,
            {
              cacheId: fbCacheId,
              writeCacheId,
              sourceModel: sourceModel.label,
              text: feedback.text,
              usage: feedback.usage,
              cost: feedback.cost,
              latencyMs: feedback.latencyMs,
              createdAt: new Date().toISOString(),
            },
          );
        }

        this.cacheStats.feedback.fresh++;
        this.allFeedback.push(feedback);
        this.feedbackStore.set(storeKey, feedback);
        this.opsDone++;
        this.emit({ type: "feedbackComplete", data: feedback });
        return feedback;
      } finally {
        this.endStage("feedback");
      }
    });
  }

  /**
   * Ensure a revision exists for (writer, original, feedback).
   * Checks in-memory → cache → generates fresh.
   */
  private ensureRevision(
    writerCfg: ModelConfig,
    original: WritingSample,
    feedback: Feedback,
    prompt: PromptConfig,
    cacheOnly = false,
  ): Promise<WritingSample | null> {
    const storeKey = `${writerCfg.label}:${original.id}:${feedback.id}`;
    const existing = this.revisionStore.get(storeKey);
    if (existing) return Promise.resolve(existing);

    return this.dedup(this.inflightRevisions, storeKey, async () => {
      // Check cache
      const fbCacheId = this.feedbackToCacheId.get(feedback.id);
      if (fbCacheId && !this.config.noCache) {
        const cached = await this.cache.getCachedRevision(
          writerCfg.provider, writerCfg.model, fbCacheId,
        );
        if (cached) {
          const revised: WritingSample = {
            id: nanoid(),
            model: writerCfg.label,
            promptId: prompt.id,
            outputIndex: original.outputIndex,
            text: cached.text,
            stage: "revised",
            originalSampleId: original.id,
            feedbackUsed: feedback.id,
            feedbackModel: feedback.sourceModel,
            fromCache: true,
            usage: cached.usage,
            cost: ZERO_COST,
            latencyMs: 0,
          };
          this.sampleToCacheId.set(revised.id, cached.cacheId);
          this.cacheStats.revisions.cached++;
          this.cacheStats.revisions.savedCost += cached.cost.total;
          this.revisedSamples.push(revised);
          this.revisionStore.set(storeKey, revised);
          this.opsDone++;
          this.emit({ type: "sampleComplete", data: revised });
          return revised;
        }
      }

      if (cacheOnly) return null;

      // Generate fresh
      this.beginStage("revisedWriting");
      this.emitProgress(
        `${writerCfg.label} revising "${prompt.name}" with ${feedback.sourceModel}'s feedback`,
      );

      try {
        const revised = await this.generateRevision(writerCfg, prompt, original, feedback);
        const revCacheId = revised.id;
        this.sampleToCacheId.set(revised.id, revCacheId);

        if (fbCacheId) {
          await this.cache.addCachedRevision(
            writerCfg.provider, writerCfg.model, fbCacheId,
            {
              cacheId: revCacheId,
              feedbackCacheId: fbCacheId,
              text: revised.text,
              usage: revised.usage,
              cost: revised.cost,
              latencyMs: revised.latencyMs,
              createdAt: new Date().toISOString(),
            },
          );
        }

        this.cacheStats.revisions.fresh++;
        this.revisedSamples.push(revised);
        this.revisionStore.set(storeKey, revised);
        this.opsDone++;
        this.emit({ type: "sampleComplete", data: revised });
        return revised;
      } finally {
        this.endStage("revisedWriting");
      }
    });
  }

  /**
   * Ensure a judgment exists and is recorded.
   * Checks cache → calls doJudge if needed.
   */
  private ensureJudgment(
    judgeCfg: ModelConfig,
    prompt: PromptConfig,
    sampleA: WritingSample,
    sampleB: WritingSample,
    stage: "initial" | "revised" | "improvement",
    cacheOnly = false,
  ): Promise<PairwiseJudgment | null> {
    const dedupKey = `${judgeCfg.label}:${stage}:${sampleA.id}:${sampleB.id}`;

    return this.dedup(this.inflightJudgments, dedupKey, async () => {
      // Check cache
      const cacheIdA = this.sampleToCacheId.get(sampleA.id);
      const cacheIdB = this.sampleToCacheId.get(sampleB.id);
      if (cacheIdA && cacheIdB && !this.config.noCache) {
        const cached = await this.cache.getCachedJudgment(
          judgeCfg.provider, judgeCfg.model, stage, cacheIdA, cacheIdB,
        );
        if (cached) {
          const judgment: PairwiseJudgment = {
            id: nanoid(),
            judgeModel: judgeCfg.label,
            promptId: prompt.id,
            sampleA: sampleA.id,
            sampleB: sampleB.id,
            winner: cached.winner,
            reasoning: cached.reasoning,
            stage,
            usage: cached.usage,
            cost: ZERO_COST,
            latencyMs: 0,
          };
          this.cacheStats.judgments.cached++;
          this.cacheStats.judgments.savedCost += cached.cost.total;
          this.addJudgment(judgment);
          this.opsDone++;
          this.emit({ type: "judgmentComplete", data: judgment });
          this.maybeRecomputeRatings();
          this.emitProgress(`[cached] ${judgeCfg.label} judged "${prompt.name}" (${stage})`);
          return judgment;
        }
      }

      if (cacheOnly) return null;

      // Generate fresh judgment
      const stageLabel = stage === "initial" ? "initialJudging" : "revisedJudging";
      this.beginStage(stageLabel);
      this.emitProgress(`${judgeCfg.label} judging "${prompt.name}" (${stage})`);

      try {
        const judgment = await this.doJudge(judgeCfg, prompt, sampleA, sampleB, stage);

        // Cache the judgment
        if (cacheIdA && cacheIdB) {
          await this.cache.addCachedJudgment(
            judgeCfg.provider, judgeCfg.model, stage, cacheIdA, cacheIdB,
            {
              cacheId: judgment.id,
              winner: judgment.winner,
              reasoning: judgment.reasoning,
              stage,
              usage: judgment.usage,
              cost: judgment.cost,
              latencyMs: judgment.latencyMs,
              createdAt: new Date().toISOString(),
            },
          );
        }

        this.cacheStats.judgments.fresh++;
        this.addJudgment(judgment);
        this.opsDone++;
        this.emit({ type: "judgmentComplete", data: judgment });
        this.maybeRecomputeRatings();
        this.emitProgress(`${judgeCfg.label} judged "${prompt.name}" (${stage})`);
        return judgment;
      } finally {
        this.endStage(stageLabel);
      }
    });
  }

  private addJudgment(judgment: PairwiseJudgment): void {
    if (judgment.stage === "initial") this.initialJudgments.push(judgment);
    else if (judgment.stage === "revised") this.revisedJudgments.push(judgment);
    else if (judgment.stage === "improvement") this.improvementJudgments.push(judgment);
  }

  // ── Phase 1: Seed from Cache ──────────────────────

  /**
   * Exhaustively scan the cache for all possible artifacts.
   * Loads writes → feedback → revisions → judgments layer by layer,
   * since each layer's cache keys depend on the previous layer's IDs.
   */
  private async seedFromCache(): Promise<void> {
    const { models, prompts, outputsPerModel } = this.config;

    this.emitProgress("Seeding from cache...");

    // Cache read failures are silently ignored — the adaptive loop
    // will regenerate anything that couldn't be loaded from cache.
    // Within each layer, lookups are independent and run in parallel.
    // Layers are sequential: writes → feedback → revisions → judgments.
    try {
      // Layer 1: Load all cached writes
      // Each (model, prompt) iterates output indices sequentially (break on miss),
      // but all (model, prompt) combos run in parallel.
      // NOTE: When outputsPerModel is Infinity (adaptive mode), the loop
      // guard is always true — it terminates via break when ensureSample
      // returns null (cache exhausted). This is safe because getCachedWrites
      // reads a finite directory.
      await Promise.allSettled(
        models.flatMap((modelCfg) =>
          prompts.map((prompt) =>
            (async () => {
              for (let i = 0; i < outputsPerModel; i++) {
                const result = await this.ensureSample(modelCfg, prompt, i, true);
                if (!result) break;
              }
            })(),
          ),
        ),
      );

      // Layer 2: Load all cached feedback (every model reviews every sample)
      const layer2Samples = [...this.initialSamples];
      await Promise.allSettled(
        models.flatMap((fbModel) =>
          layer2Samples.map((sample) =>
            this.ensureFeedback(
              fbModel, sample, this.promptMap.get(sample.promptId)!, true,
            ),
          ),
        ),
      );

      // Layer 3: Load all cached revisions
      const feedbackBySample = new Map<string, Feedback[]>();
      for (const fb of this.allFeedback) {
        const group = feedbackBySample.get(fb.targetSampleId) ?? [];
        group.push(fb);
        feedbackBySample.set(fb.targetSampleId, group);
      }
      const layer3Tasks: Promise<unknown>[] = [];
      for (const sample of [...this.initialSamples]) {
        const writerCfg = this.modelMap.get(sample.model);
        if (!writerCfg) continue;
        const prompt = this.promptMap.get(sample.promptId)!;
        for (const fb of feedbackBySample.get(sample.id) ?? []) {
          layer3Tasks.push(this.ensureRevision(writerCfg, sample, fb, prompt, true));
        }
      }
      await Promise.allSettled(layer3Tasks);

      // Layer 4: Load all cached judgments (all three judgment types in parallel)
      const layer4Tasks: Promise<unknown>[] = [];

      // Initial judgments
      for (const prompt of prompts) {
        const promptSamples = this.initialSamples.filter((s) => s.promptId === prompt.id);
        for (let i = 0; i < promptSamples.length; i++) {
          for (let j = i + 1; j < promptSamples.length; j++) {
            if (promptSamples[i].model === promptSamples[j].model) continue;
            for (const judge of this.judgeModels) {
              const jkey = judgmentKey("initial",
                promptSamples[i].model, promptSamples[j].model,
                prompt.id, judge.label,
                promptSamples[i].outputIndex, promptSamples[j].outputIndex);
              if (this.completedWork.judgments.has(jkey)) continue;

              layer4Tasks.push(
                this.ensureJudgment(
                  judge, prompt, promptSamples[i], promptSamples[j], "initial", true,
                ).then((result) => {
                  if (result) this.completedWork.judgments.add(jkey);
                }),
              );
            }
          }
        }
      }

      // Improvement judgments (revision vs original)
      const samplesById = new Map(this.initialSamples.map((s) => [s.id, s]));
      for (const revised of [...this.revisedSamples]) {
        if (!revised.originalSampleId) continue;
        const original = samplesById.get(revised.originalSampleId);
        if (!original) continue;
        const prompt = this.promptMap.get(revised.promptId)!;

        for (const judge of this.judgeModels) {
          const jkey = judgmentKey("improvement",
            revised.model, revised.feedbackModel ?? "",
            prompt.id, judge.label, original.outputIndex);
          if (this.completedWork.judgments.has(jkey)) continue;

          layer4Tasks.push(
            this.ensureJudgment(
              judge, prompt, original, revised, "improvement", true,
            ).then((result) => {
              if (result) this.completedWork.judgments.add(jkey);
            }),
          );
        }
      }

      // Revised judgments (within feedback-source groups)
      for (const prompt of prompts) {
        const promptRevisions = this.revisedSamples.filter((s) => s.promptId === prompt.id);
        const byFeedback = new Map<string, WritingSample[]>();
        for (const rev of promptRevisions) {
          const key = rev.feedbackModel ?? "";
          const group = byFeedback.get(key) ?? [];
          group.push(rev);
          byFeedback.set(key, group);
        }

        for (const [, group] of byFeedback) {
          for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
              if (group[i].model === group[j].model) continue;
              for (const judge of this.judgeModels) {
                const jkey = judgmentKey("revised",
                  group[i].model, group[j].model,
                  `${prompt.id}:${group[i].feedbackModel}`, judge.label,
                  group[i].outputIndex, group[j].outputIndex);
                if (this.completedWork.judgments.has(jkey)) continue;

                layer4Tasks.push(
                  this.ensureJudgment(
                    judge, prompt, group[i], group[j], "revised", true,
                  ).then((result) => {
                    if (result) this.completedWork.judgments.add(jkey);
                  }),
                );
              }
            }
          }
        }
      }

      await Promise.allSettled(layer4Tasks);
    } catch {
      // Cache read failure — continue with whatever was loaded
    }
  }

  // ── Phase 2: Fulfill Needs ────────────────────────

  /**
   * Record whether a judgment triple (pair + prompt) was hit or missed.
   * A hit (result != null) always wins — once true, stays true.
   */
  private recordTripleResult(
    tripleResults: Map<string, boolean>,
    key: string,
    result: PairwiseJudgment | null,
  ): void {
    tripleResults.set(key, tripleResults.get(key) || result !== null);
  }

  /**
   * Fulfill a single need by cascading through ensure* methods.
   *
   * `tripleResults` is a per-batch map tracking judgment hit/miss per triple
   * (pair + prompt). After the batch, only triples where ALL judges missed
   * are added to `completedWork.missingJudgments`. This relies on the
   * co-batching invariant: all judges for a triple at the same output-index
   * level land in the same `Promise.allSettled` batch. This holds because
   * `identifyNeeds` scores all judges for a given (pair, prompt, outputIdx)
   * identically, so they are selected together unless the per-pair cap
   * truncates them — which is unlikely given the generous cap formula.
   */
  private async fulfillNeed(need: Need, tripleResults: Map<string, boolean>): Promise<void> {
    this.currentNeedDescription = formatNeedDescription(need, this.currentRatingMap);
    const prompt = this.promptMap.get(need.promptId)!;
    const cacheOnly = this.config.cacheOnly;
    if (need.type === "initial_judgment") {
      await this.fulfillInitial(need, prompt, cacheOnly, tripleResults);
    } else if (need.type === "improvement_judgment") {
      await this.fulfillImprovement(need, prompt, cacheOnly, tripleResults);
    } else if (need.type === "revised_judgment") {
      await this.fulfillRevised(need, prompt, cacheOnly, tripleResults);
    }
  }

  private async fulfillInitial(
    need: Extract<Need, { type: "initial_judgment" }>,
    prompt: PromptConfig,
    cacheOnly: boolean,
    tripleResults: Map<string, boolean>,
  ): Promise<void> {
    const modelACfg = this.modelMap.get(need.modelA)!;
    const modelBCfg = this.modelMap.get(need.modelB)!;
    const key = judgmentKey(
      "initial", need.modelA, need.modelB, need.promptId, need.judgeModel.label,
      need.outputIdxA, need.outputIdxB,
    );

    try {
      const sampleA = await this.ensureSample(modelACfg, prompt, need.outputIdxA, cacheOnly);
      const sampleB = await this.ensureSample(modelBCfg, prompt, need.outputIdxB, cacheOnly);
      if (!sampleA) this.completedWork.missingSamples.add(sampleKey(need.modelA, need.promptId, need.outputIdxA));
      if (!sampleB) this.completedWork.missingSamples.add(sampleKey(need.modelB, need.promptId, need.outputIdxB));
      if (!sampleA || !sampleB) return;

      const tk = judgmentGroupKey(need.modelA, need.modelB, need.promptId, need.outputIdxA, need.outputIdxB);
      const result = await this.ensureJudgment(
        need.judgeModel, prompt, sampleA, sampleB, "initial", cacheOnly,
      );
      this.recordTripleResult(tripleResults, tk, result);
    } finally {
      this.completedWork.judgments.add(key);
    }
  }

  private async fulfillImprovement(
    need: Extract<Need, { type: "improvement_judgment" }>,
    prompt: PromptConfig,
    cacheOnly: boolean,
    tripleResults: Map<string, boolean>,
  ): Promise<void> {
    const writerCfg = this.modelMap.get(need.writer)!;
    const fbModelCfg = this.modelMap.get(need.feedbackModel)!;
    const key = judgmentKey(
      "improvement", need.writer, need.feedbackModel,
      need.promptId, need.judgeModel.label, need.outputIdx,
    );

    try {
      // Cascade: sample → feedback → revision → judge
      const sample = await this.ensureSample(writerCfg, prompt, need.outputIdx, cacheOnly);
      if (!sample) {
        this.completedWork.missingSamples.add(sampleKey(need.writer, need.promptId, need.outputIdx));
        return;
      }

      const feedback = await this.ensureFeedback(fbModelCfg, sample, prompt, cacheOnly);
      if (!feedback) {
        this.completedWork.missingFeedback.add(feedbackKey(need.feedbackModel, need.writer, need.promptId, need.outputIdx));
        return;
      }

      const revision = await this.ensureRevision(writerCfg, sample, feedback, prompt, cacheOnly);
      if (!revision) {
        this.completedWork.missingRevisions.add(revisionKey(need.writer, need.feedbackModel, need.promptId, need.outputIdx));
        return;
      }

      const tk = judgmentGroupKey(need.writer, need.feedbackModel, need.promptId, need.outputIdx, 0);
      const result = await this.ensureJudgment(
        need.judgeModel, prompt, sample, revision, "improvement", cacheOnly,
      );
      this.recordTripleResult(tripleResults, tk, result);
    } finally {
      this.completedWork.judgments.add(key);
    }
  }

  private async fulfillRevised(
    need: Extract<Need, { type: "revised_judgment" }>,
    prompt: PromptConfig,
    cacheOnly: boolean,
    tripleResults: Map<string, boolean>,
  ): Promise<void> {
    const modelACfg = this.modelMap.get(need.modelA)!;
    const modelBCfg = this.modelMap.get(need.modelB)!;
    const fbModelCfg = this.modelMap.get(need.feedbackModel)!;
    const key = judgmentKey(
      "revised", need.modelA, need.modelB,
      `${need.promptId}:${need.feedbackModel}`, need.judgeModel.label,
      need.outputIdxA, need.outputIdxB,
    );

    try {
      // Cascade: sampleA + sampleB → feedbackA + feedbackB → revisionA + revisionB → judge
      const sampleA = await this.ensureSample(modelACfg, prompt, need.outputIdxA, cacheOnly);
      const sampleB = await this.ensureSample(modelBCfg, prompt, need.outputIdxB, cacheOnly);
      if (!sampleA) this.completedWork.missingSamples.add(sampleKey(need.modelA, need.promptId, need.outputIdxA));
      if (!sampleB) this.completedWork.missingSamples.add(sampleKey(need.modelB, need.promptId, need.outputIdxB));
      if (!sampleA || !sampleB) return;

      const fbA = await this.ensureFeedback(fbModelCfg, sampleA, prompt, cacheOnly);
      const fbB = await this.ensureFeedback(fbModelCfg, sampleB, prompt, cacheOnly);
      if (!fbA) this.completedWork.missingFeedback.add(feedbackKey(need.feedbackModel, need.modelA, need.promptId, need.outputIdxA));
      if (!fbB) this.completedWork.missingFeedback.add(feedbackKey(need.feedbackModel, need.modelB, need.promptId, need.outputIdxB));
      if (!fbA || !fbB) return;

      const revA = await this.ensureRevision(modelACfg, sampleA, fbA, prompt, cacheOnly);
      const revB = await this.ensureRevision(modelBCfg, sampleB, fbB, prompt, cacheOnly);
      if (!revA) this.completedWork.missingRevisions.add(revisionKey(need.modelA, need.feedbackModel, need.promptId, need.outputIdxA));
      if (!revB) this.completedWork.missingRevisions.add(revisionKey(need.modelB, need.feedbackModel, need.promptId, need.outputIdxB));
      if (!revA || !revB) return;

      const tk = judgmentGroupKey(need.modelA, need.modelB, `${need.promptId}:${need.feedbackModel}`, need.outputIdxA, need.outputIdxB);
      const result = await this.ensureJudgment(
        need.judgeModel, prompt, revA, revB, "revised", cacheOnly,
      );
      this.recordTripleResult(tripleResults, tk, result);
    } finally {
      this.completedWork.judgments.add(key);
    }
  }

  // ── Main Entry Point ──────────────────────────────

  /**
   * Run the adaptive pull-based benchmark pipeline.
   */
  async run(): Promise<RunResult> {
    const startTime = Date.now();
    const convergence = this.config.convergence;

    // Fetch model metadata for all models (writers + judges, deduplicated)
    const allModelConfigs = new Map<string, { provider: string; model: string; label: string }>();
    for (const m of this.config.models) {
      allModelConfigs.set(m.label, { provider: m.provider, model: m.model, label: m.label });
    }
    for (const m of this.judgeModels) {
      allModelConfigs.set(m.label, { provider: m.provider, model: m.model, label: m.label });
    }
    this.modelInfoMap = await getModelInfoMap([...allModelConfigs.values()]);

    // Build lookup maps for fast model/prompt resolution
    for (const m of this.config.models) this.modelMap.set(m.label, m);
    for (const m of this.judgeModels) this.modelMap.set(m.label, m);
    for (const p of this.config.prompts) this.promptMap.set(p.id, p);

    // Phase 1: Seed from cache — load ALL cached artifacts before any API calls
    // Skipped with --skip-seeding; the adaptive loop discovers cache lazily.
    if (!this.config.skipSeeding) {
      await this.seedFromCache();
      this.recomputeJudgeQuality();
      this.recomputeRatings();
    }

    // Phase 2: Adaptive pull loop — runs until convergence, exhaustion, or
    // max rounds. With --cache-only the ensure methods refuse API calls,
    // so the loop self-terminates once cached work is exhausted.
    {
      // Batch should be large enough to make real progress each round.
      // All work within a batch runs in parallel via the scheduler.
      const W = this.config.models.length;
      const J = this.judgeModels.length;
      const P = this.config.prompts.length;
      const batchSize = Math.max(W * J * P, W * W);

      this.judgingRound = 0;
      while (this.judgingRound < convergence.maxRounds) {
        if (isConverged(
          this.writingWhr.ratings,
          this.revisedWhr.ratings,
          this.feedbackWhr.ratings,
          convergence,
          this.config.models.length,
        )) {
          break;
        }

        // Compute effective output count: current max + 1 for growth, capped
        const effectiveOutputs = Math.min(
          this.config.outputsPerModel,
          this.maxOutputCount + 1,
        );

        const { needs, ratingMap } = identifyNeeds(
          this.writingWhr.ratings,
          this.revisedWhr.ratings,
          this.feedbackWhr.ratings,
          this.completedWork,
          this.config.models,
          this.judgeModels,
          this.config.prompts,
          convergence,
          batchSize,
          effectiveOutputs,
          this.judgeQuality,
        );

        if (needs.length === 0) break; // exhausted all possible work

        this.currentRatingMap = ratingMap;
        this.currentBatchSummary = formatBatchSummary(needs);

        this.emitProgress(
          `Adaptive round ${this.judgingRound + 1}: max CI ±${this.cachedMaxCi === Infinity ? "∞" : this.cachedMaxCi} → target ${formatConvergenceTarget(convergence.ciThreshold)}`,
        );

        // Fulfill needs in parallel — errors are recorded, not propagated.
        // tripleResults tracks per-triple judgment hit/miss within this batch;
        // only triples where ALL judges missed are added to missingJudgments
        // after the batch (post-batch aggregation).
        const opsBefore = this.opsDone;
        const completedBefore = completedWorkSize(this.completedWork);
        const tripleResults = new Map<string, boolean>();

        await Promise.allSettled(needs.map((n) =>
          this.fulfillNeed(n, tripleResults).catch((err) => {
            const model = n.type === "improvement_judgment" ? n.writer : n.modelA;
            const taskError = extractTaskError(err, model);
            this.taskErrors.push(taskError);
            this.emit({ type: "error", data: taskError });
          }),
        ));

        // Post-batch: only triples where ALL judges missed get pruned
        for (const [key, hadHit] of tripleResults) {
          if (!hadHit) this.completedWork.missingJudgments.add(key);
        }

        const completedAfter = completedWorkSize(this.completedWork);

        // Only count productive rounds (with actual ops) toward maxRounds.
        // Cache-miss-only rounds are free — just pruning the candidate space.
        if (this.opsDone > opsBefore) {
          this.judgingRound++;
          this.recomputeJudgeQuality();
          this.recomputeRatings();
          this.emitProgress(`Round ${this.judgingRound} complete`);
        }

        // Stall: no new ops AND no new discoveries (missing artifact sets
        // didn't grow either). Negative caching IS progress — it prunes
        // the candidate space for the next round.
        if (this.opsDone === opsBefore && completedAfter === completedBefore) break;
      }
    }

    // Clear need context — no longer in the adaptive loop
    this.currentNeedDescription = undefined;
    this.currentBatchSummary = undefined;

    // Compute final ratings using WHR (produces confidence intervals)
    this.beginStage("computingElo");
    this.emitProgress("Computing final ratings...");

    const sampleToModel = new Map(
      this.initialSamples.map((s) => [s.id, s.model]),
    );
    const revisedSampleToModel = new Map(
      this.revisedSamples.map((s) => [s.id, s.model]),
    );
    const sampleToFeedbackModel = new Map(
      this.revisedSamples
        .filter((s) => s.feedbackModel)
        .map((s) => [s.id, s.feedbackModel!]),
    );

    // Use judge weights for final ratings (consistent with adaptive loop)
    const jw = this.activeJudgeWeights;
    const initialElo: EloRating[] = whrRatings(
      judgmentsToGames(this.initialJudgments, sampleToModel, jw),
    );
    const revisedElo: EloRating[] = whrRatings(
      judgmentsToGames(this.revisedJudgments, revisedSampleToModel, jw),
    );
    const feedbackElo: EloRating[] = whrRatings(
      improvementJudgmentsToGames(this.improvementJudgments, sampleToFeedbackModel, jw),
    );

    // Per-tag ELO (also via WHR for consistent CIs)
    const promptToTags = new Map(
      this.config.prompts.map((p) => [p.id, p.tags]),
    );
    const allTags = [...new Set(this.config.prompts.flatMap((p) => p.tags))];
    const initialByTag: Record<string, EloRating[]> = {};
    const revisedByTag: Record<string, EloRating[]> = {};

    for (const tag of allTags) {
      initialByTag[tag] = whrRatings(judgmentsToGames(
        this.initialJudgments.filter((j) => promptToTags.get(j.promptId)?.includes(tag)),
        sampleToModel, jw,
      ));

      revisedByTag[tag] = whrRatings(judgmentsToGames(
        this.revisedJudgments.filter((j) => promptToTags.get(j.promptId)?.includes(tag)),
        revisedSampleToModel, jw,
      ));
    }

    this.endStage("computingElo");
    const durationMs = Date.now() - startTime;

    const result: RunResult = {
      config: this.config,
      samples: [...this.initialSamples, ...this.revisedSamples].sort(
        (a, b) =>
          a.promptId.localeCompare(b.promptId) ||
          a.model.localeCompare(b.model) ||
          a.outputIndex - b.outputIndex ||
          (a.stage === "initial" ? 0 : 1) - (b.stage === "initial" ? 0 : 1),
      ),
      feedback: [...this.allFeedback].sort(
        (a, b) =>
          a.targetSampleId.localeCompare(b.targetSampleId) ||
          a.sourceModel.localeCompare(b.sourceModel),
      ),
      judgments: [
        ...this.initialJudgments,
        ...this.revisedJudgments,
        ...this.improvementJudgments,
      ],
      elo: {
        initial: { stage: "initial", ratings: initialElo, byTag: initialByTag },
        revised: { stage: "revised", ratings: revisedElo, feedbackRatings: feedbackElo, byTag: revisedByTag },
      },
      meta: {
        totalTokens: this.totalTokens,
        totalCost: this.totalCost,
        totalCostUncached: this.totalCostUncached,
        costByModel: { ...this.costByModel },
        costByStage: { ...this.costByStage },
        costByModelByStage: structuredClone(this.costByModelByStage),
        speedByModel: this.computeSpeedByModel(),
        durationMs,
        errors: this.taskErrors.length > 0 ? [...this.taskErrors] : undefined,
      },
      modelInfo: this.modelInfoMap,
    };

    this.emit({ type: "complete", data: result });
    return result;
  }

  // ── Core Generation Methods ───────────────────────

  private async doJudge(
    judgeCfg: ModelConfig,
    prompt: PromptConfig,
    sampleA: WritingSample,
    sampleB: WritingSample,
    stage: "initial" | "revised" | "improvement",
  ): Promise<PairwiseJudgment> {
    const { pair: orderedPair, swapped } = randomizePairOrder([sampleA, sampleB]);

    const modelInfo = this.modelInfoMap[judgeCfg.label] ?? null;
    const judgment = await judgePair(
      judgeCfg, prompt,
      orderedPair[0], orderedPair[1],
      modelInfo, this.config.reasoning,
    );

    judgment.stage = stage;

    if (swapped) {
      judgment.winner = correctForSwap(judgment.winner, true);
      const tmpA = judgment.sampleA;
      judgment.sampleA = judgment.sampleB;
      judgment.sampleB = tmpA;
    }

    this.totalTokens += judgment.usage.inputTokens + judgment.usage.outputTokens;
    this.trackCost(
      judgeCfg.label,
      stage === "initial" ? "initialJudging" : "revisedJudging",
      judgment.cost,
    );
    this.trackSpeed(
      judgeCfg.label,
      stage === "initial" ? "initialJudging" : "revisedJudging",
      judgment.latencyMs,
      judgment.usage.outputTokens,
    );

    return judgment;
  }

  private async generateSample(
    modelCfg: ModelConfig,
    prompt: PromptConfig,
    outputIndex: number,
    stage: "initial" | "revised",
  ): Promise<WritingSample> {
    const startTime = Date.now();
    const model = await resolveModel(`${modelCfg.provider}:${modelCfg.model}`);

    const systemPrompt = `You are a skilled writer. Write the requested piece to the best of your ability. Focus on quality, depth, and craft.${
      prompt.maxWords ? ` Target length: approximately ${prompt.maxWords} words.` : ""
    }`;

    const modelInfo = this.modelInfoMap[modelCfg.label] ?? null;
    const maxOutputTokens = resolveMaxOutputTokens(modelCfg.maxTokens, modelInfo);

    const { text, usage: rawUsage } = await withRetry(async () => {
      const result = streamText({
        model,
        system: systemPrompt,
        prompt: prompt.prompt,
        temperature: resolveTemperature(modelCfg.temperature, 0.7, modelInfo),
        maxOutputTokens,
        maxRetries: 0,
      });
      const text = await result.text;
      if ((await result.finishReason) === "length") throw new OutputTruncatedError();
      return { text, usage: await result.usage };
    });

    const latencyMs = Date.now() - startTime;
    const usage = extractUsage(rawUsage);
    const cost = calculateCost(modelInfo, usage);

    this.totalTokens += usage.inputTokens + usage.outputTokens;
    this.trackCost(modelCfg.label, stage, cost);
    this.trackSpeed(modelCfg.label, stage, latencyMs, usage.outputTokens);

    return {
      id: nanoid(),
      model: modelCfg.label,
      promptId: prompt.id,
      outputIndex,
      text,
      stage,
      usage,
      cost,
      latencyMs,
    };
  }

  private async generateFeedback(
    feedbackModelCfg: ModelConfig,
    prompt: PromptConfig,
    sample: WritingSample,
  ): Promise<Feedback> {
    const startTime = Date.now();
    const model = await resolveModel(`${feedbackModelCfg.provider}:${feedbackModelCfg.model}`);

    const criteria = prompt.judgingCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const systemPrompt =
      prompt.feedbackPrompt ??
      `You are an expert editor and writing coach. Provide detailed, constructive feedback on the following piece of writing.

Focus your feedback on these areas:
${criteria}

Be specific. Point out both strengths and areas for improvement. Give actionable suggestions for revision.`;

    const userPrompt = `Original prompt: "${prompt.prompt.trim()}"

--- Writing to review ---
${sample.text}

Please provide your detailed feedback.`;

    const modelInfo = this.modelInfoMap[feedbackModelCfg.label] ?? null;
    const maxOutputTokens = resolveMaxOutputTokens(feedbackModelCfg.maxTokens, modelInfo);

    const { text, usage: rawUsage } = await withRetry(async () => {
      const result = streamText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: resolveTemperature(feedbackModelCfg.temperature, 0.3, modelInfo),
        maxOutputTokens,
        maxRetries: 0,
      });
      const text = await result.text;
      if ((await result.finishReason) === "length") throw new OutputTruncatedError();
      return { text, usage: await result.usage };
    });

    const latencyMs = Date.now() - startTime;
    const usage = extractUsage(rawUsage);
    const cost = calculateCost(modelInfo, usage);

    this.totalTokens += usage.inputTokens + usage.outputTokens;
    this.trackCost(feedbackModelCfg.label, "feedback", cost);
    this.trackSpeed(feedbackModelCfg.label, "feedback", latencyMs, usage.outputTokens);

    return {
      id: nanoid(),
      sourceModel: feedbackModelCfg.label,
      targetSampleId: sample.id,
      text,
      usage,
      cost,
      latencyMs,
    };
  }

  private async generateRevision(
    writerCfg: ModelConfig,
    prompt: PromptConfig,
    original: WritingSample,
    feedback: Feedback,
  ): Promise<WritingSample> {
    const startTime = Date.now();
    const model = await resolveModel(`${writerCfg.provider}:${writerCfg.model}`);

    const systemPrompt =
      prompt.revisionPrompt ??
      `You are a skilled writer revising your work. You will receive your original piece, along with expert feedback. Rewrite the piece incorporating the feedback to produce an improved version.${
        prompt.maxWords ? ` Target length: approximately ${prompt.maxWords} words.` : ""
      }

Maintain your original voice and intent while addressing the feedback. Do not simply append changes — produce a cohesive, polished revision.`;

    const userPrompt = `Original prompt: "${prompt.prompt.trim()}"

--- Your original writing ---
${original.text}

--- Expert feedback ---
${feedback.text}

Please write an improved version incorporating this feedback.`;

    const modelInfo = this.modelInfoMap[writerCfg.label] ?? null;
    const maxOutputTokens = resolveMaxOutputTokens(writerCfg.maxTokens, modelInfo);

    const { text, usage: rawUsage } = await withRetry(async () => {
      const result = streamText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: resolveTemperature(writerCfg.temperature, 0.7, modelInfo),
        maxOutputTokens,
        maxRetries: 0,
      });
      const text = await result.text;
      if ((await result.finishReason) === "length") throw new OutputTruncatedError();
      return { text, usage: await result.usage };
    });

    const latencyMs = Date.now() - startTime;
    const usage = extractUsage(rawUsage);
    const cost = calculateCost(modelInfo, usage);

    this.totalTokens += usage.inputTokens + usage.outputTokens;
    this.trackCost(writerCfg.label, "revised", cost);
    this.trackSpeed(writerCfg.label, "revised", latencyMs, usage.outputTokens);

    return {
      id: nanoid(),
      model: writerCfg.label,
      promptId: prompt.id,
      outputIndex: original.outputIndex,
      text,
      stage: "revised",
      originalSampleId: original.id,
      feedbackUsed: feedback.id,
      feedbackModel: feedback.sourceModel,
      usage,
      cost,
      latencyMs,
    };
  }
}
