import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { RunResult, TokenUsage, ModelInfo } from "../types.js";
import { listRuns, loadRun } from "../storage/run-store.js";
import { loadCumulativeElo } from "../storage/elo-store.js";

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
}

// ── Export ─────────────────────────────────────────────

/**
 * Export all run data to the web viewer data directory.
 * Returns the number of runs exported.
 *
 * Generates a tiered file structure:
 *   data/runs/{id}.json              — manifest (lean structural data)
 *   data/runs/{id}/prompt-{pid}.json — per-prompt text content
 *
 * All JSON files are also pre-compressed as .json.gz for gzip serving.
 */
export async function exportForWeb(outDir: string): Promise<number> {
  const runsDir = join(outDir, "runs");

  // Ensure directories exist
  await mkdir(runsDir, { recursive: true });

  const runIds = await listRuns();
  const indexEntries: RunIndexEntry[] = [];

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

    // ── Write manifest (Tier 1) ──

    const manifest = {
      config: run.config,
      elo: run.elo,
      meta: enrichedMeta,
      modelInfo: run.modelInfo,
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
  };

  await writeGzipped(
    join(outDir, "runs.json"),
    JSON.stringify(index),
  );

  return runIds.length;
}
