import type { AlternativeRatings, RunManifest, TagAlternatives } from "./types.js";
import type { EloTableOpts } from "./helpers.js";
import { el, renderEloTable, judgmentMetaToPairwise, buildSampleMaps } from "./helpers.js";
import { getRatingState, subscribeRating } from "./state.js";
import type { RatingMode } from "./state.js";
import { computeJudgeQuality, computeEloBasedJudgeQuality } from "../../src/engine/judge-quality.js";
import { computeJudgeBias, computeBiasCorrections, composeWeights } from "../../src/engine/judge-bias.js";
import { judgmentsToGames, improvementJudgmentsToGames, whrRatings } from "../../src/engine/whr.js";
import type { PairwiseJudgment } from "../../src/types.js";
import { DEFAULT_CONVERGENCE } from "../../src/types.js";

// ── Types ───────────────────────────────────────────

/** Minimal rating shape accepted by renderEloTable. */
type RatingLike = {
  model: string;
  rating: number;
  matchCount: number;
  ci95?: number;
};

export interface RatingToggleConfig {
  /** The default (quality-weighted + bias-corrected) ratings. */
  defaultRatings: RatingLike[];
  /** Pre-computed alternative rating sets (absent for single-judge runs). */
  alternativeRatings?: AlternativeRatings;
  /** Run manifest for custom mode (has judgments + samples). Omit for dashboard. */
  manifest?: RunManifest;
  /** Which dimension these ratings represent. */
  dimension: "initial" | "revised" | "feedback";
  /** Options passed to renderEloTable. */
  eloTableOpts: EloTableOpts;
  /** Tag filter for per-tag tables. When set, non-default modes are
   *  computed client-side (run-detail) or looked up from tagAlternatives (dashboard). */
  tagFilter?: string;
  /** Pre-computed per-tag alternatives (dashboard only -- lazy-loaded). */
  tagAlternatives?: TagAlternatives;
}

export interface RatingToggleResult {
  /** The outer container (table only -- no toggle bar). Append this to the page. */
  container: HTMLElement;
}

// ── Rating Toggle (managed table) ───────────────────

/**
 * Create a managed ELO table that subscribes to the shared rating state.
 *
 * No tab bar or custom panel -- those live in rating-settings.ts.
 * This function just renders the table and re-renders when the shared
 * state changes.
 */
