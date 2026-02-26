import type { RunsIndex, RunIndexEntry, TagAlternatives } from "./types.js";
import { el, render, formatDate, sectionDesc, SECTION_DESC } from "./helpers.js";
import { modelLogo } from "./model-logos.js";
import { renderJudgeQualitySection } from "./judge-quality.js";
import { createRatingToggle } from "./rating-toggle.js";
import { createRatingSettings } from "./rating-settings.js";
import { clearRatingSubscribers, fetchTagAlternatives } from "./state.js";

// ── Dashboard ───────────────────────────────────────

export function renderDashboard(index: RunsIndex): void {
  // Clear stale subscribers from previous page renders
  clearRatingSubscribers();

  const frag = document.createDocumentFragment();

  // Unified rating settings (no custom tab on dashboard -- no manifest)
  frag.appendChild(createRatingSettings({
    alternativeRatings: index.cumulativeAlternativeRatings,
  }));

  if (index.runs.length > 0) {
    frag.appendChild(el("div", { className: "callout-card" },
      "Individual runs contain per-prompt outputs, head-to-head " +
      "comparisons, full judgment reasoning, and custom rating " +
      "controls. ",
      el("a", { href: "?page=runs" }, "View all runs \u2192"),
    ));
  }

  const commonEloOpts = {
    sortableElo: true,
    modelFamilies: index.modelFamilies,
  };

  appendCumulativeSection(
    frag,
    "Initial Writer ELO",
    SECTION_DESC.cumulativeInitialWriterElo,
    index.cumulativeElo.initialWriting,
    "initial",
    "initial",
    index,
    commonEloOpts,
  );
  appendCumulativeSection(
    frag,
    "Revised Writer ELO",
    SECTION_DESC.revisedElo,
    index.cumulativeElo.revisedWriting,
    "revised",
    "revised",
    index,
    commonEloOpts,
    "No cumulative revised-writer judgments are available yet.",
  );
  appendCumulativeSection(
    frag,
    "Feedback Provider ELO",
    SECTION_DESC.feedbackElo,
    index.cumulativeElo.feedback,
    "feedback",
    "feedback",
    index,
    commonEloOpts,
  );

  // Cumulative judge quality (collapsed by default, lazy DOM on expand)
  if (index.cumulativeJudgeQuality && index.cumulativeJudgeQuality.length > 0) {
    frag.appendChild(el("h2", {}, "Judge Quality"));
    frag.appendChild(sectionDesc(SECTION_DESC.judgeQuality));
    const jqDetails = el("details");
    jqDetails.appendChild(el("summary", {}, "Judge Quality"));
    const jqInner = el("div", { className: "details-content" });
    jqDetails.appendChild(jqInner);

    let jqLoaded = false;
    jqDetails.addEventListener("toggle", () => {
      if (!(jqDetails as HTMLDetailsElement).open || jqLoaded) return;
      jqLoaded = true;
      const jqSection = renderJudgeQualitySection(
        index.cumulativeJudgeQuality!, "Cumulative Judge Quality",
      );
      if (jqSection) jqInner.appendChild(jqSection);
    });

    frag.appendChild(jqDetails);
  }

  let tagAlternativesPromise: Promise<TagAlternatives | undefined> | undefined;
  const loadTagAlternatives = (): Promise<TagAlternatives | undefined> => {
    tagAlternativesPromise ??= fetchTagAlternatives().catch(() => undefined);
    return tagAlternativesPromise;
  };

  appendTagSection(
    frag,
    "Initial ELO by Tag",
    index.cumulativeElo.initialByTag,
    "initial",
    "initial",
    commonEloOpts,
    loadTagAlternatives,
  );
  appendTagSection(
    frag,
    "Revised ELO by Tag",
    index.cumulativeElo.revisedByTag,
    "revised",
    "revised",
    commonEloOpts,
    loadTagAlternatives,
  );

  if (index.eloHistory.length > 1) {
    frag.appendChild(el("h2", {}, "ELO History"));
    frag.appendChild(renderSparklines(index.eloHistory, index.modelFamilies));
  }

  if (index.runs.length > 0) {
    frag.appendChild(el("h2", {}, "Recent Runs"));
    frag.appendChild(renderRunList(index.runs));
  }

  if (
    index.runs.length === 0
    && index.cumulativeElo.initialWriting.length === 0
    && index.cumulativeElo.revisedWriting.length === 0
  ) {
    frag.appendChild(
      el(
        "p",
        { className: "muted mt-2" },
        "No benchmark data yet. Run a benchmark and export results.",
      ),
    );
  }

  render(frag);
}

