import type { RunsIndex, PromptContent, TagAlternatives } from "./types.js";
import type { SectionLoader } from "./ensure-section-loaded.js";
import { DEFAULT_CONVERGENCE, JudgeQualityMode } from "../../src/types.js";
import { ensureSectionLoaded } from "./ensure-section-loaded.js";

// ── App state ───────────────────────────────────────

export interface AppState {
  index: RunsIndex | null;
}

export const state: AppState = { index: null };

// ── Rating settings state ───────────────────────────

export type RatingMode = "default" | "equalWeight" | "noBiasCorrection" | "custom";

export interface RatingState {
  ratingMode: RatingMode;
  qualityMode: JudgeQualityMode;
  judgeDecay: number;
  excludedJudges: Set<string>;
  applyBiasCorrection: boolean;
}

const DEFAULT_RATING_STATE: RatingState = {
  ratingMode: "default",
  qualityMode: DEFAULT_CONVERGENCE.judgeQualityMode,
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

export function setQualityMode(mode: JudgeQualityMode): void {
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
let _judgmentsSectionLoader: SectionLoader | null = null;

export function setJudgmentApi(api: JudgmentApi | null): void {
  _judgmentApi = api;
  if (!api) {
    _judgmentsSectionLoader = null;
  }
}

export function setJudgmentsSectionLoader(loader: SectionLoader | null): void {
  _judgmentsSectionLoader = loader;
}

async function ensureJudgmentsLoaded(): Promise<void> {
  if (!_judgmentsSectionLoader) return;
  await ensureSectionLoaded(_judgmentsSectionLoader);
}

export async function focusJudgmentsForSample(sampleId: string): Promise<void> {
  await ensureJudgmentsLoaded();
  _judgmentApi?.focusSample(sampleId);
}

export async function focusJudgmentsForModel(model: string): Promise<void> {
  await ensureJudgmentsLoaded();
  _judgmentApi?.focusModel(model);
}

// ── Prompt section load state ───────────────────────

const promptLoadPromises = new Map<string, Promise<void>>();

export function registerPromptLoadPromise(promptId: string, loadPromise: Promise<void>): void {
  promptLoadPromises.set(promptId, loadPromise);
  void loadPromise.finally(() => {
    if (promptLoadPromises.get(promptId) === loadPromise) {
      promptLoadPromises.delete(promptId);
    }
  });
}

export function getPromptLoadPromise(promptId: string): Promise<void> | undefined {
  return promptLoadPromises.get(promptId);
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
