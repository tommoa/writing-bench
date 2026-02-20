import type { JudgeQualityEntry, RunManifest } from "./types.js";
import { el, formatWeight, formatBias, biasClass, judgmentMetaToPairwise, buildSampleMaps } from "./helpers.js";
import { getRatingState, subscribeRating } from "./state.js";
import { computeJudgeQuality, computeEloBasedJudgeQuality } from "../../src/engine/judge-quality.js";
import { computeJudgeBias } from "../../src/engine/judge-bias.js";
import type { QualityMode } from "./state.js";
import { DEFAULT_CONVERGENCE } from "../../src/types.js";

// ── Judge Quality Section ───────────────────────────

/**
 * Render a judge quality section as a managed table.
 *
 * On the run detail page (manifest provided, >= 2 judges), the table
 * subscribes to the shared rating state and re-renders when quality
 * mode or decay changes.
 *
 * On the dashboard (no manifest), it renders pre-computed consensus
 * data only -- no reactivity.
 */
export function renderJudgeQualitySection(
  entries: JudgeQualityEntry[],
  title = "Judge Quality",
  manifest?: RunManifest,
): HTMLElement | null {
  if (entries.length === 0) return null;

  const judgeLabels = manifest
    ? [...new Set(manifest.judgments.map((j) => j.judgeModel))]
    : [];

  // If manifest present and >= 2 judges, create a reactive managed table
  if (manifest && judgeLabels.length >= 2) {
    return createManagedJudgeQuality(entries, manifest);
  }

  // Dashboard / single-judge: just the static table
  const container = el("div");
  container.appendChild(renderJudgeQualityTable(entries));
  return container;
}

// ── Managed (reactive) judge quality ────────────────

/**
 * Create a judge quality table that subscribes to shared rating state.
 * No individual tabs or slider -- those live in the unified settings.
 */
function createManagedJudgeQuality(
  precomputedEntries: JudgeQualityEntry[],
  manifest: RunManifest,
): HTMLElement {
  const container = el("div");
  const tableContainer = el("div");
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function getEntries(): JudgeQualityEntry[] {
    const state = getRatingState();
    // Use pre-computed data for default mode with consensus + default decay
    if (
      state.ratingMode === "default" &&
      state.qualityMode === "consensus" &&
      state.judgeDecay === DEFAULT_CONVERGENCE.judgeDecay
    ) {
      return precomputedEntries;
    }
    // For any non-default state, recompute client-side
    return computeJudgeQualityEntries(manifest, state.qualityMode, state.judgeDecay);
  }

  function renderTable(): void {
    tableContainer.innerHTML = "";
    tableContainer.appendChild(renderJudgeQualityTable(getEntries()));
  }

  function debouncedRender(): void {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderTable, 200);
  }

  // Subscribe to shared state
  subscribeRating(debouncedRender);

  // Initial render
  renderTable();
  container.appendChild(tableContainer);

  return container;
}

// ── Client-side Computation ─────────────────────────

/**
 * Compute JudgeQualityEntry[] from manifest data for a given quality
 * mode and decay rate. Mirrors the export-time computation in
 * web-export.ts but runs in the browser.
 */
function computeJudgeQualityEntries(
  manifest: RunManifest,
  qualityMode: QualityMode,
  judgeDecay: number,
): JudgeQualityEntry[] {
  const { sampleToModel, revisedSampleToModel } = buildSampleMaps(manifest.samples);

  // Convert JudgmentMeta[] to PairwiseJudgment[] for engine functions
  const judgments = judgmentMetaToPairwise(manifest.judgments);

  const judgeLabels = [...new Set(judgments.map((j) => j.judgeModel))];
  if (judgeLabels.length < 2) return [];

  // Compute judge quality based on selected mode
  let quality;

  if (qualityMode === "consensus") {
    quality = computeJudgeQuality(judgments, judgeLabels, judgeDecay);
  } else {
    const rawRatings =
      qualityMode === "writing" ? manifest.elo.initial.ratings :
      qualityMode === "feedback" ? (manifest.elo.revised.feedbackRatings ?? []) :
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
    quality = computeEloBasedJudgeQuality(dimRatings, judgeLabels, judgeDecay);
  }

  if (!quality.active || quality.ratings.length === 0) return [];

  // Compute bias stats
  const allSampleToModel = new Map([...sampleToModel, ...revisedSampleToModel]);
  const biasData = computeJudgeBias(judgments, allSampleToModel, judgeLabels);

  const pruneThreshold = DEFAULT_CONVERGENCE.judgePruneThreshold;

  return quality.ratings.map((r) => {
    const weight = quality.weights.get(r.model) ?? 1.0;
    const selfPref = biasData.selfPreference.get(r.model);
    const posBias = biasData.positionBias.get(r.model);

    return {
      model: r.model,
      rating: r.rating,
      ci95: r.ci95 ?? Infinity,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      weight,
      selfBias: selfPref?.sufficient ? selfPref.biasDelta : null,
      positionBias: posBias?.sufficient ? posBias.positionBiasDelta : null,
      selfBiasSufficient: selfPref?.sufficient ?? false,
      positionBiasSufficient: posBias?.sufficient ?? false,
      status: weight < pruneThreshold ? "pruned" as const : "active" as const,
    };
  });
}

