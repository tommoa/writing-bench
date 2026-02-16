import { generateText } from "ai";
import { nanoid } from "nanoid";
import { resolveModel } from "../providers/registry.js";
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
  extractUsage,
  type RunConfig,
  type RunResult,
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

  constructor(private config: RunConfig) {
    this.scheduler = new Scheduler();
  }

  on(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private emit(event: BenchmarkEvent): void {
    for (const h of this.handlers) {
      h(event);
    }
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

  private emitProgress(currentOp: string): void {
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
        elo: {
          initial: computeEloFromJudgments(this.initialJudgments, sampleToModel),
          revised: computeEloFromJudgments(this.revisedJudgments, revisedSampleToModel),
          feedback: computeFeedbackEloFromImprovements(this.improvementJudgments, sampleToFeedbackModel),
        },
        totalCost: this.totalCost,
        totalCostUncached: this.totalCostUncached,
        costByModel: { ...this.costByModel },
        costByStage: { ...this.costByStage },
        costByModelByStage: structuredClone(this.costByModelByStage),
        speedByModel: this.computeSpeedByModel(),
        speedByModelByStage: this.computeSpeedByModelByStage(),
      },
    });
  }

  /**
   * Run the full benchmark pipeline reactively.
   */
  async run(): Promise<RunResult> {
    const startTime = Date.now();

    // Fetch model metadata
    this.modelInfoMap = await getModelInfoMap(
      this.config.models.map((m) => ({
        provider: m.provider,
        model: m.model,
        label: m.label,
      }))
    );

    // Pre-calculate total operations for progress tracking
    this.opsTotal = this.estimateTotalOps();

    // Kick off all initial writing tasks — everything else is triggered reactively
    const writePromises = this.startAllWrites();

    // Wait for the scheduler to drain (all reactive tasks complete)
    await Promise.all(writePromises);
    await this.scheduler.drain();

    // Compute final ELO
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

    const durationMs = Date.now() - startTime;

    const result: RunResult = {
      config: this.config,
      samples: [...this.initialSamples, ...this.revisedSamples],
      feedback: this.allFeedback,
      judgments: [
        ...this.initialJudgments,
        ...this.revisedJudgments,
        ...this.improvementJudgments,
      ],
      elo: {
        initial: { stage: "initial", ratings: initialElo },
        revised: {
          stage: "revised",
          ratings: revisedElo,
          feedbackRatings: feedbackElo,
        },
      },
      meta: {
        totalTokens: this.totalTokens,
        totalCost: this.totalCost,
        totalCostUncached: this.totalCostUncached,
        costByModel: { ...this.costByModel },
        costByStage: { ...this.costByStage },
        speedByModel: this.computeSpeedByModel(),
        durationMs,
      },
      modelInfo: this.modelInfoMap,
    };

    this.emit({ type: "complete", data: result });
    return result;
  }

  private estimateTotalOps(): number {
    const { models, prompts, outputsPerModel } = this.config;
    const M = models.length;
    const P = prompts.length;
    const N = outputsPerModel;
    const samplesPerPrompt = M * N;

    const writes = M * P * N;
    const pairsPerPrompt = (samplesPerPrompt * (samplesPerPrompt - 1)) / 2;
    const initialJudgments = pairsPerPrompt * M * P;
    const feedback = writes * M;
    const revisions = writes * M;

    // Improvement: each revision judged vs its original by each judge
    const improvementJudgments = revisions * M;

    // Revised pairs: grouped by feedback source.
    // M feedback groups per prompt, each with M*N revisions (one per writer).
    // Pairs within each group: C(M*N, 2)
    // Total: M * C(M*N, 2) per prompt × M judges × P prompts
    const revisionsPerFbGroup = M * N;
    const pairsPerFbGroup =
      (revisionsPerFbGroup * (revisionsPerFbGroup - 1)) / 2;
    const revisedJudgments = M * pairsPerFbGroup * M * P;

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
    const { models, prompts, outputsPerModel } = this.config;
    const promises: Promise<void>[] = [];

    for (const modelCfg of models) {
      for (const prompt of prompts) {
        for (let i = 0; i < outputsPerModel; i++) {
          const p = this.scheduler.schedule(modelCfg.provider, async () => {
            this.beginStage("initialWriting");
            this.emitProgress(
              `${modelCfg.label} writing "${prompt.name}" (${i + 1}/${outputsPerModel})`
            );

            try {
              const sample = await this.generateSample(
                modelCfg,
                prompt,
                i,
                "initial"
              );

              // Store result
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
          });
          promises.push(p);
        }
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

      for (const judgeCfg of models) {
        const key = [sample.id, other.id].sort().join(":") + ":" + judgeCfg.label;
        if (this.scheduledInitialJudge.has(key)) continue;
        this.scheduledInitialJudge.add(key);

        this.scheduler.schedule(judgeCfg.provider, async () => {
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

            this.initialJudgments.push(judgment);
            this.opsDone++;
            this.emit({ type: "judgmentComplete", data: judgment });
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

      this.scheduler.schedule(fbModel.provider, async () => {
        this.beginStage("feedback");
        this.emitProgress(
          `${fbModel.label} reviewing ${sample.model}'s "${prompt.name}"`
        );

        try {
          const feedback = await this.generateFeedback(fbModel, prompt, sample);

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

    this.scheduler.schedule(writerCfg.provider, async () => {
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
        for (const judgeCfg of models) {
          const key = `imp:${sample.id}:${judgeCfg.label}`;
          if (this.scheduledImprovement.has(key)) continue;
          this.scheduledImprovement.add(key);

          this.scheduler.schedule(judgeCfg.provider, async () => {
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

              this.improvementJudgments.push(judgment);
              this.opsDone++;
              this.emit({ type: "judgmentComplete", data: judgment });
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

      for (const judgeCfg of models) {
        const key =
          [sample.id, other.id].sort().join(":") + ":" + judgeCfg.label;
        if (this.scheduledRevisedJudge.has(key)) continue;
        this.scheduledRevisedJudge.add(key);

        this.scheduler.schedule(judgeCfg.provider, async () => {
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

            this.revisedJudgments.push(judgment);
            this.opsDone++;
            this.emit({ type: "judgmentComplete", data: judgment });
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

    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: prompt.prompt,
      temperature: modelCfg.temperature ?? 0.7,
      maxOutputTokens: modelCfg.maxTokens,
    });

    const latencyMs = Date.now() - startTime;
    const usage = extractUsage(result.usage);
    const modelInfo = this.modelInfoMap[modelCfg.label] ?? null;
    const cost = calculateCost(modelInfo, usage);

    this.totalTokens += usage.inputTokens + usage.outputTokens;
    this.trackCost(modelCfg.label, stage, cost);
    this.trackSpeed(modelCfg.label, stage, latencyMs, usage.outputTokens);

    return {
      id: nanoid(),
      model: modelCfg.label,
      promptId: prompt.id,
      outputIndex,
      text: result.text,
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

    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: feedbackModelCfg.temperature ?? 0.3,
    });

    const latencyMs = Date.now() - startTime;
    const usage = extractUsage(result.usage);
    const modelInfo = this.modelInfoMap[feedbackModelCfg.label] ?? null;
    const cost = calculateCost(modelInfo, usage);

    this.totalTokens += usage.inputTokens + usage.outputTokens;
    this.trackCost(feedbackModelCfg.label, "feedback", cost);
    this.trackSpeed(feedbackModelCfg.label, "feedback", latencyMs, usage.outputTokens);

    return {
      id: nanoid(),
      sourceModel: feedbackModelCfg.label,
      targetSampleId: sample.id,
      text: result.text,
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

    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: writerCfg.temperature ?? 0.7,
      maxOutputTokens: writerCfg.maxTokens,
    });

    const latencyMs = Date.now() - startTime;
    const usage = extractUsage(result.usage);
    const modelInfo = this.modelInfoMap[writerCfg.label] ?? null;
    const cost = calculateCost(modelInfo, usage);

    this.totalTokens += usage.inputTokens + usage.outputTokens;
    this.trackCost(writerCfg.label, "revised", cost);
    this.trackSpeed(writerCfg.label, "revised", latencyMs, usage.outputTokens);

    return {
      id: nanoid(),
      model: writerCfg.label,
      promptId: prompt.id,
      outputIndex: original.outputIndex,
      text: result.text,
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
