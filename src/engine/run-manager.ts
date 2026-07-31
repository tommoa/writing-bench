import { join } from "path";
import { loadPrompts, parseModelConfigs, mergeModelEndpoints, createRunConfig, filterPrompts, resolveModelLabels } from "../config.js";
import { BenchmarkRunner } from "./runner.js";
import { saveRun } from "../storage/run-store.js";
import { updateCumulativeElo } from "../storage/elo-store.js";
import { specFromModelKey, discoverModelKeys } from "../storage/sample-cache.js";
import { parseModelSpec } from "../providers/registry.js";
import { checkProviderEnv } from "../providers/models.js";
import type { BenchmarkEvent, ModelConfig, PromptConfig, RunResult, TuiRunConfig } from "../types.js";
import { JUDGE_PRESETS } from "../types.js";

// ── Errors ──────────────────────────────────────────

export class RunValidationError extends Error {
  constructor(public warnings: string[]) {
    super(warnings.join("; "));
    this.name = "RunValidationError";
  }
}

// ── Shared Helpers ──────────────────────────────────

/** Discover model specs from the cache writes directory. */
export async function discoverModelsFromCache(): Promise<string[]> {
  const keys = await discoverModelKeys(join(process.cwd(), "data", "cache", "writes"));
  return keys.map(specFromModelKey).filter((s): s is string => s !== null);
}

/** Load prompts from a glob, optionally filter. Throws if none match. */
export async function loadAndFilterPrompts(
  glob: string,
  filter?: string[],
): Promise<PromptConfig[]> {
  let prompts = await loadPrompts(glob);
  if (filter && filter.length > 0) {
    const before = prompts.length;
    prompts = filterPrompts(prompts, filter);
    if (prompts.length === 0) {
      throw new RunValidationError([`No prompts matched filter: ${filter.join(", ")}`]);
    }
  }
  return prompts;
}

// ── Run Input Resolution ────────────────────────────

export interface ResolvedRunInputs {
  models: ModelConfig[];
  judges: ModelConfig[] | undefined;
  prompts: PromptConfig[];
}

/**
 * Resolve model specs, labels, and prompts from a TUI config.
 * Shared by executeRun() and the dry-run path.
 */
export async function resolveRunInputs(
  tuiConfig: TuiRunConfig,
): Promise<ResolvedRunInputs> {
  // 1. Auto-discover models in cache-only mode if none specified
  let modelSpecs = tuiConfig.models;
  if (tuiConfig.cacheOnly && modelSpecs.length === 0) {
    modelSpecs = await discoverModelsFromCache();
    if (modelSpecs.length === 0) {
      throw new RunValidationError(["No cached model data found. Nothing to analyze."]);
    }
  }

  // 2. Parse model configs
  let models = parseModelConfigs(modelSpecs);
  let judges = tuiConfig.judges.length
    ? parseModelConfigs(tuiConfig.judges)
    : undefined;

  // 3. Merge aliased endpoints (via ~)
  models = mergeModelEndpoints(models);
  if (judges) judges = mergeModelEndpoints(judges);

  // 4. Resolve display labels from models.dev
  try {
    // Resolve both roles together so display labels are unique across the
    // complete run even though canonical registry IDs drive internal work.
    await resolveModelLabels([...models, ...(judges ?? [])]);
  } catch (err) {
    if (!tuiConfig.cacheOnly) throw err;
    // In cache-only mode, silently fall back to raw model IDs
  }

  // 5. Load and filter prompts
  const prompts = await loadAndFilterPrompts(
    tuiConfig.prompts,
    tuiConfig.filter.length > 0 ? tuiConfig.filter : undefined,
  );

  return { models, judges, prompts };
}

// ── Run Execution ───────────────────────────────────

export interface RunCallbacks {
  onEvent: (event: BenchmarkEvent) => void;
  /** Called with non-fatal warnings (e.g. missing env vars). */
  onWarning?: (message: string) => void;
}

export interface ExecuteRunResult {
  result: RunResult;
  savePath: string;
}

/**
 * Build a RunConfig from TUI form values, create a runner, and execute.
 * Returns the RunResult and save path on success.
 * Throws RunValidationError on validation failure, or other errors on fatal failure.
 */
export async function executeRun(
  tuiConfig: TuiRunConfig,
  callbacks: RunCallbacks,
): Promise<ExecuteRunResult> {
  const { models, judges, prompts } = await resolveRunInputs(tuiConfig);

  // 6. Check provider env vars (skip in cache-only mode)
  if (!tuiConfig.cacheOnly) {
    const apiProviders = new Set<string>();
    for (const m of [...models, ...(judges ?? [])]) {
      if (m.apiModelIds?.length) {
        for (const apiId of m.apiModelIds) {
          apiProviders.add(parseModelSpec(apiId).provider);
        }
      } else {
        apiProviders.add(m.provider);
      }
    }
    const envWarnings = await checkProviderEnv([...apiProviders]);
    for (const warn of envWarnings) {
      callbacks.onWarning?.(`Warning: ${warn}`);
    }
  }

  // 7. Resolve judge sensitivity preset
  const judgePreset = JUDGE_PRESETS[tuiConfig.judgeSensitivity];

  // 8. Build RunConfig
  const config = createRunConfig({
    models,
    judges,
    prompts,
    outputsPerModel: tuiConfig.outputs,
    reasoning: tuiConfig.reasoning,
    noCache: tuiConfig.noCache,
    cacheOnly: tuiConfig.cacheOnly,
    skipSeeding: tuiConfig.skipSeeding,
    concurrency: tuiConfig.concurrency,
    convergence: {
      ciThreshold: tuiConfig.confidence,
      maxRounds: tuiConfig.maxRounds,
      writingWeight: tuiConfig.writingWeight,
      feedbackWeight: tuiConfig.feedbackWeight,
      revisedWeight: tuiConfig.revisedWeight,
      judgeQuality: tuiConfig.judgeQuality,
      judgeQualityMode: tuiConfig.judgeQualityMode,
      judgeDecay: tuiConfig.judgeDecay ?? judgePreset.judgeDecay,
      judgePruneThreshold: tuiConfig.judgePruneThreshold ?? judgePreset.judgePruneThreshold,
    },
  });

  // 9. Create runner and wire events
  const runner = new BenchmarkRunner(config);
  runner.on(callbacks.onEvent);

  // 10. Execute the benchmark
  const result = await runner.run();

  // 11. Save run and update cumulative ELO
  const savePath = await saveRun(result);
  await updateCumulativeElo(result);

  return { result, savePath };
}