// ── Table Rendering ─────────────────────────────────

/**
 * Render the judge quality table with CI click-to-toggle and
 * clearer column names.
 */
function renderJudgeQualityTable(entries: JudgeQualityEntry[]): HTMLElement {
  const table = el("table");

  const hasCi = entries.some((e) => e.ci95 != null && isFinite(e.ci95));
  const hasSelfBias = entries.some((e) => e.selfBias != null || e.selfBiasSufficient);
  const hasPosBias = entries.some((e) => e.positionBias != null || e.positionBiasSufficient);

  // Header
  const headerCells = [
    el("th", { className: "rank" }, "#"),
    el("th", {}, "Judge"),
    el("th", {}, "Rating"),
  ];
  if (hasCi) {
    headerCells.push(el("th", {
      className: "ci ci-toggle",
      onClick: () => table.classList.toggle("show-ci-range"),
    }, "\u00b1CI"));
  }
  headerCells.push(el("th", {}, "W/L/T"));
  headerCells.push(el("th", {}, "Weight"));
  if (hasSelfBias) headerCells.push(el("th", {}, "Self Bias"));
  if (hasPosBias) headerCells.push(el("th", {}, "Pos Bias"));
  headerCells.push(el("th", {}, "Status"));

  table.appendChild(el("thead", {}, el("tr", {}, ...headerCells)));

  // Body
  const tbody = el("tbody");
  entries.forEach((e, i) => {
    const ratingCls =
      i === 0
        ? "rating top"
        : i === entries.length - 1
          ? "rating bottom"
          : "rating";

    const rowCls = e.status === "pruned" ? "judge-row pruned" : "judge-row";

    const cells = [
      el("td", { className: "rank" }, String(i + 1)),
      el("td", {}, e.model),
      el("td", { className: ratingCls }, String(e.rating)),
    ];

    if (hasCi) {
      if (isFinite(e.ci95)) {
        const lo = Math.round(e.rating - e.ci95);
        const hi = Math.round(e.rating + e.ci95);
        cells.push(el("td", { className: "ci" },
          el("span", { className: "ci-pm" }, `\u00b1${e.ci95}`),
          el("span", { className: "ci-range" }, `${lo}\u2013${hi}`),
        ));
      } else {
        cells.push(el("td", { className: "ci" }, "-"));
      }
    }

    cells.push(el("td", { className: "wlt" }, `${e.wins}/${e.losses}/${e.ties}`));
    cells.push(el("td", { className: "muted" }, formatWeight(e.weight)));

    if (hasSelfBias) {
      cells.push(
        el("td", { className: biasClass(e.selfBias, e.selfBiasSufficient) },
          formatBias(e.selfBias, e.selfBiasSufficient)),
      );
    }

    if (hasPosBias) {
      cells.push(
        el("td", { className: biasClass(e.positionBias, e.positionBiasSufficient) },
          formatBias(e.positionBias, e.positionBiasSufficient)),
      );
    }

    const statusCls = e.status === "pruned" ? "bias-high" : "bias-low";
    cells.push(el("td", { className: statusCls }, e.status));

    tbody.appendChild(el("tr", { className: rowCls }, ...cells));
  });

  table.appendChild(tbody);
  const wrapper = el("div", { className: "table-scroll" });
  wrapper.appendChild(table);
  return wrapper;
}
