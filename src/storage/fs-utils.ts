import { readFile, readdir, rmdir } from "fs/promises";

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

/** Remove a directory if it is empty. */
export async function removeIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) await rmdir(dir);
  } catch {
    // Ignore errors (dir might not exist)
  }
}
