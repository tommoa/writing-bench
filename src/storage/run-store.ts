import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import type { RunResult, EloRating } from "../types.js";
import { DEFAULT_CONVERGENCE } from "../types.js";

const DATA_DIR = join(process.cwd(), "data", "runs");

/**
 * Get the directory path for a run.
 */
function runDir(runId: string): string {
  return join(DATA_DIR, runId);
}

/**
 * Save a run result to disk.
 */
export async function saveRun(result: RunResult): Promise<string> {
  const dir = runDir(result.config.id);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const path = join(dir, "run.json");
  await writeFile(path, JSON.stringify(result, (_key, value) =>
    value === Infinity ? "__Infinity__" : value, 2));
  return path;
}

/**
 * Load a run result from disk.
 */
export async function loadRun(runId: string): Promise<RunResult> {
  const path = join(runDir(runId), "run.json");
  if (!existsSync(path)) {
    throw new Error(`Run not found: ${runId}`);
  }

  const raw = await readFile(path, "utf-8");
  const result = JSON.parse(raw, (_key, value) =>
    value === "__Infinity__" ? Infinity : value) as RunResult;

  // Migrate old RunConfig shape: flat ciThreshold/maxRounds → convergence object
  if (!result.config.convergence) {
    const legacy = result.config as unknown as Record<string, unknown>;
    result.config.convergence = {
      ...DEFAULT_CONVERGENCE,
      ...(legacy.ciThreshold != null && { ciThreshold: legacy.ciThreshold as number }),
      ...(legacy.maxRounds != null && { maxRounds: legacy.maxRounds as number }),
    };
  }

  return result;
}

/**
 * List all available run IDs, sorted newest first.
 */
export async function listRuns(): Promise<string[]> {
  if (!existsSync(DATA_DIR)) {
    return [];
  }

  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  return dirs;
}

/**
 * Load the most recent run.
 */
export async function loadLatestRun(): Promise<RunResult | null> {
  const runs = await listRuns();
  if (runs.length === 0) return null;
  return loadRun(runs[0]);
}

// ── Run Deletion ────────────────────────────────────

/**
 * Delete a run's data directory from disk.
 */
export async function deleteRun(runId: string): Promise<void> {
  const dir = runDir(runId);
  if (!existsSync(dir)) {
    throw new Error(`Run not found: ${runId}`);
  }
  await rm(dir, { recursive: true });
}

/**
 * Delete a run and rebuild all derived data (cumulative ELO, web export).
 * Orchestrates the full deletion pipeline so callers cannot forget a step.
 */
export async function deleteRunFull(
  runId: string,
  onProgress?: (step: string) => void,
): Promise<void> {
  // Lazy imports to avoid circular dependency at module load time.
  // elo-store and web-export are leaf modules that import from run-store
  // for listing/loading, but deleteRunFull is only called at runtime
  // after all modules are loaded.
  const { rebuildCumulativeElo } = await import("./elo-store.js");
  const { removeRunFromExport } = await import("../export/web-export.js");

  onProgress?.("Deleting run data...");
  await deleteRun(runId);

  onProgress?.("Rebuilding cumulative ELO...");
  await rebuildCumulativeElo((id, index, total) => {
    onProgress?.(`Rebuilding ELO... (${index + 1}/${total}) ${id}`);
  });

  onProgress?.("Updating web export...");
  await removeRunFromExport(runId);

  onProgress?.("Done.");
}

// ── Run Summaries ───────────────────────────────────

/** Lightweight metadata for displaying a run in a list. */
export interface RunSummary {
  id: string;
  timestamp: string;
  models: string[];
  promptCount: number;
  totalCost: number;
  durationMs: number;
  initialRatings: EloRating[];
  revisedRatings: EloRating[];
}

/**
 * Extract a lightweight summary from a full RunResult.
 */
function summarizeRun(run: RunResult): RunSummary {
  return {
    id: run.config.id,
    timestamp: run.config.timestamp,
    models: run.config.models.map((m) => m.label),
    promptCount: run.config.prompts.length,
    totalCost: run.meta.totalCost,
    durationMs: run.meta.durationMs,
    initialRatings: run.elo.initial.ratings,
    revisedRatings: run.elo.revised.ratings,
  };
}

/**
 * Load a lightweight summary for a single run.
 */
export async function loadRunSummary(runId: string): Promise<RunSummary> {
  const run = await loadRun(runId);
  return summarizeRun(run);
}

/**
 * Load lightweight summaries for all runs, sorted newest first.
 */
export async function listRunSummaries(): Promise<RunSummary[]> {
  const ids = await listRuns();
  const summaries: RunSummary[] = [];
  for (const id of ids) {
    try {
      summaries.push(await loadRunSummary(id));
    } catch {
      // Skip unloadable runs
    }
  }
  return summaries;
}
