import { readFile } from "fs/promises";
import { basename } from "path";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";
import { Glob } from "bun";
import type { PromptConfig, ModelConfig, RunConfig, ConvergenceConfig } from "./types.js";
import { DEFAULT_CONVERGENCE, DEFAULT_CONCURRENCY } from "./types.js";
import { parseModelSpec } from "./providers/registry.js";
import { getModelDisplayName, getProviderDisplayName } from "./providers/models.js";

// ── Zod schemas for TOML prompt validation ──────────

const PromptTomlSchema = z.object({
  name: z.string(),
  tags: z.array(z.string()).min(1),
  description: z.string(),
  prompt: z.string(),
  judging_criteria: z.array(z.string()),
  feedback_prompt: z.string().optional(),
  revision_prompt: z.string().optional(),
  max_words: z.number().int().positive().optional(),
});

type PromptToml = z.infer<typeof PromptTomlSchema>;

// ── Prompt loading ──────────────────────────────────

/**
 * Load and validate a single TOML prompt file.
 */
async function loadPromptFile(path: string): Promise<PromptConfig> {
  const raw = await readFile(path, "utf-8");
  const parsed = parseTOML(raw);
  const validated = PromptTomlSchema.parse(parsed);

  const id = basename(path, ".toml");

  return {
    id,
    name: validated.name,
    tags: validated.tags,
    description: validated.description,
    prompt: validated.prompt,
    judgingCriteria: validated.judging_criteria,
    feedbackPrompt: validated.feedback_prompt,
    revisionPrompt: validated.revision_prompt,
    maxWords: validated.max_words,
  };
}

/**
 * Load all prompt files matching a glob pattern.
 */
export async function loadPrompts(pattern: string): Promise<PromptConfig[]> {
  const glob = new Glob(pattern);
  const paths: string[] = [];

  for await (const path of glob.scan({ absolute: true })) {
    paths.push(path);
  }

  if (paths.length === 0) {
    throw new Error(`No prompt files found matching pattern: ${pattern}`);
  }

  const prompts = await Promise.all(paths.map(loadPromptFile));
  return prompts.sort((a, b) => a.id.localeCompare(b.id));
}

// ── Model config parsing ────────────────────────────

/**
 * Return the model spec to pass to resolveModel() for API calls.
 * Uses the first aliased endpoint if available, otherwise the canonical registryId.
 */
export function apiModelId(cfg: ModelConfig): string {
  return cfg.apiModelIds?.[0] ?? cfg.registryId;
}

/**
 * Parse CLI model specs into ModelConfig objects.
 */
export function parseModelConfigs(specs: string[]): ModelConfig[] {
  return specs.map((spec) => {
    const { provider, model, label, registryId, apiModelIds } = parseModelSpec(spec);
    return {
      provider: provider as ModelConfig["provider"],
      model,
      label,
      registryId,
      apiModelIds,
    };
  });
}

/**
 * Merge ModelConfig entries that resolve to the same canonical registryId.
 * Collects all API endpoints into a single apiModelIds array.
 * Validates that conflicting explicit labels are not provided.
 */
export function mergeModelEndpoints(models: ModelConfig[]): ModelConfig[] {
  // Group by canonical registryId
  const groups = new Map<string, ModelConfig[]>();
  for (const m of models) {
    const group = groups.get(m.registryId) ?? [];
    group.push(m);
    groups.set(m.registryId, group);
  }

  const result: ModelConfig[] = [];
  for (const [registryId, group] of groups) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Validate labels: find the single explicit label (where label !== model)
    let explicitLabel: string | undefined;
    for (const m of group) {
      if (m.label !== m.model) {
        if (explicitLabel != null && explicitLabel !== m.label) {
          throw new Error(
            `Conflicting labels for ${registryId}: '${explicitLabel}' vs '${m.label}'. ` +
            `When aliasing multiple endpoints to the same model, use at most one =label.`
          );
        }
        explicitLabel = m.label;
      }
    }

    // Merge apiModelIds: collect all API endpoints
    const allApiIds: string[] = [];
    let hasCanonicalDirect = false;
    for (const m of group) {
      if (m.apiModelIds?.length) {
        allApiIds.push(...m.apiModelIds);
      } else {
        // This config IS the canonical spec (no ~alias), add registryId to pool
        hasCanonicalDirect = true;
      }
    }
    if (hasCanonicalDirect) {
      allApiIds.push(registryId);
    }

    // Use the first group entry as base, apply merged values
    const merged: ModelConfig = {
      provider: group[0].provider,
      model: group[0].model,
      registryId,
      label: explicitLabel ?? group[0].model,
      apiModelIds: allApiIds.length > 0 ? allApiIds : undefined,
    };

    result.push(merged);
  }

  return result;
}

/**
 * Resolve auto-generated labels to models.dev display names.
 * Explicit labels (user-provided via =label suffix) are preserved.
 * Collisions between different models sharing a display name are
 * disambiguated by appending the provider display name.
 */
export async function resolveModelLabels(
  models: ModelConfig[]
): Promise<void> {
  // Phase 1: Replace auto-labels (label === model) with display names
  for (const m of models) {
    if (m.label !== m.model) continue; // explicit label, keep it
    const displayName = await getModelDisplayName(m.provider, m.model);
    if (displayName) {
      m.label = displayName;
    }
  }

  // Phase 2: Disambiguate collisions
  const byLabel = new Map<string, ModelConfig[]>();
  for (const m of models) {
    const group = byLabel.get(m.label) ?? [];
    group.push(m);
    byLabel.set(m.label, group);
  }

  for (const [, group] of byLabel) {
    if (group.length <= 1) continue;
    // Same registryId sharing a label is fine (same model via same provider)
    const uniqueIds = new Set(group.map((m) => m.registryId));
    if (uniqueIds.size <= 1) continue;

    // Different models with same display name -- append provider name
    for (const m of group) {
      const providerName = await getProviderDisplayName(m.provider);
      m.label = `${m.label} (${providerName ?? m.provider})`;
    }
  }
}

// ── Prompt filtering ────────────────────────────────

/**
 * Filter prompts by id or tag.
 * Each filter value is matched case-insensitively against both
 * the prompt's `id` (filename) and its `tags`.
 */
export function filterPrompts(
  prompts: PromptConfig[],
  filters: string[]
): PromptConfig[] {
  const normalized = new Set(filters.map((f) => f.toLowerCase()));
  return prompts.filter(
    (p) =>
      normalized.has(p.id.toLowerCase()) ||
      p.tags.some((t) => normalized.has(t.toLowerCase()))
  );
}

// ── Run config assembly ─────────────────────────────

/**
 * Assemble a complete RunConfig from CLI arguments.
 */
export function createRunConfig(opts: {
  models: ModelConfig[];
  judges?: ModelConfig[];
  prompts: PromptConfig[];
  outputsPerModel?: number;
  reasoning?: boolean;
  noCache?: boolean;
  cacheOnly?: boolean;
  skipSeeding?: boolean;
  concurrency?: number;
  convergence?: Partial<ConvergenceConfig>;
}): RunConfig {
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, "-");

  return {
    id,
    models: opts.models,
    judges: opts.judges?.length ? opts.judges : undefined,
    prompts: opts.prompts,
    outputsPerModel: opts.outputsPerModel ?? Infinity,
    reasoning: opts.reasoning ?? true,
    noCache: opts.noCache ?? false,
    cacheOnly: opts.cacheOnly ?? false,
    skipSeeding: opts.skipSeeding ?? false,
    concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    timestamp: now.toISOString(),
    convergence: { ...DEFAULT_CONVERGENCE, ...opts.convergence },
  };
}
