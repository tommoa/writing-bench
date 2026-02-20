import type { RunsIndex, PromptContent, TagAlternatives } from "./types.js";
import { DEFAULT_CONVERGENCE } from "../../src/types.js";

// ── App state ───────────────────────────────────────

export interface AppState {
  index: RunsIndex | null;
}

export const state: AppState = { index: null };

// ── Rating settings state ───────────────────────────

export type RatingMode = "default" | "equalWeight" | "noBiasCorrection" | "custom";
export type QualityMode = "consensus" | "writing" | "feedback" | "revised";

export interface RatingState {
  ratingMode: RatingMode;
  qualityMode: QualityMode;
  judgeDecay: number;
  excludedJudges: Set<string>;
  applyBiasCorrection: boolean;
}

const DEFAULT_RATING_STATE: RatingState = {
  ratingMode: "default",
  qualityMode: "consensus",
  judgeDecay: DEFAULT_CONVERGENCE.judgeDecay,
  excludedJudges: new Set(),
  applyBiasCorrection: true,
};

let ratingState: RatingState = { ...DEFAULT_RATING_STATE, excludedJudges: new Set() };
const ratingListeners: Array<() => void> = [];

export function getRatingState(): Readonly<RatingState> {
  return ratingState;
}

function notifyRating(): void {
  for (const fn of ratingListeners) fn();
}

export function setRatingMode(mode: RatingMode): void {
  if (ratingState.ratingMode === mode) return;
  ratingState.ratingMode = mode;
  notifyRating();
}

export function setQualityMode(mode: QualityMode): void {
  if (ratingState.qualityMode === mode) return;
  ratingState.qualityMode = mode;
  notifyRating();
}

export function setJudgeDecay(k: number): void {
  if (ratingState.judgeDecay === k) return;
  ratingState.judgeDecay = k;
  notifyRating();
}

export function toggleJudge(judge: string): void {
  if (ratingState.excludedJudges.has(judge)) {
    ratingState.excludedJudges.delete(judge);
  } else {
    ratingState.excludedJudges.add(judge);
  }
  notifyRating();
}

export function includeAllJudges(): void {
  ratingState.excludedJudges.clear();
  notifyRating();
}

export function excludeAllJudges(judges: string[]): void {
  ratingState.excludedJudges = new Set(judges);
  notifyRating();
}

export function toggleBiasCorrection(): void {
  ratingState.applyBiasCorrection = !ratingState.applyBiasCorrection;
  notifyRating();
}

export function subscribeRating(fn: () => void): void {
  ratingListeners.push(fn);
}

export function clearRatingSubscribers(): void {
  ratingListeners.length = 0;
  // Reset to defaults on navigation
  ratingState = { ...DEFAULT_RATING_STATE, excludedJudges: new Set() };
}

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

// ── Tag alternatives cache ──────────────────────────
// Lazy-loaded on first dashboard tag expand.

let tagAltCache: TagAlternatives | null = null;

export async function fetchTagAlternatives(): Promise<TagAlternatives> {
  if (tagAltCache) return tagAltCache;
  const res = await fetch("data/tag-alternatives.json");
  if (!res.ok) throw new Error("Tag alternatives not found");
  tagAltCache = await res.json();
  return tagAltCache!;
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


