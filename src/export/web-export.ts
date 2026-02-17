import { existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { RunResult, TokenUsage, ModelInfo } from "../types.js";
import { listRuns, loadRun } from "../storage/run-store.js";
import { loadCumulativeElo } from "../storage/elo-store.js";

// ── Uncached Cost Computation ─────────────────────────

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
 * Compute uncached costs grouped by (model, stageKey) from a run's raw
 * samples, feedback, and judgments. Uses modelInfo pricing to calculate
 * what each call would cost without any caching.
 */
function computeUncachedCosts(
  run: RunResult
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};

  function addCost(model: string, stage: string, usage: TokenUsage): void {
    const info = run.modelInfo?.[model];
    if (!info) return;
    const cost = uncachedCostForUsage(info, usage);
    const modelStages = result[model] ?? {};
    modelStages[stage] = (modelStages[stage] ?? 0) + cost;
    result[model] = modelStages;
  }

  for (const s of run.samples) {
    addCost(s.model, s.stage === "initial" ? "initial" : "revised", s.usage);
  }
  for (const f of run.feedback) {
    addCost(f.sourceModel, "feedback", f.usage);
  }
  for (const j of run.judgments) {
    const stage = j.stage === "initial" ? "initialJudging" : "revisedJudging";
    addCost(j.judgeModel, stage, j.usage);
  }

  return result;
}

/**
 * Sum a model-by-stage cost map into per-model totals and a grand total.
 */
function sumCosts(
  byModelByStage: Record<string, Record<string, number>>
): { byModel: Record<string, number>; total: number } {
  const byModel: Record<string, number> = {};
  let total = 0;
  for (const [model, stages] of Object.entries(byModelByStage)) {
    let modelTotal = 0;
    for (const cost of Object.values(stages)) {
      modelTotal += cost;
    }
    byModel[model] = modelTotal;
    total += modelTotal;
  }
  return { byModel, total };
}

/**
 * Compute total tokens (input + output) per model per stage from a
 * run's raw data. Includes all items regardless of cache status,
 * since usage is preserved from cache. Uses the same stage keys as
 * computeUncachedCosts().
 */
function computeTokensByModelByStage(
  run: RunResult
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};

  function add(model: string, stage: string, usage: TokenUsage): void {
    const tokens = usage.inputTokens + usage.outputTokens;
    const modelStages = result[model] ?? {};
    modelStages[stage] = (modelStages[stage] ?? 0) + tokens;
    result[model] = modelStages;
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

  return result;
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
    initial: Array<{ model: string; rating: number }>;
    revised: Array<{ model: string; rating: number }>;
  };
}

interface EloEntryWithCost {
  model: string;
  rating: number;
  matchCount: number;
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

// ── Export ─────────────────────────────────────────────

/**
 * Export all run data to the web viewer data directory.
 * Returns the number of runs exported.
 */
export async function exportForWeb(outDir: string): Promise<number> {
  const runsDir = join(outDir, "runs");

  // Ensure directories exist
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
  }
  if (!existsSync(runsDir)) {
    await mkdir(runsDir, { recursive: true });
  }

  const runIds = await listRuns();
  const indexEntries: RunIndexEntry[] = [];

  for (const id of runIds) {
    const run = await loadRun(id);

    // Compute uncached costs from raw data
    const uncachedByModelByStage = computeUncachedCosts(run);
    const { byModel: uncachedByModel, total: totalUncached } =
      sumCosts(uncachedByModelByStage);

    // Compute tokens from raw data (includes cached items)
    const tokensByModelByStage = computeTokensByModelByStage(run);
    const { byModel: tokensByModel, total: totalTokens } =
      sumCosts(tokensByModelByStage);

    // Enrich run data with computed values
    const enrichedRun = {
      ...run,
      meta: {
        ...run.meta,
        totalTokens,
        totalCostUncached: totalUncached,
        costByModelUncached: uncachedByModel,
        costByModelByStageUncached: uncachedByModelByStage,
        tokensByModel,
        tokensByModelByStage,
      },
    };

    // Write enriched run data
    await writeFile(
      join(runsDir, `${id}.json`),
      JSON.stringify(enrichedRun, null, 2)
    );

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
        })),
        revised: run.elo.revised.ratings.map((r) => ({
          model: r.model,
          rating: r.rating,
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
    r: { model: string; rating: number; matchCount: number }
  ): EloEntryWithCost {
    const costByStage = latestEntry?.costByModelByStage[r.model];
    const totalCost = latestEntry?.costByModel[r.model];
    const tokensByStage = latestEntry?.tokensByModelByStage[r.model];
    const totalTokens = latestEntry?.tokensByModel[r.model];
    return {
      model: r.model,
      rating: r.rating,
      matchCount: r.matchCount,
      ...(costByStage ? { costByStage } : {}),
      ...(totalCost != null ? { totalCost } : {}),
      ...(tokensByStage ? { tokensByStage } : {}),
      ...(totalTokens != null ? { totalTokens } : {}),
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
          ]
        )
      ),
    },
    eloHistory: cumElo.history.map((h) => ({
      runId: h.runId,
      timestamp: h.timestamp,
      ratings: h.snapshot,
    })),
  };

  await writeFile(
    join(outDir, "runs.json"),
    JSON.stringify(index, null, 2)
  );

  return runIds.length;
}
