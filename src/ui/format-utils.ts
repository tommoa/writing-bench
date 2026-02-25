import type { EloRating } from "../types.js";

// ── Text Formatting ──────────────────────────────────

/** Truncate a string to maxLen, adding ellipsis if needed. */
export function truncate(s: string, maxLen: number): string {
  if (maxLen <= 0 || s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

// ── Cost / Time Formatting ───────────────────────────

export function fmtCost(n: number): string {
  if (n === 0) return "-";
  return `$${n.toFixed(4)}`;
}

export function fmtTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── ELO Helpers ──────────────────────────────────────

/** Average a model's initial and revised ELO ratings. */
export function computeAvgElo(
  model: string,
  initial: EloRating[],
  revised: EloRating[],
): number | null {
  const vals: number[] = [];
  const ini = initial.find((r) => r.model === model);
  if (ini) vals.push(ini.rating);
  const rev = revised.find((r) => r.model === model);
  if (rev) vals.push(rev.rating);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// ── Stage Column Definitions ─────────────────────────

export const STAGE_COLS = [
  { key: "initial", label: "Write" },
  { key: "initialJudging", label: "Judge" },
  { key: "feedback", label: "Feedback" },
  { key: "revised", label: "Revise" },
  { key: "revisedJudging", label: "Re-Judge" },
] as const;
