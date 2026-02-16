import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { ModelInfo, CostBreakdown, TokenUsage } from "../types.js";

const MODELS_API_URL = "https://models.dev/api.json";
const CACHE_FILE = join(process.cwd(), "data", "models-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ModelsDevModel {
  id: string;
  name: string;
  family: string;
  release_date?: string;
  open_weights?: boolean;
  cost?: {
    input: number; // per 1M tokens
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    output?: number;
    input?: number;
  };
}

interface ModelsDevProvider {
  id: string;
  name: string;
  api?: string; // Base URL for API calls
  env?: string[]; // Required environment variables
  npm?: string;
  models: Record<string, ModelsDevModel>;
}

type ModelsDb = Record<string, ModelsDevProvider>;

let cachedDb: ModelsDb | null = null;

/**
 * Fetch the models.dev database, using a local cache when available.
 */
export async function fetchModelsDb(): Promise<ModelsDb> {
  if (cachedDb) return cachedDb;

  // Try loading from cache
  if (existsSync(CACHE_FILE)) {
    try {
      const raw = await readFile(CACHE_FILE, "utf-8");
      const cached = JSON.parse(raw) as {
        timestamp: number;
        data: ModelsDb;
      };
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        cachedDb = cached.data;
        return cachedDb;
      }
    } catch {
      // Cache corrupted, will refetch
    }
  }

  // Fetch from API
  try {
    const response = await fetch(MODELS_API_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch models.dev: ${response.status}`);
    }
    const data = (await response.json()) as ModelsDb;
    cachedDb = data;

    // Write cache
    const dir = join(process.cwd(), "data");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(
      CACHE_FILE,
      JSON.stringify({ timestamp: Date.now(), data }, null, 2)
    );

    return data;
  } catch (error) {
    // If fetch fails and we have a stale cache, use it
    if (existsSync(CACHE_FILE)) {
      const raw = await readFile(CACHE_FILE, "utf-8");
      const cached = JSON.parse(raw) as {
        timestamp: number;
        data: ModelsDb;
      };
      cachedDb = cached.data;
      return cachedDb;
    }
    throw error;
  }
}

export interface ProviderMeta {
  name: string;
  api?: string;
  npm?: string;
}

/**
 * Look up provider metadata from the models.dev database.
 */
export async function getProviderMeta(
  providerId: string
): Promise<ProviderMeta | null> {
  const db = await fetchModelsDb();
  const p = db[providerId];
  if (!p) return null;
  return { name: p.name, api: p.api, npm: p.npm };
}

/**
 * Look up model metadata from the models.dev database.
 * Provider names are models.dev provider IDs (e.g., "google-vertex", "openai").
 */
export async function getModelInfo(
  provider: string,
  model: string
): Promise<ModelInfo | null> {
  const db = await fetchModelsDb();
  const providerData = db[provider];
  if (!providerData) return null;

  const modelData = providerData.models[model];
  if (!modelData) return null;

  return {
    name: modelData.name,
    family: modelData.family,
    releaseDate: modelData.release_date,
    openWeights: modelData.open_weights ?? false,
    contextLimit: modelData.limit?.context ?? 0,
    outputLimit: modelData.limit?.output ?? 0,
    costPer1MInput: modelData.cost?.input ?? 0,
    costPer1MOutput: modelData.cost?.output ?? 0,
    costPer1MCacheRead: modelData.cost?.cache_read,
    costPer1MCacheWrite: modelData.cost?.cache_write,
  };
}

/**
 * Check environment variables for providers used in a run against
 * models.dev env metadata. Returns warnings for any env vars that
 * are listed by models.dev but not set.
 *
 * These are warnings, not errors -- models.dev lists env vars the
 * provider *can* use, not ones that are all strictly required together
 * (e.g., GOOGLE_APPLICATION_CREDENTIALS is optional when using ADC).
 * The provider itself will give a clear error if auth actually fails.
 */
export async function checkProviderEnv(
  providers: string[]
): Promise<string[]> {
  const db = await fetchModelsDb();
  const warnings: string[] = [];
  const checked = new Set<string>();

  for (const provider of providers) {
    if (checked.has(provider)) continue;
    checked.add(provider);

    const providerData = db[provider];
    if (!providerData?.env) continue;

    const missing = providerData.env.filter(
      (envVar) => !process.env[envVar]
    );

    // Only warn if none of the env vars are set at all
    const anySet = providerData.env.some(
      (envVar) => process.env[envVar] != null
    );

    if (!anySet) {
      warnings.push(
        `Provider "${provider}" (${providerData.name}): none of ${providerData.env.join(", ")} are set`
      );
    } else if (missing.length > 0) {
      warnings.push(
        `Provider "${provider}" (${providerData.name}): ${missing.join(", ")} not set (may be optional)`
      );
    }
  }

  return warnings;
}

/**
 * Calculate the USD cost for a given API call based on token usage.
 *
 * Returns both the actual cost (accounting for cached token pricing)
 * and the uncached cost (as if every input token were full price).
 * This lets benchmark readers see what a model *would* cost without
 * caching luck skewing the numbers.
 */
export function calculateCost(
  modelInfo: ModelInfo | null,
  usage: TokenUsage
): CostBreakdown {
  if (!modelInfo) {
    return { input: 0, output: 0, total: 0, totalUncached: 0 };
  }

  const output = (usage.outputTokens / 1_000_000) * modelInfo.costPer1MOutput;

  // Uncached: all input tokens at full rate
  const uncachedInput =
    (usage.inputTokens / 1_000_000) * modelInfo.costPer1MInput;

  // Actual: subtract cached tokens charged at full rate, add them at cache rate
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const fullRateTokens = usage.inputTokens - cacheRead - cacheWrite;

  const cacheReadRate = modelInfo.costPer1MCacheRead ?? modelInfo.costPer1MInput;
  const cacheWriteRate =
    modelInfo.costPer1MCacheWrite ?? modelInfo.costPer1MInput;

  const actualInput =
    (fullRateTokens / 1_000_000) * modelInfo.costPer1MInput +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate;

  return {
    input: actualInput,
    output,
    total: actualInput + output,
    totalUncached: uncachedInput + output,
  };
}

/**
 * Fetch model info for all models in a run and return a lookup map.
 */
export async function getModelInfoMap(
  models: Array<{ provider: string; model: string; label: string }>
): Promise<Record<string, ModelInfo>> {
  const map: Record<string, ModelInfo> = {};

  for (const m of models) {
    const info = await getModelInfo(m.provider, m.model);
    if (info) {
      map[m.label] = info;
    }
  }

  return map;
}
