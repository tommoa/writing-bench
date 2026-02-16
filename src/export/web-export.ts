import { existsSync } from "fs";
import { writeFile, mkdir, cp } from "fs/promises";
import { join } from "path";
import { listRuns, loadRun } from "../storage/run-store.js";
import { loadCumulativeElo } from "../storage/elo-store.js";

interface RunIndexEntry {
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

interface RunsIndex {
  runs: RunIndexEntry[];
  cumulativeElo: {
    writing: Array<{ model: string; rating: number; matchCount: number }>;
    feedback: Array<{ model: string; rating: number; matchCount: number }>;
    byCategory: Record<
      string,
      Array<{ model: string; rating: number; matchCount: number }>
    >;
  };
  eloHistory: Array<{
    runId: string;
    timestamp: string;
    ratings: Record<string, number>;
  }>;
}

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

    // Copy full run data
    await writeFile(
      join(runsDir, `${id}.json`),
      JSON.stringify(run, null, 2)
    );

    // Build index entry
    indexEntries.push({
      id: run.config.id,
      timestamp: run.config.timestamp,
      models: run.config.models.map((m) => m.label),
      promptCount: run.config.prompts.length,
      outputsPerModel: run.config.outputsPerModel,
      totalCost: run.meta.totalCost,
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

  // Build cumulative ELO data
  const cumElo = await loadCumulativeElo();

  const index: RunsIndex = {
    runs: indexEntries,
    cumulativeElo: {
      writing: Object.values(cumElo.writing)
        .sort((a, b) => b.rating - a.rating)
        .map((r) => ({
          model: r.model,
          rating: r.rating,
          matchCount: r.matchCount,
        })),
      feedback: Object.values(cumElo.feedbackGiving)
        .sort((a, b) => b.rating - a.rating)
        .map((r) => ({
          model: r.model,
          rating: r.rating,
          matchCount: r.matchCount,
        })),
      byCategory: Object.fromEntries(
        Object.entries(cumElo.writingByCategory ?? {}).map(
          ([cat, ratings]) => [
            cat,
            Object.values(ratings)
              .sort((a, b) => b.rating - a.rating)
              .map((r) => ({
                model: r.model,
                rating: r.rating,
                matchCount: r.matchCount,
              })),
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
