import type { RunsIndex, RunIndexEntry, TagAlternatives } from "./types.js";
import { el, render, renderEloTable, formatDate } from "./helpers.js";
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

  if (index.cumulativeElo.writing.length > 0) {
    frag.appendChild(el("h2", {}, "Writer ELO"));
    frag.appendChild(createRatingToggle({
      defaultRatings: index.cumulativeElo.writing,
      alternativeRatings: index.cumulativeAlternativeRatings,
      dimension: "initial",
      eloTableOpts: {
        costStages: ["initial", "revised"],
        sortableElo: true,
      },
    }).container);
  }

  if (index.cumulativeElo.feedback.length > 0) {
    frag.appendChild(el("h2", {}, "Feedback Provider ELO"));
    frag.appendChild(createRatingToggle({
      defaultRatings: index.cumulativeElo.feedback,
      alternativeRatings: index.cumulativeAlternativeRatings,
      dimension: "feedback",
      eloTableOpts: {
        costStages: ["feedback"],
        sortableElo: true,
      },
    }).container);
  }

  // Cumulative judge quality (collapsed by default, lazy DOM on expand)
  if (index.cumulativeJudgeQuality && index.cumulativeJudgeQuality.length > 0) {
    frag.appendChild(el("h2", {}, "Judge Quality"));
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

  if (
    index.cumulativeElo.byTag &&
    Object.keys(index.cumulativeElo.byTag).length > 0
  ) {
    frag.appendChild(el("h2", {}, "ELO by Tag"));
    for (const [cat, ratings] of Object.entries(
      index.cumulativeElo.byTag
    )) {
      const d = el("details");
      d.appendChild(el("summary", {}, cat));
      const inner = el("div", { className: "details-content" });
      d.appendChild(inner);

      let loaded = false;
      d.addEventListener("toggle", async () => {
        if (!(d as HTMLDetailsElement).open || loaded) return;
        loaded = true;

        // Lazy-load per-tag alternatives (cached after first fetch)
        let tagAlts: TagAlternatives | undefined;
        try {
          tagAlts = await fetchTagAlternatives();
        } catch {
          // File may not exist for old exports -- degrade to default only
        }

        inner.appendChild(createRatingToggle({
          defaultRatings: ratings,
          dimension: "initial",
          tagFilter: cat,
          tagAlternatives: tagAlts,
          eloTableOpts: {
            costStages: ["initial", "revised"],
            sortableElo: true,
          },
        }).container);
      });

      frag.appendChild(d);
    }
  }

  if (index.eloHistory.length > 1) {
    frag.appendChild(el("h2", {}, "ELO History"));
    frag.appendChild(renderSparklines(index.eloHistory));
  }

  if (index.runs.length > 0) {
    frag.appendChild(el("h2", {}, "Recent Runs"));
    frag.appendChild(renderRunList(index.runs));
  }

  if (index.runs.length === 0 && index.cumulativeElo.writing.length === 0) {
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

// ── Sparklines ──────────────────────────────────────

export function renderSparklines(
  history: RunsIndex["eloHistory"],
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
    container.appendChild(
      el(
        "div",
        { className: "mb-1" },
        el("span", {}, model + " "),
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
    const meta = el(
      "span",
      { className: "run-meta" },
      `${run.models.join(", ")} | ${run.promptCount} prompts | $${(run.totalCostUncached ?? run.totalCost).toFixed(4)}`,
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
