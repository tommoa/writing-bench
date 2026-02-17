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
  generatePairs,
  randomizePairOrder,
  correctForSwap,
} from "./judge.js";
import {
  computeEloFromJudgments,
  computeFeedbackEloFromImprovements,
} from "./elo.js";
import { Scheduler } from "./scheduler.js";
import {
  SampleCache,
  randomSample as randomSampleFromArray,
  type CachedWrite,
  type CachedFeedback,
  type CachedRevision,
} from "../storage/sample-cache.js";
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

/**
 * Reactive benchmark runner. Instead of sequential stages, each task
 * runs as soon as its dependencies are met:
 *
 *   write(model, prompt) ──┬──> judge(pair)         [as soon as 2+ samples exist for a prompt]
 *                          ├──> feedback(model, sample)  [as soon as the sample exists]
 *                          │         │
 *                          │         └──> revise(writer, sample, feedback)
 *                          │                    │
 *                          │                    └──> judge(revised pair) [as soon as 2+ revisions exist]
 */
export class BenchmarkRunner {
  private scheduler: Scheduler;
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

  // ── Reactive tracking ─────────────────────────────
  // Samples grouped by prompt for pair generation
  private initialByPrompt = new Map<string, WritingSample[]>();
  private revisedByPrompt = new Map<string, WritingSample[]>();
  // Revised samples grouped by prompt+feedbackModel for scoped pairing
  private revisedByPromptAndFeedback = new Map<string, WritingSample[]>();
  // Dedup: track which pairs × judges have been scheduled
  private scheduledInitialJudge = new Set<string>();
  private scheduledRevisedJudge = new Set<string>();
  private scheduledFeedback = new Set<string>();
  private scheduledRevision = new Set<string>();
  private scheduledImprovement = new Set<string>();
  // Track total tasks for progress
  private opsTotal = 0;
  private opsDone = 0;
  // Inflight counts per stage
  private inflight: Record<string, number> = {};

  // ── Cache provenance tracking ─────────────────────
  private cache = new SampleCache();
  // Map run-local sample/feedback IDs to stable cache IDs
  private sampleToCacheId = new Map<string, string>();
  private feedbackToCacheId = new Map<string, string>();
  // Cache savings counters
  private cacheStats = {
    writes:     { cached: 0, fresh: 0, savedCost: 0 },
    feedback:   { cached: 0, fresh: 0, savedCost: 0 },
    revisions:  { cached: 0, fresh: 0, savedCost: 0 },
    judgments:   { cached: 0, fresh: 0, savedCost: 0 },
  };

  /** Models used for judging — separate from writers if --judges is set. */
  private judgeModels: ModelConfig[];

  constructor(private config: RunConfig) {
    this.scheduler = new Scheduler();
    this.judgeModels = config.judges?.length ? config.judges : config.models;
  }

