import { readFile, readdir, rmdir } from "fs/promises";
import { dirname } from "path";

/** Safe readdir that returns [] if the directory doesn't exist. */
export async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Read a JSON file, returning null on any error. */
export async function safeReadJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Remove a directory if it is empty. When `stopAt` is provided,
 * also removes empty parent directories up to (but not including)
 * the stopAt boundary. This cleans up namespace dirs left behind
 * when nested model key dirs are emptied.
 */
export async function removeIfEmpty(dir: string, stopAt?: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) await rmdir(dir);
    else return;
  } catch {
    return; // dir doesn't exist or can't be read
  }
  // Walk up and clean empty parents until we hit the boundary
  if (!stopAt) return;
  let parent = dirname(dir);
  while (parent !== stopAt && parent.startsWith(stopAt)) {
    try {
      const entries = await readdir(parent);
      if (entries.length > 0) break;
      await rmdir(parent);
    } catch {
      break;
    }
    parent = dirname(parent);
  }
}
