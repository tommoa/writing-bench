import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import type { RunResult } from "../types.js";

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
  return JSON.parse(raw, (_key, value) =>
    value === "__Infinity__" ? Infinity : value) as RunResult;
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
