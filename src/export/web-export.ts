import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { RunResult, TokenUsage, ModelInfo, EloRating, JudgeQualityExport, PairwiseJudgment } from "../types.js";
import { DEFAULT_CONVERGENCE } from "../types.js";
import { listRuns, loadRun } from "../storage/run-store.js";
import { loadCumulativeElo } from "../storage/elo-store.js";
import { computeJudgeQuality } from "../engine/judge-quality.js";
import type { JudgeQualityData } from "../engine/judge-quality.js";
import { computeJudgeBias } from "../engine/judge-bias.js";
import { judgmentsToGames, improvementJudgmentsToGames, whrRatings } from "../engine/whr.js";

// ── Per-model per-stage aggregation ───────────────────

/**
 * Compute uncached cost for a single API call from token usage and model
 * pricing. Treats all input tokens at the full rate (no prompt cache
 * discount), matching the `totalUncached` semantics in calculateCost().
 */
function uncachedCostForUsage(info: ModelInfo, usage: TokenUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * info.costPer1MInput +
    (usage.outputTokens / 1_000_000) * info.costPer1MOutput
  );
}

/**
 * Single pass over a run's samples, feedback, and judgments to compute
 * both uncached costs and total tokens grouped by (model, stageKey).
 */
function computeCostsAndTokens(run: RunResult): {
  costs: Record<string, Record<string, number>>;
  tokens: Record<string, Record<string, number>>;
} {
  const costs: Record<string, Record<string, number>> = {};
  const tokens: Record<string, Record<string, number>> = {};

  function add(model: string, stage: string, usage: TokenUsage): void {
    const info = run.modelInfo?.[model];
    if (info) {
      const c = (costs[model] ??= {});
      c[stage] = (c[stage] ?? 0) + uncachedCostForUsage(info, usage);
    }
    const tk = (tokens[model] ??= {});
    tk[stage] = (tk[stage] ?? 0) + usage.inputTokens + usage.outputTokens;
  }

  for (const s of run.samples) {
    add(s.model, s.stage === "initial" ? "initial" : "revised", s.usage);
  }
  for (const f of run.feedback) {
    add(f.sourceModel, "feedback", f.usage);
  }
  for (const j of run.judgments) {
    const stage = j.stage === "initial" ? "initialJudging" : "revisedJudging";
    add(j.judgeModel, stage, j.usage);
  }

  return { costs, tokens };
}

/**
 * Sum a model-by-stage map into per-model totals and a grand total.
 */
function sumValues(
  byModelByStage: Record<string, Record<string, number>>,
): { byModel: Record<string, number>; total: number } {
  const byModel: Record<string, number> = {};
  let total = 0;
  for (const [model, stages] of Object.entries(byModelByStage)) {
    let modelTotal = 0;
    for (const v of Object.values(stages)) {
      modelTotal += v;
    }
    byModel[model] = modelTotal;
    total += modelTotal;
  }
  return { byModel, total };
}

// ── Alternative Ratings Type ─────────────────────────

interface AlternativeRatingsExport {
  equalWeight: { initial: EloRating[]; revised: EloRating[]; feedback: EloRating[] };
  noBiasCorrection: { initial: EloRating[]; revised: EloRating[]; feedback: EloRating[] };
}

// ── Judge Quality + Alternative Ratings ──────────────

/**
 * Build sample-to-model lookup maps from a run's samples.
 */
function buildSampleMaps(samples: RunResult["samples"]): {
  sampleToModel: Map<string, string>;
  revisedSampleToModel: Map<string, string>;
  sampleToFeedbackModel: Map<string, string>;
} {
  const sampleToModel = new Map<string, string>();
  const revisedSampleToModel = new Map<string, string>();
  const sampleToFeedbackModel = new Map<string, string>();

  for (const s of samples) {
    if (s.stage === "initial") {
      sampleToModel.set(s.id, s.model);
    } else {
      revisedSampleToModel.set(s.id, s.model);
      if (s.feedbackModel) {
        sampleToFeedbackModel.set(s.id, s.feedbackModel);
      }
    }
  }

  return { sampleToModel, revisedSampleToModel, sampleToFeedbackModel };
}

/**
 * Compute judge quality data for a set of judgments.
 * Returns serialized JudgeQualityExport entries ready for JSON.
 * Accepts optional pre-computed quality to avoid redundant computation.
 */
