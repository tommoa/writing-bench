import type { ModelInfo } from "../types.js";

/** Global cap -- same as opencode's OUTPUT_TOKEN_MAX. */
const OUTPUT_TOKEN_CAP = 32_000;

/**
 * Resolve maxOutputTokens: explicit config > min(model limit, cap) > cap.
 * Mirrors opencode's approach: min(model.limit.output, 32_000).
 */
export function resolveMaxOutputTokens(
  configMax: number | undefined,
  modelInfo: ModelInfo | null,
): number {
  if (configMax) return configMax;
  if (modelInfo?.outputLimit) return Math.min(modelInfo.outputLimit, OUTPUT_TOKEN_CAP);
  return OUTPUT_TOKEN_CAP;
}

/**
 * Resolve temperature, returning undefined for reasoning models that
 * don't support it (models.dev temperature: false).
 */
export function resolveTemperature(
  configTemp: number | undefined,
  defaultTemp: number,
  modelInfo: ModelInfo | null,
): number | undefined {
  if (modelInfo && !modelInfo.supportsTemperature) return undefined;
  return configTemp ?? defaultTemp;
}
