import type { RunsIndex, PromptContent } from "./types.js";

// ── App state ───────────────────────────────────────

export interface AppState {
  index: RunsIndex | null;
}

export const state: AppState = { index: null };

// ── Cross-section judgment API ──────────────────────
// Set by renderJudgmentsSection, called by "view judgments"
// buttons in prompt sections.

export interface JudgmentApi {
  focusSample: (sampleId: string) => void;
  focusModel: (model: string) => void;
}

let _judgmentApi: JudgmentApi | null = null;

export function getJudgmentApi(): JudgmentApi | null {
  return _judgmentApi;
}

export function setJudgmentApi(api: JudgmentApi | null): void {
  _judgmentApi = api;
}

// ── Prompt content cache ────────────────────────────
// Shared between prompt-section.ts and judgments.ts to
// avoid duplicate fetches.

const promptContentCache = new Map<string, PromptContent>();

export async function fetchPromptContent(
  runId: string,
  promptId: string,
): Promise<PromptContent> {
  const key = `${runId}/${promptId}`;
  const cached = promptContentCache.get(key);
  if (cached) return cached;

  const res = await fetch(`data/runs/${runId}/prompt-${promptId}.json`);
  if (!res.ok) throw new Error(`Prompt content not found: ${promptId}`);
  const content: PromptContent = await res.json();
  promptContentCache.set(key, content);
  return content;
}


