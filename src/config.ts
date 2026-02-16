import { readFile } from "fs/promises";
import { basename } from "path";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";
import { Glob } from "bun";
import type { PromptConfig, ModelConfig, RunConfig } from "./types.js";
import { parseModelSpec } from "./providers/registry.js";

// ── Zod schemas for TOML prompt validation ──────────

const PromptTomlSchema = z.object({
  name: z.string(),
  category: z.string(),
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
    category: validated.category,
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
 * Parse CLI model specs into ModelConfig objects.
 */
export function parseModelConfigs(specs: string[]): ModelConfig[] {
  return specs.map((spec) => {
    const { provider, model, label, registryId } = parseModelSpec(spec);
    return {
      provider: provider as ModelConfig["provider"],
      model,
      label,
      registryId,
    } as ModelConfig;
  });
}

// ── Prompt filtering ────────────────────────────────

/**
 * Filter prompts by id or category.
 * Each filter value is matched case-insensitively against both
 * the prompt's `id` (filename) and `category`.
 */
export function filterPrompts(
  prompts: PromptConfig[],
  filters: string[]
): PromptConfig[] {
  const normalized = new Set(filters.map((f) => f.toLowerCase()));
  return prompts.filter(
    (p) =>
      normalized.has(p.id.toLowerCase()) ||
      normalized.has(p.category.toLowerCase())
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
  outputsPerModel: number;
  reasoning?: boolean;
  noCache?: boolean;
}): RunConfig {
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, "-");

  return {
    id,
    models: opts.models,
    judges: opts.judges?.length ? opts.judges : undefined,
    prompts: opts.prompts,
    outputsPerModel: Math.min(Math.max(opts.outputsPerModel, 1), 3),
    reasoning: opts.reasoning ?? true,
    noCache: opts.noCache ?? false,
    timestamp: now.toISOString(),
  };
}