function computeJudgeQualityForExport(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
  pruneThreshold: number,
  precomputedQuality?: JudgeQualityData,
): JudgeQualityExport[] {
  const judgeLabels = [...new Set(judgments.map((j) => j.judgeModel))];
  if (judgeLabels.length < 2) return [];

  const quality = precomputedQuality ?? computeJudgeQuality(
    judgments, judgeLabels, DEFAULT_CONVERGENCE.judgeDecay,
  );
  if (!quality.active || quality.ratings.length === 0) return [];

  // Compute bias stats (caller passes combined initial + revised sampleToModel)
  const biasData = computeJudgeBias(judgments, sampleToModel, judgeLabels);

  return quality.ratings.map((r) => {
    const weight = quality.weights.get(r.model) ?? 1.0;
    const selfPref = biasData.selfPreference.get(r.model);
    const posBias = biasData.positionBias.get(r.model);

    return {
      model: r.model,
      rating: r.rating,
      ci95: r.ci95 ?? Infinity,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      weight,
      selfBias: selfPref?.sufficient ? selfPref.biasDelta : null,
      positionBias: posBias?.sufficient ? posBias.positionBiasDelta : null,
      selfBiasSufficient: selfPref?.sufficient ?? false,
      positionBiasSufficient: posBias?.sufficient ?? false,
      status: weight < pruneThreshold ? "pruned" as const : "active" as const,
    };
  });
}

/**
 * Compute alternative rating sets (equal weight, no bias correction)
 * for a run's judgments. Returns undefined if there are too few judgments
 * or too few judges to produce meaningful alternatives.
 */
function computeAlternativeRatings(
  judgments: PairwiseJudgment[],
  sampleToModel: Map<string, string>,
  revisedSampleToModel: Map<string, string>,
  sampleToFeedbackModel: Map<string, string>,
  precomputedJw?: Map<string, number>,
): AlternativeRatingsExport | undefined {
  const judgeLabels = [...new Set(judgments.map((j) => j.judgeModel))];
  if (judgeLabels.length < 2) return undefined;

  // Use pre-computed judge weights if provided, otherwise compute
  let jw = precomputedJw;
  if (!jw) {
    const k = DEFAULT_CONVERGENCE.judgeDecay;
    const quality = computeJudgeQuality(judgments, judgeLabels, k);
    jw = quality.active ? quality.weights : undefined;
  }

  // Split judgments by stage
  const initialJudgments = judgments.filter((j) => j.stage === "initial");
  const revisedJudgments = judgments.filter((j) => j.stage === "revised");
  const improvementJudgments = judgments.filter((j) => j.stage === "improvement");

  // Equal weight: no judge weights, no bias corrections (all games weight 1.0)
  const equalWeight = {
    initial: whrRatings(judgmentsToGames(initialJudgments, sampleToModel)),
    revised: whrRatings(judgmentsToGames(revisedJudgments, revisedSampleToModel)),
    feedback: whrRatings(improvementJudgmentsToGames(improvementJudgments, sampleToFeedbackModel)),
  };

  // No bias correction: use judge quality weights but skip per-judgment bias corrections
  const noBiasCorrection = {
    initial: whrRatings(judgmentsToGames(initialJudgments, sampleToModel, jw)),
    revised: whrRatings(judgmentsToGames(revisedJudgments, revisedSampleToModel, jw)),
    feedback: whrRatings(improvementJudgmentsToGames(improvementJudgments, sampleToFeedbackModel, jw)),
  };

  return { equalWeight, noBiasCorrection };
}

// ── Gzip helper ──────────────────────────────────────

async function writeGzipped(path: string, data: string): Promise<void> {
  await Promise.all([
    writeFile(path, data),
    writeFile(path + ".gz", Bun.gzipSync(data)),
  ]);
}

// ── Index Types ───────────────────────────────────────

interface RunIndexEntry {
  id: string;
  timestamp: string;
  models: string[];
  promptCount: number;
  outputsPerModel: number;
  totalCost: number;
  totalCostUncached: number;
  costByModel: Record<string, number>;
  costByModelByStage: Record<string, Record<string, number>>;
  tokensByModel: Record<string, number>;
  tokensByModelByStage: Record<string, Record<string, number>>;
  totalTokens: number;
  durationMs: number;
  elo: {
    initial: Array<{ model: string; rating: number; ci95?: number }>;
    revised: Array<{ model: string; rating: number; ci95?: number }>;
  };
}

interface EloEntryWithCost {
  model: string;
  rating: number;
  matchCount: number;
  ci95?: number;
  costByStage?: Record<string, number>;
  totalCost?: number;
  tokensByStage?: Record<string, number>;
  totalTokens?: number;
}

