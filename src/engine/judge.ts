import { generateObject, streamText } from "ai";
import { z } from "zod";
import { resolveModel } from "../providers/registry.js";
import { withRetry, isRetryable } from "./retry.js";
import {
  extractUsage,
  type WritingSample,
  type PairwiseJudgment,
  type PromptConfig,
  type ModelConfig,
  type CostBreakdown,
  type ModelInfo,
  type TokenUsage,
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
 * Extract the first JSON object from a text response.
 * Handles markdown code fences, leading/trailing text, etc.
 */
export function extractJson(text: string): unknown | null {
  // Try the whole string first
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // Try extracting from code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue
    }
  }

  // Try finding a JSON object anywhere in the text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Have a judge model compare two writing samples.
 *
 * Tries generateObject first (structured output). If the model doesn't
 * support responseFormat / JSON schema, falls back to generateText and
 * parses the JSON from the response text.
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

  const systemPrompt = buildJudgingSystemPrompt(prompt, reasoning);
  const userPrompt = buildJudgingUserPrompt(prompt, sampleA, sampleB);

  let winner!: "A" | "B" | "tie";
  let reasoningText = "";
  let usage!: TokenUsage;
  let cost!: CostBreakdown;

  try {
    // Primary path: structured output via generateObject (with retry)
    await withRetry(async () => {
      const result = await generateObject({
        model,
        schema,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: judgeConfig.temperature ?? 0.2,
        maxRetries: 0,
      });

      usage = extractUsage(result.usage);
      cost = calculateCost(modelInfo, usage);
      winner = result.object.winner;
      reasoningText =
        "reasoning" in result.object
          ? String(result.object.reasoning)
          : "";
    });
  } catch (err) {
    // Transient errors already exhausted retries — propagate rather than
    // falling through to the streamText path (which would also fail).
    if (isRetryable(err)) throw err;

    // Non-retryable error (schema/format issue) → streamText fallback
    // with its own retry for transient failures.
    await withRetry(async () => {
      const result = streamText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: judgeConfig.temperature ?? 0.2,
        maxRetries: 0,
      });

      const text = await result.text;
      usage = extractUsage(await result.usage);
      cost = calculateCost(modelInfo, usage);

      const parsed = extractJson(text);
      if (!parsed) {
        throw new Error(
          `${judgeConfig.label}: could not extract JSON from judgment response`
        );
      }

      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        throw new Error(
          `${judgeConfig.label}: judgment JSON did not match schema: ${validated.error.message}`
        );
      }

      winner = validated.data.winner;
      reasoningText =
        "reasoning" in validated.data
          ? String(validated.data.reasoning)
          : "";
    });
  }

  const latencyMs = Date.now() - startTime;

  return {
    id: nanoid(),
    judgeModel: judgeConfig.label,
    promptId: prompt.id,
    sampleA: sampleA.id,
    sampleB: sampleB.id,
    winner,
    reasoning: reasoningText,
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
