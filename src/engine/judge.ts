import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel } from "../providers/registry.js";
import {
  extractUsage,
  type WritingSample,
  type PairwiseJudgment,
  type PromptConfig,
  type ModelConfig,
  type CostBreakdown,
  type ModelInfo,
} from "../types.js";
import { calculateCost } from "../providers/models.js";
import { nanoid } from "nanoid";

const JudgmentSchemaWithReasoning = z.object({
  winner: z.enum(["A", "B", "tie"]),
  reasoning: z.string(),
});

const JudgmentSchemaCompact = z.object({
  winner: z.enum(["A", "B", "tie"]),
});

/**
 * Build the system prompt for judging a pair of writing samples.
 */
function buildJudgingSystemPrompt(
  prompt: PromptConfig,
  reasoning: boolean
): string {
  const criteria = prompt.judgingCriteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  if (reasoning) {
    return `You are an expert literary judge. You will compare two writing samples produced for the same prompt and determine which is better.

Evaluate based on these criteria:
${criteria}

You must respond with a JSON object containing:
- "winner": either "A", "B", or "tie"
- "reasoning": a brief explanation of your judgment (2-3 sentences)

Be fair and objective. Do not let the position (A vs B) bias your judgment. Focus on quality differences.`;
  }

  return `You are an expert literary judge. You will compare two writing samples produced for the same prompt and determine which is better.

Evaluate based on these criteria:
${criteria}

You must respond with a JSON object containing:
- "winner": either "A", "B", or "tie"

Be fair and objective. Do not let the position (A vs B) bias your judgment. Focus on quality differences.`;
}

/**
 * Build the user prompt presenting two samples for comparison.
 */
function buildJudgingUserPrompt(
  prompt: PromptConfig,
  sampleA: WritingSample,
  sampleB: WritingSample
): string {
  return `Original writing prompt: "${prompt.prompt.trim()}"

--- Sample A ---
${sampleA.text}

--- Sample B ---
${sampleB.text}

Which sample is better? Respond with JSON.`;
}

/**
 * Have a judge model compare two writing samples.
 */
export async function judgePair(
  judgeConfig: ModelConfig,
  prompt: PromptConfig,
  sampleA: WritingSample,
  sampleB: WritingSample,
  modelInfo: ModelInfo | null,
  reasoning = true
): Promise<PairwiseJudgment> {
  const startTime = Date.now();

  const model = await resolveModel(
    `${judgeConfig.provider}:${judgeConfig.model}`
  );

  const schema = reasoning
    ? JudgmentSchemaWithReasoning
    : JudgmentSchemaCompact;

  const result = await generateObject({
    model,
    schema,
    system: buildJudgingSystemPrompt(prompt, reasoning),
    prompt: buildJudgingUserPrompt(prompt, sampleA, sampleB),
    temperature: judgeConfig.temperature ?? 0.2,
  });

  const latencyMs = Date.now() - startTime;
  const usage = extractUsage(result.usage);
  const cost: CostBreakdown = calculateCost(modelInfo, usage);

  return {
    id: nanoid(),
    judgeModel: judgeConfig.label,
    promptId: prompt.id,
    sampleA: sampleA.id,
    sampleB: sampleB.id,
    winner: result.object.winner,
    reasoning:
      "reasoning" in result.object
        ? String(result.object.reasoning)
        : "",
    stage: sampleA.stage,
    usage,
    cost,
    latencyMs,
  };
}

/**
 * Generate all pairs from an array (combinations of 2).
 */
export function generatePairs<T>(items: T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push([items[i], items[j]]);
    }
  }
  return pairs;
}

/**
 * Randomize pair order to avoid position bias.
 * Returns the pair with a 50% chance of being swapped.
 */
export function randomizePairOrder<T>(pair: [T, T]): {
  pair: [T, T];
  swapped: boolean;
} {
  const swapped = Math.random() < 0.5;
  return {
    pair: swapped ? [pair[1], pair[0]] : pair,
    swapped,
  };
}

/**
 * Correct a judgment's winner field if the pair was swapped for position bias.
 */
export function correctForSwap(
  winner: "A" | "B" | "tie",
  swapped: boolean
): "A" | "B" | "tie" {
  if (!swapped || winner === "tie") return winner;
  return winner === "A" ? "B" : "A";
}