  on(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private emit(event: BenchmarkEvent): void {
    for (const h of this.handlers) {
      h(event);
    }
  }

  /**
   * Schedule a task with error handling. If the task throws, the error
   * is recorded and emitted but does NOT propagate — other tasks continue.
   */
  private scheduleTask(
    provider: string,
    model: string,
    fn: () => Promise<void>
  ): Promise<void> {
    return this.scheduler.schedule(provider, async () => {
      try {
        await fn();
      } catch (err) {
        const taskError = extractTaskError(err, model);
        this.taskErrors.push(taskError);
        this.emit({ type: "error", data: taskError });
      }
    });
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
    for (const [model, [totalLatencyMs, totalOutputTokens, calls]] of Object.entries(this.speedAccum)) {
      result[model] = {
        totalLatencyMs,
        totalOutputTokens,
        tokensPerSecond:
          totalLatencyMs > 0
            ? (totalOutputTokens / totalLatencyMs) * 1000
            : 0,
        calls,
        avgLatencyMs: calls > 0 ? Math.round(totalLatencyMs / calls) : 0,
      };
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

  /** Cached ELO ratings to avoid recomputing on every progress update. */
  private cachedElo: {
    initial: EloRating[];
    revised: EloRating[];
    feedback: EloRating[];
  } = { initial: [], revised: [], feedback: [] };
  private lastEloComputeMs = 0;

  /** Minimum interval between expensive ELO recomputation (ms). */
  private static readonly ELO_THROTTLE_MS = 100;

  private emitProgress(currentOp: string): void {
    const now = Date.now();
    if (now - this.lastEloComputeMs >= BenchmarkRunner.ELO_THROTTLE_MS) {
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

      this.cachedElo = {
        initial: computeEloFromJudgments(this.initialJudgments, sampleToModel),
        revised: computeEloFromJudgments(this.revisedJudgments, revisedSampleToModel),
        feedback: computeFeedbackEloFromImprovements(this.improvementJudgments, sampleToFeedbackModel),
      };
      this.lastEloComputeMs = now;
    }

    const activeStages = (Object.entries(this.inflight)
      .filter(([, count]) => count > 0)
      .map(([stage]) => stage) as BenchmarkStage[]);

    this.emit({
      type: "progress",
      data: {
        stage: activeStages[0] ?? "initialWriting",
        activeStages,
        stageProgress: this.opsTotal > 0 ? this.opsDone / this.opsTotal : 0,
        stageTotal: this.opsTotal,
        stageDone: this.opsDone,
        currentOp,
        elo: this.cachedElo,
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
      },
    });
  }

  /**
   * Run the full benchmark pipeline reactively.
   */
  async run(): Promise<RunResult> {
    const startTime = Date.now();

    // Fetch model metadata for all models (writers + judges, deduplicated)
    const allModelConfigs = new Map<string, { provider: string; model: string; label: string }>();
    for (const m of this.config.models) {
      allModelConfigs.set(m.label, { provider: m.provider, model: m.model, label: m.label });
    }
    for (const m of this.judgeModels) {
      allModelConfigs.set(m.label, { provider: m.provider, model: m.model, label: m.label });
    }
    this.modelInfoMap = await getModelInfoMap([...allModelConfigs.values()]);

    // Pre-calculate total operations for progress tracking
    this.opsTotal = this.estimateTotalOps();

    // Kick off all initial writing tasks — everything else is triggered reactively
    this.startAllWrites();

    // Wait for the scheduler to drain (all reactive tasks complete).
    // Individual task errors are caught by scheduleTask() — they don't
    // propagate here, so one failing model won't kill the entire run.
    await this.scheduler.drain();

    // Compute final ELO
    this.beginStage("computingElo");
    this.emitProgress("Computing ELO ratings...");

    const sampleToModel = new Map(
      this.initialSamples.map((s) => [s.id, s.model])
    );
    const initialElo = computeEloFromJudgments(
      this.initialJudgments,
      sampleToModel
    );

    const revisedSampleToModel = new Map(
      this.revisedSamples.map((s) => [s.id, s.model])
    );
    const revisedElo = computeEloFromJudgments(
      this.revisedJudgments,
      revisedSampleToModel
    );

    const sampleToFeedbackModel = new Map(
      this.revisedSamples
        .filter((s) => s.feedbackModel)
        .map((s) => [s.id, s.feedbackModel!])
    );
    const feedbackElo = computeFeedbackEloFromImprovements(
      this.improvementJudgments,
      sampleToFeedbackModel
    );

    // Compute per-tag ELO
    this.emitProgress("Computing per-tag ELO...");

    const promptToTags = new Map(
      this.config.prompts.map((p) => [p.id, p.tags])
    );
    const allTags = [
      ...new Set(this.config.prompts.flatMap((p) => p.tags)),
    ];

    const initialByTag: Record<string, EloRating[]> = {};
    const revisedByTag: Record<string, EloRating[]> = {};

    for (const tag of allTags) {
      const tagInitialJudgments = this.initialJudgments.filter(
        (j) => promptToTags.get(j.promptId)?.includes(tag)
      );
      initialByTag[tag] = computeEloFromJudgments(
        tagInitialJudgments,
        sampleToModel
      );

      const tagRevisedJudgments = this.revisedJudgments.filter(
        (j) => promptToTags.get(j.promptId)?.includes(tag)
      );
      revisedByTag[tag] = computeEloFromJudgments(
        tagRevisedJudgments,
        revisedSampleToModel
      );
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
          (a.stage === "initial" ? 0 : 1) - (b.stage === "initial" ? 0 : 1)
      ),
      feedback: [...this.allFeedback].sort(
        (a, b) =>
          a.targetSampleId.localeCompare(b.targetSampleId) ||
          a.sourceModel.localeCompare(b.sourceModel)
      ),
      judgments: [
        ...this.initialJudgments,
        ...this.revisedJudgments,
        ...this.improvementJudgments,
      ],
      elo: {
        initial: {
          stage: "initial",
          ratings: initialElo,
          byTag: initialByTag,
        },
        revised: {
          stage: "revised",
          ratings: revisedElo,
          feedbackRatings: feedbackElo,
          byTag: revisedByTag,
        },
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

  private estimateTotalOps(): number {
    const { models, prompts, outputsPerModel } = this.config;
    const W = models.length;           // Writers
    const J = this.judgeModels.length;  // Judges (may equal W)
    const P = prompts.length;
    const N = outputsPerModel;
    const samplesPerPrompt = W * N;

    const writes = W * P * N;
    const pairsPerPrompt = (samplesPerPrompt * (samplesPerPrompt - 1)) / 2;
    const initialJudgments = pairsPerPrompt * J * P;
    const feedback = writes * W;       // Writers give feedback
    const revisions = writes * W;      // Writers revise

    // Improvement: each revision judged vs its original by each judge
    const improvementJudgments = revisions * J;

    // Revised pairs: grouped by feedback source.
    // W feedback groups per prompt, each with W*N revisions (one per writer).
    // Pairs within each group: C(W*N, 2)
    // Total: W * C(W*N, 2) per prompt × J judges × P prompts
    const revisionsPerFbGroup = W * N;
    const pairsPerFbGroup =
      (revisionsPerFbGroup * (revisionsPerFbGroup - 1)) / 2;
    const revisedJudgments = W * pairsPerFbGroup * J * P;

    return (
      writes +
      initialJudgments +
      feedback +
      revisions +
      improvementJudgments +
      revisedJudgments
    );
  }

  // ── Kick off initial writes ───────────────────────

  private startAllWrites(): Promise<void>[] {
    const { models, prompts, outputsPerModel, noCache } = this.config;
    const promises: Promise<void>[] = [];

    for (const modelCfg of models) {
      for (const prompt of prompts) {
        // Wrap per-(model, prompt) in a single task so cache lookup
        // happens once and we know how many to generate
        const p = this.scheduleTask(modelCfg.provider, modelCfg.label, async () => {
          // Check cache for existing writes
          let cached: CachedWrite[] = [];
          if (!noCache) {
            cached = await this.cache.getCachedWrites(
              modelCfg.provider,
              modelCfg.model,
              prompt.prompt
            );
          }

          let samplesToReuse: CachedWrite[];
          let toGenerate: number;

          if (cached.length >= outputsPerModel) {
            samplesToReuse = randomSampleFromArray(cached, outputsPerModel);
            toGenerate = 0;
          } else {
            samplesToReuse = cached;
            toGenerate = outputsPerModel - cached.length;
          }

           // Inject cached samples (no cost/speed tracking, but trigger pipeline)
          for (let i = 0; i < samplesToReuse.length; i++) {
            const cs = samplesToReuse[i];
            const zeroCost: CostBreakdown = { input: 0, output: 0, total: 0, totalUncached: 0 };
            const sample: WritingSample = {
              id: nanoid(),
              model: modelCfg.label,
              promptId: prompt.id,
              outputIndex: i,
              text: cs.text,
              stage: "initial",
              fromCache: true,
              usage: cs.usage,
              cost: zeroCost,
              latencyMs: 0,
            };

            // Track provenance + cache savings
            this.sampleToCacheId.set(sample.id, cs.cacheId);
            this.cacheStats.writes.cached++;
            this.cacheStats.writes.savedCost += cs.cost.total;

            this.initialSamples.push(sample);
            const group = this.initialByPrompt.get(prompt.id) ?? [];
            group.push(sample);
            this.initialByPrompt.set(prompt.id, group);

            this.opsDone++;
            this.emitProgress(
              `[cached] ${modelCfg.label} "${prompt.name}" (${i + 1}/${outputsPerModel})`
            );
            this.emit({ type: "sampleComplete", data: sample });
            this.onInitialSampleComplete(sample);
          }

          // Generate fresh samples for the gap
          for (let i = 0; i < toGenerate; i++) {
            const outputIndex = samplesToReuse.length + i;

            this.beginStage("initialWriting");
            this.emitProgress(
              `${modelCfg.label} writing "${prompt.name}" (${outputIndex + 1}/${outputsPerModel})`
            );

            try {
              const sample = await this.generateSample(
                modelCfg,
                prompt,
                outputIndex,
                "initial"
              );

              // Cache the new sample
              const cacheId = sample.id; // Use the nanoid as the stable cache ID
              this.sampleToCacheId.set(sample.id, cacheId);

              await this.cache.addCachedWrite(
                modelCfg.provider,
                modelCfg.model,
                prompt.prompt,
                {
                  cacheId,
                  text: sample.text,
                  usage: sample.usage,
                  cost: sample.cost,
                  latencyMs: sample.latencyMs,
                  createdAt: new Date().toISOString(),
                }
              );

              // Store result
              this.cacheStats.writes.fresh++;
              this.initialSamples.push(sample);
              const group = this.initialByPrompt.get(prompt.id) ?? [];
              group.push(sample);
              this.initialByPrompt.set(prompt.id, group);

              this.opsDone++;
              this.emit({ type: "sampleComplete", data: sample });

              // Trigger downstream work
              this.onInitialSampleComplete(sample);
            } finally {
              this.endStage("initialWriting");
            }
          }
        });
        promises.push(p);
      }
    }

    return promises;
  }

  // ── Reactive triggers ─────────────────────────────

  /**
   * Called when an initial writing sample completes.
   * Triggers: initial judging (if pairs exist) + feedback.
   */
  private onInitialSampleComplete(sample: WritingSample): void {
    const { models } = this.config;
    const prompt = this.config.prompts.find((p) => p.id === sample.promptId)!;
    const promptSamples = this.initialByPrompt.get(sample.promptId) ?? [];

    // Schedule judging for any new pairs this sample creates
    for (const other of promptSamples) {
      if (other.id === sample.id) continue;

      for (const judgeCfg of this.judgeModels) {
        const key = [sample.id, other.id].sort().join(":") + ":" + judgeCfg.label;
        if (this.scheduledInitialJudge.has(key)) continue;
        this.scheduledInitialJudge.add(key);

        this.scheduleTask(judgeCfg.provider, judgeCfg.label, async () => {
          // Check judgment cache
          const cacheIdA = this.sampleToCacheId.get(sample.id);
          const cacheIdB = this.sampleToCacheId.get(other.id);
          if (cacheIdA && cacheIdB && !this.config.noCache) {
            const cached = await this.cache.getCachedJudgment(
              judgeCfg.provider, judgeCfg.model, "initial", cacheIdA, cacheIdB
            );
            if (cached) {
              const zeroCost: CostBreakdown = { input: 0, output: 0, total: 0, totalUncached: 0 };
              const judgment: PairwiseJudgment = {
                id: nanoid(),
                judgeModel: judgeCfg.label,
                promptId: prompt.id,
                sampleA: sample.id,
                sampleB: other.id,
                winner: cached.winner,
                reasoning: cached.reasoning,
                stage: "initial",
                usage: cached.usage,
                cost: zeroCost,
                latencyMs: 0,
              };
              this.cacheStats.judgments.cached++;
              this.cacheStats.judgments.savedCost += cached.cost.total;
              this.initialJudgments.push(judgment);
              this.opsDone++;
              this.emit({ type: "judgmentComplete", data: judgment });
              this.emitProgress(
                `[cached] ${judgeCfg.label} judged "${prompt.name}" (initial)`
              );
              return;
            }
          }

          this.beginStage("initialJudging");
          this.emitProgress(
            `${judgeCfg.label} judging "${prompt.name}" (initial)`
          );

          try {
            const judgment = await this.doJudge(
              judgeCfg,
              prompt,
              sample,
              other,
              "initial"
            );

            // Cache the judgment
            if (cacheIdA && cacheIdB) {
              await this.cache.addCachedJudgment(
                judgeCfg.provider, judgeCfg.model, "initial", cacheIdA, cacheIdB,
                {
                  cacheId: judgment.id,
                  winner: judgment.winner,
                  reasoning: judgment.reasoning,
                  stage: "initial",
                  usage: judgment.usage,
                  cost: judgment.cost,
                  latencyMs: judgment.latencyMs,
                  createdAt: new Date().toISOString(),
                }
              );
            }

            this.cacheStats.judgments.fresh++;
            this.initialJudgments.push(judgment);
            this.opsDone++;
            this.emit({ type: "judgmentComplete", data: judgment });
            this.emitProgress(
              `${judgeCfg.label} judged "${prompt.name}" (initial)`
            );
          } finally {
            this.endStage("initialJudging");
          }
        });
      }
    }

    // Schedule feedback from every model on this sample
    for (const fbModel of models) {
      const key = `${fbModel.label}:${sample.id}`;
      if (this.scheduledFeedback.has(key)) continue;
      this.scheduledFeedback.add(key);

      this.scheduleTask(fbModel.provider, fbModel.label, async () => {
        // Check feedback cache
        const writeCacheId = this.sampleToCacheId.get(sample.id);
        if (writeCacheId && !this.config.noCache) {
          const cached = await this.cache.getCachedFeedback(
            fbModel.provider,
            fbModel.model,
            writeCacheId
          );

          if (cached) {
            const zeroCost: CostBreakdown = { input: 0, output: 0, total: 0, totalUncached: 0 };
            const feedback: Feedback = {
              id: nanoid(),
              sourceModel: fbModel.label,
              targetSampleId: sample.id,
              text: cached.text,
              fromCache: true,
              usage: cached.usage,
              cost: zeroCost,
              latencyMs: 0,
            };

            this.feedbackToCacheId.set(feedback.id, cached.cacheId);
            this.cacheStats.feedback.cached++;
            this.cacheStats.feedback.savedCost += cached.cost.total;
            this.allFeedback.push(feedback);
            this.opsDone++;
            this.emitProgress(
              `[cached] ${fbModel.label} feedback on ${sample.model}'s "${prompt.name}"`
            );
            this.emit({ type: "feedbackComplete", data: feedback });
            this.onFeedbackComplete(sample, feedback);
            return;
          }
        }

        this.beginStage("feedback");
        this.emitProgress(
          `${fbModel.label} reviewing ${sample.model}'s "${prompt.name}"`
        );

        try {
          const feedback = await this.generateFeedback(fbModel, prompt, sample);

          // Cache the new feedback
          const fbCacheId = feedback.id;
          this.feedbackToCacheId.set(feedback.id, fbCacheId);

          if (writeCacheId) {
            await this.cache.addCachedFeedback(
              fbModel.provider,
              fbModel.model,
              writeCacheId,
              {
                cacheId: fbCacheId,
                writeCacheId,
                sourceModel: fbModel.label,
                text: feedback.text,
                usage: feedback.usage,
                cost: feedback.cost,
                latencyMs: feedback.latencyMs,
                createdAt: new Date().toISOString(),
              }
            );
          }

          this.cacheStats.feedback.fresh++;
          this.allFeedback.push(feedback);
          this.opsDone++;
          this.emit({ type: "feedbackComplete", data: feedback });

          // Trigger revision
          this.onFeedbackComplete(sample, feedback);
        } finally {
          this.endStage("feedback");
        }
      });
    }
  }

  /**
   * Called when feedback completes.
   * Triggers: revision (original writer rewrites with this feedback).
   */
  private onFeedbackComplete(
    originalSample: WritingSample,
    feedback: Feedback
  ): void {
    const { models } = this.config;
    const writerCfg = models.find((m) => m.label === originalSample.model)!;
    const prompt = this.config.prompts.find(
      (p) => p.id === originalSample.promptId
    )!;

    const key = `${writerCfg.label}:${originalSample.id}:${feedback.id}`;
    if (this.scheduledRevision.has(key)) return;
    this.scheduledRevision.add(key);

    this.scheduleTask(writerCfg.provider, writerCfg.label, async () => {
      // Check revision cache
      const fbCacheId = this.feedbackToCacheId.get(feedback.id);
      if (fbCacheId && !this.config.noCache) {
        const cached = await this.cache.getCachedRevision(
          writerCfg.provider,
          writerCfg.model,
          fbCacheId
        );

        if (cached) {
          const zeroCost: CostBreakdown = { input: 0, output: 0, total: 0, totalUncached: 0 };
          const revised: WritingSample = {
            id: nanoid(),
            model: writerCfg.label,
            promptId: prompt.id,
            outputIndex: originalSample.outputIndex,
            text: cached.text,
            stage: "revised",
            originalSampleId: originalSample.id,
            feedbackUsed: feedback.id,
            feedbackModel: feedback.sourceModel,
            fromCache: true,
            usage: cached.usage,
            cost: zeroCost,
            latencyMs: 0,
          };

          this.sampleToCacheId.set(revised.id, cached.cacheId);
          this.cacheStats.revisions.cached++;
          this.cacheStats.revisions.savedCost += cached.cost.total;

          this.revisedSamples.push(revised);
          const group = this.revisedByPrompt.get(prompt.id) ?? [];
          group.push(revised);
          this.revisedByPrompt.set(prompt.id, group);

          const revFbKey = `${prompt.id}:${revised.feedbackModel}`;
          const revFbGroup = this.revisedByPromptAndFeedback.get(revFbKey) ?? [];
          revFbGroup.push(revised);
          this.revisedByPromptAndFeedback.set(revFbKey, revFbGroup);

          this.opsDone++;
          this.emitProgress(
            `[cached] ${writerCfg.label} revision of "${prompt.name}" with ${feedback.sourceModel}'s feedback`
          );
          this.emit({ type: "sampleComplete", data: revised });
          this.onRevisedSampleComplete(revised);
          return;
        }
      }

      this.beginStage("revisedWriting");
      this.emitProgress(
        `${writerCfg.label} revising "${prompt.name}" with ${feedback.sourceModel}'s feedback`
      );

      try {
        const revised = await this.generateRevision(
          writerCfg,
          prompt,
          originalSample,
          feedback
        );

        // Cache the new revision
        const revCacheId = revised.id;
        this.sampleToCacheId.set(revised.id, revCacheId);

        if (fbCacheId) {
          await this.cache.addCachedRevision(
            writerCfg.provider,
            writerCfg.model,
            fbCacheId,
            {
              cacheId: revCacheId,
              feedbackCacheId: fbCacheId,
              text: revised.text,
              usage: revised.usage,
              cost: revised.cost,
              latencyMs: revised.latencyMs,
              createdAt: new Date().toISOString(),
            }
          );
        }

        this.cacheStats.revisions.fresh++;
        this.revisedSamples.push(revised);
        const group = this.revisedByPrompt.get(prompt.id) ?? [];
        group.push(revised);
        this.revisedByPrompt.set(prompt.id, group);

        // Group by prompt + feedback source for scoped pairing
        const fbKey = `${prompt.id}:${revised.feedbackModel}`;
        const fbGroup = this.revisedByPromptAndFeedback.get(fbKey) ?? [];
        fbGroup.push(revised);
        this.revisedByPromptAndFeedback.set(fbKey, fbGroup);

        this.opsDone++;
        this.emit({ type: "sampleComplete", data: revised });

        // Trigger revised judging
        this.onRevisedSampleComplete(revised);
      } finally {
        this.endStage("revisedWriting");
      }
    });
  }

  /**
   * Called when a revised sample completes.
   * Triggers:
   *   1. Improvement judging (revision vs its original)
   *   2. Revised judging against revisions from OTHER writers
   */
  private onRevisedSampleComplete(sample: WritingSample): void {
    const { models } = this.config;
    const prompt = this.config.prompts.find((p) => p.id === sample.promptId)!;

    // 1. Improvement: compare this revision against its original
    if (sample.originalSampleId) {
      const original = this.initialSamples.find(
        (s) => s.id === sample.originalSampleId
      );
      if (original) {
        for (const judgeCfg of this.judgeModels) {
          const key = `imp:${sample.id}:${judgeCfg.label}`;
          if (this.scheduledImprovement.has(key)) continue;
          this.scheduledImprovement.add(key);

          this.scheduleTask(judgeCfg.provider, judgeCfg.label, async () => {
            // Check judgment cache
            const cacheIdOrig = this.sampleToCacheId.get(original.id);
            const cacheIdRev = this.sampleToCacheId.get(sample.id);
            if (cacheIdOrig && cacheIdRev && !this.config.noCache) {
              const cached = await this.cache.getCachedJudgment(
                judgeCfg.provider, judgeCfg.model, "improvement", cacheIdOrig, cacheIdRev
              );
              if (cached) {
                const zeroCost: CostBreakdown = { input: 0, output: 0, total: 0, totalUncached: 0 };
                const judgment: PairwiseJudgment = {
                  id: nanoid(),
                  judgeModel: judgeCfg.label,
                  promptId: prompt.id,
                  sampleA: original.id,
                  sampleB: sample.id,
                  winner: cached.winner,
                  reasoning: cached.reasoning,
                  stage: "improvement",
                  usage: cached.usage,
                  cost: zeroCost,
                  latencyMs: 0,
                };
                this.cacheStats.judgments.cached++;
                this.cacheStats.judgments.savedCost += cached.cost.total;
                this.improvementJudgments.push(judgment);
                this.opsDone++;
                this.emit({ type: "judgmentComplete", data: judgment });
                this.emitProgress(
                  `[cached] ${judgeCfg.label} judged ${sample.model}'s revision (improvement)`
                );
                return;
              }
            }

            this.beginStage("revisedJudging");
            this.emitProgress(
              `${judgeCfg.label} comparing ${sample.model}'s revision vs original "${prompt.name}"`
            );

            try {
              const judgment = await this.doJudge(
                judgeCfg,
                prompt,
                original,
                sample,
                "improvement"
              );

              // Cache the judgment
              if (cacheIdOrig && cacheIdRev) {
                await this.cache.addCachedJudgment(
                  judgeCfg.provider, judgeCfg.model, "improvement", cacheIdOrig, cacheIdRev,
                  {
                    cacheId: judgment.id,
                    winner: judgment.winner,
                    reasoning: judgment.reasoning,
                    stage: "improvement",
                    usage: judgment.usage,
                    cost: judgment.cost,
                    latencyMs: judgment.latencyMs,
                    createdAt: new Date().toISOString(),
                  }
                );
              }

              this.cacheStats.judgments.fresh++;
              this.improvementJudgments.push(judgment);
              this.opsDone++;
              this.emit({ type: "judgmentComplete", data: judgment });
              this.emitProgress(
                `${judgeCfg.label} judged ${sample.model}'s revision (improvement)`
              );
            } finally {
              this.endStage("revisedJudging");
            }
          });
        }
      }
    }

    // 2. Revised judging — only pair within the same feedback source.
    //    Given identical feedback, which writer revised better?
    //    This reduces pairs from C(M², 2) to M × C(M, 2) per prompt.
    if (!sample.feedbackModel) return;

    const fbKey = `${sample.promptId}:${sample.feedbackModel}`;
    const sameFbRevisions =
      this.revisedByPromptAndFeedback.get(fbKey) ?? [];

    for (const other of sameFbRevisions) {
      if (other.id === sample.id) continue;

      for (const judgeCfg of this.judgeModels) {
        const key =
          [sample.id, other.id].sort().join(":") + ":" + judgeCfg.label;
        if (this.scheduledRevisedJudge.has(key)) continue;
        this.scheduledRevisedJudge.add(key);

        this.scheduleTask(judgeCfg.provider, judgeCfg.label, async () => {
          // Check judgment cache
          const cacheIdS = this.sampleToCacheId.get(sample.id);
          const cacheIdO = this.sampleToCacheId.get(other.id);
          if (cacheIdS && cacheIdO && !this.config.noCache) {
            const cached = await this.cache.getCachedJudgment(
              judgeCfg.provider, judgeCfg.model, "revised", cacheIdS, cacheIdO
            );
            if (cached) {
              const zeroCost: CostBreakdown = { input: 0, output: 0, total: 0, totalUncached: 0 };
              const judgment: PairwiseJudgment = {
                id: nanoid(),
                judgeModel: judgeCfg.label,
                promptId: prompt.id,
                sampleA: sample.id,
                sampleB: other.id,
                winner: cached.winner,
                reasoning: cached.reasoning,
                stage: "revised",
                usage: cached.usage,
                cost: zeroCost,
                latencyMs: 0,
              };
              this.cacheStats.judgments.cached++;
              this.cacheStats.judgments.savedCost += cached.cost.total;
              this.revisedJudgments.push(judgment);
              this.opsDone++;
              this.emit({ type: "judgmentComplete", data: judgment });
              this.emitProgress(
                `[cached] ${judgeCfg.label} judged "${prompt.name}" (revised)`
              );
              return;
            }
          }

          this.beginStage("revisedJudging");
          this.emitProgress(
            `${judgeCfg.label} judging "${prompt.name}" (revised, fb: ${sample.feedbackModel})`
          );

          try {
            const judgment = await this.doJudge(
              judgeCfg,
              prompt,
              sample,
              other,
              "revised"
            );

            // Cache the judgment
            if (cacheIdS && cacheIdO) {
              await this.cache.addCachedJudgment(
                judgeCfg.provider, judgeCfg.model, "revised", cacheIdS, cacheIdO,
                {
                  cacheId: judgment.id,
                  winner: judgment.winner,
                  reasoning: judgment.reasoning,
                  stage: "revised",
                  usage: judgment.usage,
                  cost: judgment.cost,
                  latencyMs: judgment.latencyMs,
                  createdAt: new Date().toISOString(),
                }
              );
            }

            this.cacheStats.judgments.fresh++;
            this.revisedJudgments.push(judgment);
            this.opsDone++;
            this.emit({ type: "judgmentComplete", data: judgment });
            this.emitProgress(
              `${judgeCfg.label} judged "${prompt.name}" (revised)`
            );
          } finally {
            this.endStage("revisedJudging");
          }
        });
      }
    }
  }

  // ── Core operations (unchanged) ───────────────────

  private async doJudge(
    judgeCfg: ModelConfig,
    prompt: PromptConfig,
    sampleA: WritingSample,
    sampleB: WritingSample,
    stage: "initial" | "revised" | "improvement"
  ): Promise<PairwiseJudgment> {
    const { pair: orderedPair, swapped } = randomizePairOrder([
      sampleA,
      sampleB,
    ]);

    const modelInfo = this.modelInfoMap[judgeCfg.label] ?? null;
    const judgment = await judgePair(
      judgeCfg,
      prompt,
      orderedPair[0],
      orderedPair[1],
      modelInfo,
      this.config.reasoning
    );

    // Override stage — judgePair uses sampleA.stage which is wrong
    // for improvement judgments (sampleA=initial, sampleB=revised)
    judgment.stage = stage;

    if (swapped) {
      judgment.winner = correctForSwap(judgment.winner, true);
      const tmpA = judgment.sampleA;
      judgment.sampleA = judgment.sampleB;
      judgment.sampleB = tmpA;
    }

    this.totalTokens +=
      judgment.usage.inputTokens + judgment.usage.outputTokens;
    this.trackCost(
      judgeCfg.label,
      stage === "initial" ? "initialJudging" : "revisedJudging",
      judgment.cost
    );
    this.trackSpeed(
      judgeCfg.label,
      stage === "initial" ? "initialJudging" : "revisedJudging",
      judgment.latencyMs,
      judgment.usage.outputTokens
    );

    return judgment;
  }

  private async generateSample(
    modelCfg: ModelConfig,
    prompt: PromptConfig,
    outputIndex: number,
    stage: "initial" | "revised"
  ): Promise<WritingSample> {
    const startTime = Date.now();

    const model = await resolveModel(
      `${modelCfg.provider}:${modelCfg.model}`
    );

    const systemPrompt = `You are a skilled writer. Write the requested piece to the best of your ability. Focus on quality, depth, and craft.${
      prompt.maxWords
        ? ` Target length: approximately ${prompt.maxWords} words.`
        : ""
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
    sample: WritingSample
  ): Promise<Feedback> {
    const startTime = Date.now();

    const model = await resolveModel(
      `${feedbackModelCfg.provider}:${feedbackModelCfg.model}`
    );

    const criteria = prompt.judgingCriteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");

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
    feedback: Feedback
  ): Promise<WritingSample> {
    const startTime = Date.now();

    const model = await resolveModel(
      `${writerCfg.provider}:${writerCfg.model}`
    );

    const systemPrompt =
      prompt.revisionPrompt ??
      `You are a skilled writer revising your work. You will receive your original piece, along with expert feedback. Rewrite the piece incorporating the feedback to produce an improved version.${
        prompt.maxWords
          ? ` Target length: approximately ${prompt.maxWords} words.`
          : ""
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