function appendCumulativeSection(
  frag: DocumentFragment,
  title: string,
  description: string,
  ratings: RunsIndex["cumulativeElo"]["initialWriting"],
  dimension: "initial" | "revised" | "feedback",
  costStage: "initial" | "revised" | "feedback",
  index: RunsIndex,
  commonEloOpts: {
    sortableElo: boolean;
    modelFamilies: RunsIndex["modelFamilies"];
  },
  emptyMessage?: string,
): void {
  if (ratings.length === 0 && !emptyMessage) return;
  frag.appendChild(el("h2", {}, title));
  frag.appendChild(sectionDesc(description));
  if (ratings.length === 0) {
    frag.appendChild(el("p", { className: "muted mt-2" }, emptyMessage ?? "No ratings available."));
    return;
  }
  frag.appendChild(createRatingToggle({
    defaultRatings: ratings,
    alternativeRatings: index.cumulativeAlternativeRatings,
    dimension,
    eloTableOpts: {
      ...commonEloOpts,
      costStages: [costStage],
    },
  }).container);
}

function appendTagSection(
  frag: DocumentFragment,
  title: string,
  byTag: RunsIndex["cumulativeElo"]["initialByTag"] | RunsIndex["cumulativeElo"]["revisedByTag"],
  dimension: "initial" | "revised",
  costStage: "initial" | "revised",
  commonEloOpts: {
    sortableElo: boolean;
    modelFamilies: RunsIndex["modelFamilies"];
  },
  loadTagAlternatives: () => Promise<TagAlternatives | undefined>,
): void {
  if (!byTag || Object.keys(byTag).length === 0) return;
  frag.appendChild(el("h2", {}, title));
  frag.appendChild(sectionDesc(SECTION_DESC.eloByTag));

  for (const [cat, ratings] of Object.entries(byTag)) {
    const details = el("details");
    details.appendChild(el("summary", {}, cat));
    const inner = el("div", { className: "details-content" });
    details.appendChild(inner);

    let loaded = false;
    details.addEventListener("toggle", async () => {
      if (!(details as HTMLDetailsElement).open || loaded) return;
      loaded = true;
      const tagAlts = await loadTagAlternatives();
      inner.appendChild(createRatingToggle({
        defaultRatings: ratings,
        dimension,
        tagFilter: cat,
        tagAlternatives: tagAlts,
        eloTableOpts: {
          ...commonEloOpts,
          costStages: [costStage],
        },
      }).container);
    });

    frag.appendChild(details);
  }
}

// ── Sparklines ──────────────────────────────────────

export function renderSparklines(
  history: RunsIndex["eloHistory"],
  modelFamilies?: Record<string, string>,
): HTMLElement {
  const container = el("div");
  const models = new Set<string>();
  history.forEach((h) =>
    Object.keys(h.ratings).forEach((m) => models.add(m)),
  );

  for (const model of models) {
    const values = history
      .map((h) => h.ratings[model])
      .filter((v): v is number => v != null);
    if (values.length < 2) continue;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = 120,
      h = 30,
      pad = 2;

    const points = values.map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
      const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
      return `${x},${y}`;
    });

    const svg = `<svg viewBox="0 0 ${w} ${h}"><path d="M${points.join("L")}"/></svg>`;
    const logo = modelLogo(modelFamilies?.[model]);
    container.appendChild(
      el(
        "div",
        { className: "mb-1" },
        el("span", { className: "sparkline-label" }, logo, model + " "),
        el("span", { className: "sparkline", innerHTML: svg }),
        el("span", { className: "muted small" }, ` ${values[values.length - 1]}`),
      ),
    );
  }
  return container;
}

// ── Run list ────────────────────────────────────────

export function renderRunList(runs: RunIndexEntry[]): HTMLElement {
  const list = el("ul", { className: "run-list" });
  for (const run of runs) {
    const link = el("a", { href: `?run=${run.id}` }, formatDate(run.timestamp));
    const costText = run.totalCostUncached != null
      ? `$${run.totalCost.toFixed(4)} (actual) · $${run.totalCostUncached.toFixed(4)} (est uncached)`
      : `$${run.totalCost.toFixed(4)} (actual)`;
    const meta = el(
      "span",
      { className: "run-meta" },
      `${run.models.length} model${run.models.length !== 1 ? "s" : ""} \u00b7 ${run.promptCount} prompts \u00b7 ${costText}`,
    );
    list.appendChild(el("li", {}, link, meta));
  }
  return list;
}

// ── Runs page ───────────────────────────────────────

export function renderRunsPage(index: RunsIndex): void {
  const frag = document.createDocumentFragment();
  frag.appendChild(el("h2", {}, "All Runs"));
  if (index.runs.length > 0) {
    frag.appendChild(renderRunList(index.runs));
  } else {
    frag.appendChild(
      el(
        "p",
        { className: "muted mt-2" },
        "No runs yet. Run a benchmark and export results.",
      ),
    );
  }
  render(frag);
}
