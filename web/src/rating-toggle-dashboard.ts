import type { AlternativeRatings, TagAlternatives } from "./types.js";
import type { EloTableOpts } from "./helpers.js";
import { el, renderEloTable } from "./helpers.js";
import { getRatingState, subscribeRating } from "./state.js";
import type { RatingMode } from "./state.js";

// ── Types ───────────────────────────────────────────

type RatingLike = {
  model: string;
  rating: number;
  matchCount: number;
  ci95?: number;
};

export interface DashboardRatingToggleConfig {
  defaultRatings: RatingLike[];
  alternativeRatings?: AlternativeRatings;
  dimension: "initial" | "revised" | "feedback";
  eloTableOpts: EloTableOpts;
  tagFilter?: string;
  tagAlternatives?: TagAlternatives;
}

export interface DashboardRatingToggleResult {
  container: HTMLElement;
}

// ── Dashboard Rating Toggle ─────────────────────────

export function createDashboardRatingToggle(
  config: DashboardRatingToggleConfig,
): DashboardRatingToggleResult {
  const container = el("div", { className: "rating-toggle-container" });
  const tableContainer = el("div", { className: "rating-table-target" });

  const hasReactivity = config.alternativeRatings || config.tagAlternatives;
  if (!hasReactivity) {
    tableContainer.appendChild(renderEloTable(config.defaultRatings, config.eloTableOpts));
    container.appendChild(tableContainer);
    return { container };
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const defaultByModel = new Map<string, RatingLike>();
  for (const r of config.defaultRatings) {
    defaultByModel.set(r.model, r);
  }

  function enrichRatings(ratings: RatingLike[]): RatingLike[] {
    return ratings.map((r) => {
      const def = defaultByModel.get(r.model);
      return {
        ...def,
        ...r,
        matchCount: Math.round(r.matchCount),
      } as RatingLike;
    });
  }

  function getTagRatings(mode: RatingMode): RatingLike[] {
    if (!config.tagAlternatives) return config.defaultRatings;

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

  function getRatings(): RatingLike[] {
    const state = getRatingState();

    if (state.ratingMode === "default") {
      return config.defaultRatings;
    }

    if (config.tagFilter) {
      return enrichRatings(getTagRatings(state.ratingMode));
    }

    const alt = config.alternativeRatings;
    if (!alt) return config.defaultRatings;

    const dim = config.dimension;
    switch (state.ratingMode) {
      case "equalWeight":
        return enrichRatings(alt.equalWeight[dim] ?? config.defaultRatings);
      case "noBiasCorrection":
        return enrichRatings(alt.noBiasCorrection[dim] ?? config.defaultRatings);
      default:
        return config.defaultRatings;
    }
  }

  function renderTable(): void {
    tableContainer.innerHTML = "";
    const ratings = getRatings();
    tableContainer.appendChild(renderEloTable(ratings, config.eloTableOpts));
  }

  function debouncedRender(): void {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderTable, 200);
  }

  subscribeRating(debouncedRender);
  renderTable();
  container.appendChild(tableContainer);

  return { container };
}