export function createRatingToggle(config: RatingToggleConfig): RatingToggleResult {
  const container = el("div", { className: "rating-toggle-container" });
  const tableContainer = el("div", { className: "rating-table-target" });

  // Determine if this table should be reactive to rating mode changes.
  // Reactive when we have: pre-computed alternatives, OR per-tag alternatives,
  // OR a manifest with tagFilter (client-side computation).
  const hasReactivity = config.alternativeRatings
    || config.tagAlternatives
    || (config.manifest && config.tagFilter);

  if (!hasReactivity) {
    tableContainer.appendChild(renderEloTable(config.defaultRatings, config.eloTableOpts));
    container.appendChild(tableContainer);
    return { container };
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Build a model -> default rating lookup for metadata carry-over ──
  // Cost/token data is per-model and independent of rating weights, so
  // we carry it from the default ratings onto alternatives.

  const defaultByModel = new Map<string, RatingLike>();
  for (const r of config.defaultRatings) {
    defaultByModel.set(r.model, r);
  }

  /** Enrich alternative ratings with cost/token metadata from defaults. */
  function enrichRatings(ratings: RatingLike[]): RatingLike[] {
    return ratings.map((r) => {
      const def = defaultByModel.get(r.model);
      // Spread default first (carries cost/token fields), then override
      // with alternative rating values (rating, ci95, matchCount, model)
      return {
        ...def,
        ...r,
        matchCount: Math.round(r.matchCount),
      } as RatingLike;
    });
  }

  // ── Get ratings for current mode ──

  function getRatings(): RatingLike[] {
    const state = getRatingState();

    if (state.ratingMode === "default") {
      return config.defaultRatings;
    }

    // Per-tag tables: client-side computation (run-detail) or
    // pre-computed lookup (dashboard)
    if (config.tagFilter) {
      return enrichRatings(getTagRatings(state.ratingMode));
    }

    // Main tables: pre-computed alternatives
    const alt = config.alternativeRatings!;
    const dim = config.dimension;

    switch (state.ratingMode) {
      case "equalWeight":
        return enrichRatings(alt.equalWeight[dim] ?? config.defaultRatings);
      case "noBiasCorrection":
        return enrichRatings(alt.noBiasCorrection[dim] ?? config.defaultRatings);
      case "custom":
        return enrichRatings(computeClientSideRatings("custom"));
    }
  }

  // ── Per-tag ratings ──

  function getTagRatings(mode: RatingMode): RatingLike[] {
    // Dashboard path: look up pre-computed tag alternatives
    if (config.tagAlternatives && !config.manifest) {
      const tag = config.tagFilter!;
      const dim = config.dimension as "initial" | "revised";
      const tagAlts = config.tagAlternatives;

      switch (mode) {
        case "equalWeight":
          return tagAlts.equalWeight[tag]?.[dim] ?? config.defaultRatings;
        case "noBiasCorrection":
          return tagAlts.noBiasCorrection[tag]?.[dim] ?? config.defaultRatings;
        default:
          return config.defaultRatings;
      }
    }

    // Run-detail path: compute client-side from manifest
    return computeClientSideRatings(mode);
  }

  // ── Client-side computation (shared engine code) ──
  // Handles custom, equalWeight, and noBiasCorrection modes.

  function computeClientSideRatings(mode: RatingMode): RatingLike[] {
    const manifest = config.manifest;
    if (!manifest) return config.defaultRatings;

    const state = getRatingState();

    const { sampleToModel, revisedSampleToModel, sampleToFeedbackModel } =
      buildSampleMaps(manifest.samples);

    // Build tag filter set if needed
    let tagPromptIds: Set<string> | null = null;
    if (config.tagFilter) {
      const promptToTags = new Map<string, string[]>();
      for (const p of manifest.config.prompts) {
        promptToTags.set(p.id, p.tags);
      }
      tagPromptIds = new Set<string>();
      for (const [pid, tags] of promptToTags) {
        if (tags.includes(config.tagFilter)) tagPromptIds.add(pid);
      }
    }

    // Filter judgments by excluded judges (custom mode only)
    // and by tag if tagFilter is set
    const isCustom = mode === "custom";
    const filtered = manifest.judgments.filter((j) => {
      if (isCustom && state.excludedJudges.has(j.judgeModel)) return false;
      if (tagPromptIds && !tagPromptIds.has(j.promptId)) return false;
      return true;
    });
    const filteredJudgments = judgmentMetaToPairwise(filtered);

    if (filteredJudgments.length === 0) return config.defaultRatings;

    // Compute judge quality weights
    const judgeLabels = [...new Set(filteredJudgments.map((j) => j.judgeModel))];
    let jw: Map<string, number> | undefined;
    let jmw: Map<string, number> | undefined;

    if (mode === "equalWeight") {
      // No judge weights, no bias corrections
      jw = undefined;
      jmw = undefined;
    } else {
      // Both noBiasCorrection and custom use quality weights
      let quality;
      if (!isCustom || state.qualityMode === "consensus") {
        quality = computeJudgeQuality(filteredJudgments, judgeLabels,
          isCustom ? state.judgeDecay : DEFAULT_CONVERGENCE.judgeDecay);
      } else {
        const rawRatings =
          state.qualityMode === "writing" ? manifest.elo.initial.ratings :
          state.qualityMode === "feedback" ? (manifest.elo.revised.feedbackRatings ?? []) :
          manifest.elo.revised.ratings;
        const dimRatings = rawRatings.map((r) => ({
          model: r.model,
          rating: r.rating,
          wins: r.wins,
          losses: r.losses,
          ties: r.ties,
          matchCount: r.matchCount,
          ci95: r.ci95 ?? 0,
        }));
        quality = computeEloBasedJudgeQuality(dimRatings, judgeLabels, state.judgeDecay);
      }

      jw = quality.active ? quality.weights : undefined;

      // Bias corrections: custom mode respects the toggle, noBiasCorrection skips
      if (mode === "custom" && state.applyBiasCorrection && quality.active) {
        const allSampleToModel = new Map([...sampleToModel, ...revisedSampleToModel]);
        const biasData = computeJudgeBias(filteredJudgments, allSampleToModel, judgeLabels);
        const corrections = computeBiasCorrections(filteredJudgments, allSampleToModel, biasData);
        if (corrections.size > 0) {
          jmw = composeWeights(filteredJudgments, jw, corrections);
        }
      }
    }

    // Compute ratings for the selected dimension
    const dim = config.dimension;
    if (dim === "initial") {
      const initial = filteredJudgments.filter((j) => j.stage === "initial");
      return whrRatings(judgmentsToGames(initial, sampleToModel, jw, jmw));
    } else if (dim === "revised") {
      const revised = filteredJudgments.filter((j) => j.stage === "revised");
      return whrRatings(judgmentsToGames(revised, revisedSampleToModel, jw, jmw));
    } else {
      const improvement = filteredJudgments.filter((j) => j.stage === "improvement");
      return whrRatings(improvementJudgmentsToGames(improvement, sampleToFeedbackModel, jw, jmw));
    }
  }

  // ── Render table ──

  function renderTable(): void {
    tableContainer.innerHTML = "";
    const ratings = getRatings();
    tableContainer.appendChild(renderEloTable(ratings, config.eloTableOpts));
  }

  function debouncedRender(): void {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderTable, 200);
  }

  // ── Subscribe to shared state ──

  subscribeRating(debouncedRender);

  // ── Initial render ──

  renderTable();
  container.appendChild(tableContainer);

  return { container };
}