interface RunsIndex {
  runs: RunIndexEntry[];
  cumulativeElo: {
    writing: EloEntryWithCost[];
    feedback: EloEntryWithCost[];
    byTag: Record<string, EloEntryWithCost[]>;
  };
  eloHistory: Array<{
    runId: string;
    timestamp: string;
    ratings: Record<string, number>;
  }>;
  cumulativeJudgeQuality?: JudgeQualityExport[];
  cumulativeAlternativeRatings?: AlternativeRatingsExport;
}

// ── Manifest & Content Types ─────────────────────────

interface SampleMeta {
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

interface FeedbackMeta {
  id: string;
  sourceModel: string;
  targetSampleId: string;
  fromCache?: boolean;
}

interface JudgmentMeta {
  judgeModel: string;
  promptId: string;
  sampleA: string;
  sampleB: string;
  winner: "A" | "B" | "tie";
  stage: "initial" | "revised" | "improvement";
  positionSwapped?: boolean;
}

// ── Export ─────────────────────────────────────────────

/**
 * Export all run data to the web viewer data directory.
 * Returns the number of runs exported.
 *
 * Generates a tiered file structure:
 *   data/runs/{id}.json              -- manifest (lean structural data)
 *   data/runs/{id}/prompt-{pid}.json -- per-prompt text content
 *
 * All JSON files are also pre-compressed as .json.gz for gzip serving.
 */
export async function exportForWeb(outDir: string): Promise<number> {
  const runsDir = join(outDir, "runs");

  // Ensure directories exist
  await mkdir(runsDir, { recursive: true });

  const runIds = await listRuns();
  const indexEntries: RunIndexEntry[] = [];

  // Accumulate data for cumulative computations during the per-run loop
  // to avoid re-loading all runs a second time.
  const allJudgments: PairwiseJudgment[] = [];
  const allSampleToModel = new Map<string, string>();
  const allRevisedSampleToModel = new Map<string, string>();
  const allSampleToFeedbackModel = new Map<string, string>();
  const promptToTags = new Map<string, string[]>();

  for (const id of runIds) {
    const run = await loadRun(id);

    // Compute uncached costs and tokens in a single pass
    const { costs: uncachedByModelByStage, tokens: tokensByModelByStage } =
      computeCostsAndTokens(run);
    const { byModel: uncachedByModel, total: totalUncached } =
      sumValues(uncachedByModelByStage);
    const { byModel: tokensByModel, total: totalTokens } =
      sumValues(tokensByModelByStage);

    // Enriched meta for the manifest
    const enrichedMeta = {
      ...run.meta,
      totalTokens,
      totalCostUncached: totalUncached,
      costByModelUncached: uncachedByModel,
      costByModelByStageUncached: uncachedByModelByStage,
      tokensByModel,
      tokensByModelByStage,
    };

    // ── Sort judgments by promptId for contiguous slicing ──

    const sortedJudgments = [...run.judgments].sort((a, b) =>
      a.promptId < b.promptId ? -1 : a.promptId > b.promptId ? 1 : 0,
    );

    // Compute per-prompt judgment slices via single pass (judgments
    // are already sorted by promptId, so each prompt's block is
    // contiguous). Prompts iterated in the same sort order.
    const promptJudgmentSlices: Record<string, { start: number; count: number }> = {};
    const promptsByIdOrder = [...run.config.prompts].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    let cursor = 0;
    for (const prompt of promptsByIdOrder) {
      let count = 0;
      while (
        cursor + count < sortedJudgments.length &&
        sortedJudgments[cursor + count].promptId === prompt.id
      ) count++;
      promptJudgmentSlices[prompt.id] = { start: cursor, count };
      cursor += count;
    }

    // ── Compute judge quality + alternative ratings ──

    const { sampleToModel, revisedSampleToModel, sampleToFeedbackModel } =
      buildSampleMaps(run.samples);

    // Combined map for bias computation (needs both initial + revised)
    const combinedSampleToModel = new Map([...sampleToModel, ...revisedSampleToModel]);

    // Compute judge quality once -- reuse for both export and alternative ratings
    const perRunJudgeLabels = [...new Set(run.judgments.map((j) => j.judgeModel))];
    const perRunQuality = perRunJudgeLabels.length >= 2
      ? computeJudgeQuality(run.judgments, perRunJudgeLabels, DEFAULT_CONVERGENCE.judgeDecay)
      : null;
    const perRunJw = perRunQuality?.active ? perRunQuality.weights : undefined;

    const judgeQuality = computeJudgeQualityForExport(
      run.judgments, combinedSampleToModel, DEFAULT_CONVERGENCE.judgePruneThreshold,
      perRunQuality ?? undefined,
    );

    const alternativeRatings = computeAlternativeRatings(
      run.judgments, sampleToModel, revisedSampleToModel, sampleToFeedbackModel, perRunJw,
    );

    // Accumulate for cumulative computations
    allJudgments.push(...run.judgments);
    for (const [k, v] of sampleToModel) allSampleToModel.set(k, v);
    for (const [k, v] of revisedSampleToModel) allRevisedSampleToModel.set(k, v);
    for (const [k, v] of sampleToFeedbackModel) allSampleToFeedbackModel.set(k, v);
    for (const p of run.config.prompts) promptToTags.set(p.id, p.tags);

    // ── Write manifest (Tier 1) ──

    const manifest = {
      config: run.config,
      elo: run.elo,
      meta: enrichedMeta,
      modelInfo: run.modelInfo,
      judgeQuality: judgeQuality.length > 0 ? judgeQuality : undefined,
      alternativeRatings,
      samples: run.samples.map((s): SampleMeta => ({
        id: s.id,
        model: s.model,
        promptId: s.promptId,
        outputIndex: s.outputIndex,
        stage: s.stage,
        originalSampleId: s.originalSampleId,
        feedbackUsed: s.feedbackUsed,
        feedbackModel: s.feedbackModel,
        fromCache: s.fromCache,
      })),
      feedback: run.feedback.map((f): FeedbackMeta => ({
        id: f.id,
        sourceModel: f.sourceModel,
        targetSampleId: f.targetSampleId,
        fromCache: f.fromCache,
      })),
      judgments: sortedJudgments.map((j): JudgmentMeta => ({
        judgeModel: j.judgeModel,
        promptId: j.promptId,
        sampleA: j.sampleA,
        sampleB: j.sampleB,
        winner: j.winner,
        stage: j.stage,
        positionSwapped: j.positionSwapped,
      })),
      promptJudgmentSlices,
    };

    await writeGzipped(
      join(runsDir, `${id}.json`),
      JSON.stringify(manifest),
    );

    // ── Write per-prompt content files (Tier 2) ──

    const promptDir = join(runsDir, id);
    await mkdir(promptDir, { recursive: true });

    await Promise.all(run.config.prompts.map((prompt) => {
      const promptSamples = run.samples.filter((s) => s.promptId === prompt.id);
      const sampleIds = new Set(promptSamples.map((s) => s.id));
      const promptFeedback = run.feedback.filter((f) =>
        sampleIds.has(f.targetSampleId),
      );
      const slice = promptJudgmentSlices[prompt.id];
      const promptJudgments = sortedJudgments.slice(slice.start, slice.start + slice.count);

      const content = {
        samples: Object.fromEntries(promptSamples.map((s) => [s.id, {
          text: s.text,
          usage: s.usage,
          cost: s.cost,
          latencyMs: s.latencyMs,
        }])),
        feedback: Object.fromEntries(promptFeedback.map((f) => [f.id, {
          text: f.text,
          usage: f.usage,
          cost: f.cost,
          latencyMs: f.latencyMs,
        }])),
        reasoning: promptJudgments.map((j) => j.reasoning),
      };

      return writeGzipped(
        join(promptDir, `prompt-${prompt.id}.json`),
        JSON.stringify(content),
      );
    }));

    // Build index entry
    indexEntries.push({
      id: run.config.id,
      timestamp: run.config.timestamp,
      models: run.config.models.map((m) => m.label),
      promptCount: run.config.prompts.length,
      outputsPerModel: run.config.outputsPerModel,
      totalCost: run.meta.totalCost,
      totalCostUncached: totalUncached,
      costByModel: uncachedByModel,
      costByModelByStage: uncachedByModelByStage,
      tokensByModel,
      tokensByModelByStage,
      totalTokens,
      durationMs: run.meta.durationMs,
      elo: {
        initial: run.elo.initial.ratings.map((r) => ({
          model: r.model,
          rating: r.rating,
          ci95: r.ci95,
        })),
        revised: run.elo.revised.ratings.map((r) => ({
          model: r.model,
          rating: r.rating,
          ci95: r.ci95,
        })),
      },
    });
  }

  // Find latest run's costs for dashboard ELO enrichment
  const latestEntry = indexEntries.length > 0
    ? indexEntries.reduce((a, b) => (a.timestamp > b.timestamp ? a : b))
    : null;

  // Build cumulative ELO data
  const cumElo = await loadCumulativeElo();

  function enrichEloEntry(
    r: { model: string; rating: number; matchCount: number; ci95?: number },
  ): EloEntryWithCost {
    const costByStage = latestEntry?.costByModelByStage[r.model];
    const totalCost = latestEntry?.costByModel[r.model];
    const tokensByStage = latestEntry?.tokensByModelByStage[r.model];
    const totalTokens = latestEntry?.tokensByModel[r.model];
    return {
      model: r.model,
      rating: r.rating,
      matchCount: r.matchCount,
      ci95: r.ci95,
      costByStage,
      totalCost,
      tokensByStage,
      totalTokens,
    };
  }

  // ── Cumulative computations (data already collected in per-run loop) ──

  let cumulativeJudgeQuality: JudgeQualityExport[] | undefined;
  let cumulativeAlternativeRatings: AlternativeRatingsExport | undefined;

  if (allJudgments.length > 0) {
    const combinedSampleToModel = new Map([...allSampleToModel, ...allRevisedSampleToModel]);

    // Compute judge quality once -- reuse weights for alternatives + per-tag
    const judgeLabels = [...new Set(allJudgments.map((j) => j.judgeModel))];
    const k = DEFAULT_CONVERGENCE.judgeDecay;
    const quality = judgeLabels.length >= 2
      ? computeJudgeQuality(allJudgments, judgeLabels, k)
      : null;
    const jw = quality?.active ? quality.weights : undefined;

    cumulativeJudgeQuality = computeJudgeQualityForExport(
      allJudgments, combinedSampleToModel, DEFAULT_CONVERGENCE.judgePruneThreshold,
      quality ?? undefined,
    );
    if (cumulativeJudgeQuality.length === 0) cumulativeJudgeQuality = undefined;

    cumulativeAlternativeRatings = computeAlternativeRatings(
      allJudgments, allSampleToModel, allRevisedSampleToModel, allSampleToFeedbackModel, jw,
    );

    // ── Compute per-tag alternative ratings for dashboard ──
    // Written to a separate file to keep runs.json lean.

    const allTags = [...new Set([...promptToTags.values()].flat())];
    if (allTags.length > 0 && cumulativeAlternativeRatings) {
      const tagAlts: {
        equalWeight: Record<string, { initial: EloRating[]; revised: EloRating[] }>;
        noBiasCorrection: Record<string, { initial: EloRating[]; revised: EloRating[] }>;
      } = { equalWeight: {}, noBiasCorrection: {} };

      for (const tag of allTags) {
        // Filter to judgments whose prompt has this tag, excluding improvement
        const tagJudgments = allJudgments.filter((j) =>
          j.stage !== "improvement" && promptToTags.get(j.promptId)?.includes(tag),
        );
        if (tagJudgments.length === 0) continue;

        const initialJ = tagJudgments.filter((j) => j.stage === "initial");
        const revisedJ = tagJudgments.filter((j) => j.stage === "revised");

        // Equal weight: no judge weights
        tagAlts.equalWeight[tag] = {
          initial: initialJ.length > 0
            ? whrRatings(judgmentsToGames(initialJ, allSampleToModel))
            : [],
          revised: revisedJ.length > 0
            ? whrRatings(judgmentsToGames(revisedJ, allRevisedSampleToModel))
            : [],
        };

        // No bias correction: quality weights but no per-judgment bias corrections
        tagAlts.noBiasCorrection[tag] = {
          initial: initialJ.length > 0
            ? whrRatings(judgmentsToGames(initialJ, allSampleToModel, jw))
            : [],
          revised: revisedJ.length > 0
            ? whrRatings(judgmentsToGames(revisedJ, allRevisedSampleToModel, jw))
            : [],
        };
      }

      await writeGzipped(
        join(outDir, "tag-alternatives.json"),
        JSON.stringify(tagAlts),
      );
    }
  }

  const index: RunsIndex = {
    runs: indexEntries,
    cumulativeElo: {
      writing: Object.values(cumElo.writing)
        .sort((a, b) => b.rating - a.rating)
        .map(enrichEloEntry),
      feedback: Object.values(cumElo.feedbackGiving)
        .sort((a, b) => b.rating - a.rating)
        .map(enrichEloEntry),
      byTag: Object.fromEntries(
        Object.entries(cumElo.writingByTag ?? {}).map(
          ([cat, ratings]) => [
            cat,
            Object.values(ratings)
              .sort((a, b) => b.rating - a.rating)
              .map(enrichEloEntry),
          ],
        ),
      ),
    },
    eloHistory: cumElo.history.map((h) => ({
      runId: h.runId,
      timestamp: h.timestamp,
      ratings: h.snapshot,
    })),
    cumulativeJudgeQuality,
    cumulativeAlternativeRatings,
  };

  await writeGzipped(
    join(outDir, "runs.json"),
    JSON.stringify(index),
  );

  return runIds.length;
}
