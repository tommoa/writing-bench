import type { RunsIndex, RunIndexEntry } from "./types.js";
import { el, render, renderEloTable, formatDate } from "./helpers.js";

// ── Dashboard ───────────────────────────────────────

export function renderDashboard(index: RunsIndex): void {
  const frag = document.createDocumentFragment();

  if (index.cumulativeElo.writing.length > 0) {
    frag.appendChild(el("h2", {}, "Writer ELO"));
    frag.appendChild(renderEloTable(index.cumulativeElo.writing, {
      costStages: ["initial", "revised"],
      sortableElo: true,
    }));
  }

  if (index.cumulativeElo.feedback.length > 0) {
    frag.appendChild(el("h2", {}, "Feedback Provider ELO"));
    frag.appendChild(renderEloTable(index.cumulativeElo.feedback, {
      costStages: ["feedback"],
      sortableElo: true,
    }));
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
      d.appendChild(
        el("div", { className: "details-content" }, renderEloTable(ratings, {
          costStages: ["initial", "revised"],
          sortableElo: true,
        }))
      );
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
