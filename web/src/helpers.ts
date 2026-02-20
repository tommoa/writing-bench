import type { SampleMeta, SampleContent, FeedbackMeta, FeedbackContent, ModelSpeed, JudgmentMeta } from "./types.js";
import type { PairwiseJudgment } from "../../src/types.js";

// ── DOM helpers ─────────────────────────────────────

export type Attrs = Record<string, string | boolean | ((e: Event) => void) | null>;

export const $ = (sel: string, ctx: ParentNode = document): Element | null =>
  ctx.querySelector(sel);

export const $$ = (sel: string, ctx: ParentNode = document): Element[] => [
  ...ctx.querySelectorAll(sel),
];

export function el(
  tag: string,
  attrs: Attrs = {},
  ...children: Array<string | Node | null>
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "className" && typeof v === "string") node.className = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "innerHTML" && typeof v === "string") node.innerHTML = v;
    else if (typeof v === "boolean") {
      if (v) node.setAttribute(k, "");
      else node.removeAttribute(k);
    } else if (typeof v === "string") node.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  }
  return node;
}

// ── Rendering ───────────────────────────────────────

export function render(content: string | Node): void {
  const app = $("#app")!;
  app.innerHTML = "";
  if (typeof content === "string") app.innerHTML = content;
  else app.appendChild(content);
}

export function renderError(msg: string): void {
  render(`<div id="error">${msg}</div>`);
}

// ── Formatters ──────────────────────────────────────

export function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatSpeed(tps: number): string {
  if (tps >= 100) return `${Math.round(tps)}`;
  if (tps >= 10) return tps.toFixed(1);
  return tps.toFixed(2);
}

// ── Sample / Feedback metadata display ──────────────

/** Render usage/cost/latency for a sample. Needs content from Tier 2. */
export function sampleMetaEl(meta: SampleMeta, content?: SampleContent): HTMLElement {
  if (!content) {
    return el("p", { className: "muted small mt-1" }, meta.fromCache ? "[cached]" : "");
  }
  const tokens = content.usage.inputTokens + content.usage.outputTokens;
  if (meta.fromCache) {
    return el("p", { className: "muted small mt-1" }, `${tokens} tokens | [cached]`);
  }
  const cachePart = content.usage.cacheReadTokens
    ? ` (${content.usage.cacheReadTokens} cached)`
    : "";
  const uncachedPart =
    content.cost.totalUncached != null &&
    content.cost.totalUncached > content.cost.total + 0.00005
      ? ` (uncached: $${content.cost.totalUncached.toFixed(4)})`
      : "";
  return el(
    "p",
    { className: "muted small mt-1" },
    `${tokens} tokens${cachePart} | $${content.cost.total.toFixed(4)}${uncachedPart} | ${(content.latencyMs / 1000).toFixed(1)}s`,
  );
}

/** Render usage/cost/latency for feedback. Needs content from Tier 2. */
export function feedbackMetaEl(meta: FeedbackMeta, content?: FeedbackContent): HTMLElement {
  if (!content) {
    return el("p", { className: "muted small mt-1" }, meta.fromCache ? "[cached]" : "");
  }
  const tokens = content.usage
    ? content.usage.inputTokens + content.usage.outputTokens
    : 0;
  if (meta.fromCache) {
    return el("p", { className: "muted small mt-1" }, `${tokens} tokens | [cached]`);
  }
  const cost = content.cost ? content.cost.total : 0;
  const latency = content.latencyMs ? (content.latencyMs / 1000).toFixed(1) : "?";
  return el(
    "p",
    { className: "muted small mt-1" },
    `${tokens} tokens | $${cost.toFixed(4)} | ${latency}s`,
  );
}

// ── Judge quality formatters ────────────────────────

/** Format a judge weight as "0.45x". */
export function formatWeight(n: number): string {
  return `${n.toFixed(2)}x`;
}

/** Format a bias value as "+12%" / "-3%" / "..." / "--". */
export function formatBias(n: number | null, sufficient: boolean): string {
  if (n == null) return "--";
  if (!sufficient) return "...";
  const pct = Math.round(n * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

/** Return a CSS class for bias severity coloring. */
export function biasClass(n: number | null, sufficient: boolean): string {
  if (n == null || !sufficient) return "muted";
  const abs = Math.abs(n);
  if (abs < 0.05) return "bias-low";
  if (abs < 0.15) return "bias-moderate";
  return "bias-high";
}

// ── Stage label mapping ─────────────────────────────

export const STAGE_LABELS: Record<string, string> = {
  initial: "Write",
  initialJudging: "Judge",
  feedback: "Feedback",
  revised: "Revise",
  revisedJudging: "Re-Judge",
};

// ── Unified ELO table ───────────────────────────────

export interface EloTableOpts {
  /** Which stage cost columns to show. */
  costStages?: string[];
  /** Per-model per-stage cost map (used when costs aren't inline on the rating). */
  costByModelByStage?: Record<string, Record<string, number>>;
  /** Per-model per-stage token map. */
  tokensByModelByStage?: Record<string, Record<string, number>>;
  /** Per-model speed data. */
  speedByModel?: Record<string, ModelSpeed>;
  /** Show W/L/T instead of Matches (for per-run tables with EloRating data). */
  wlt?: (r: { model: string }) => string;
  /** Add "sortable" CSS class to the ELO header. */
  sortableElo?: boolean;
}

/**
 * Render an ELO table with optional cost, token, and speed columns.
 *
 * Works for both dashboard (EloEntry with inline costs) and run detail
 * (EloRating with external cost maps). The caller resolves costs into
 * the `costByModelByStage` / `tokensByModelByStage` opts, or lets
 * inline `costByStage` / `tokensByStage` on the rating objects be used
 * as a fallback.
 */
export function renderEloTable(
  ratings: Array<{
    model: string;
    rating: number;
    matchCount: number;
    ci95?: number;
    costByStage?: Record<string, number>;
    tokensByStage?: Record<string, number>;
  }>,
  opts: EloTableOpts = {},
): HTMLElement {
  const table = el("table");

  const costMbms = opts.costByModelByStage ?? {};
  const tokenMbms = opts.tokensByModelByStage ?? {};

  function getCost(model: string, stage: string): number {
    return costMbms[model]?.[stage] ?? 0;
  }
  function getTokens(model: string, stage: string): number {
    return tokenMbms[model]?.[stage] ?? 0;
  }

  // For ratings with inline cost/token data (EloEntry), fall back
  // to inline values if external maps are empty.
  const useInlineCosts = Object.keys(costMbms).length === 0;
  const useInlineTokens = Object.keys(tokenMbms).length === 0;

  function getCostForRating(
    r: { model: string; costByStage?: Record<string, number> },
    stage: string,
  ): number {
    if (useInlineCosts) return r.costByStage?.[stage] ?? 0;
    return getCost(r.model, stage);
  }
  function getTokensForRating(
    r: { model: string; tokensByStage?: Record<string, number> },
    stage: string,
  ): number {
    if (useInlineTokens) return r.tokensByStage?.[stage] ?? 0;
    return getTokens(r.model, stage);
  }

  const visibleStages = (opts.costStages ?? [])
    .filter((key) => ratings.some((r) =>
      getCostForRating(r, key) > 0 || getTokensForRating(r, key) > 0,
    ))
    .map((key) => ({ key, label: STAGE_LABELS[key] ?? key }));
  const hasCosts = visibleStages.length > 0 &&
    ratings.some((r) => visibleStages.some((s) => getCostForRating(r, s.key) > 0));
  const hasTokens = visibleStages.length > 0 &&
    ratings.some((r) => visibleStages.some((s) => getTokensForRating(r, s.key) > 0));
  const hasSpeed = opts.speedByModel != null && Object.keys(opts.speedByModel).length > 0;
  const hasCi = ratings.some((r) => r.ci95 != null);

  const headerCells = [
    el("th", { className: "rank" }, "#"),
    el("th", {}, "Model"),
    el("th", opts.sortableElo ? { className: "sortable" } : {}, "ELO"),
  ];
  if (hasCi) {
    headerCells.push(el("th", {
      className: "ci ci-toggle",
      onClick: () => table.classList.toggle("show-ci-range"),
    }, "\u00b1CI"));
  }
  headerCells.push(el("th", {}, opts.wlt ? "W/L/T" : "Matches"));
  if (hasCosts) {
    for (const s of visibleStages) {
      headerCells.push(el("th", { className: "cost" }, s.label));
    }
  }
  if (hasTokens) {
    for (const s of visibleStages) {
      headerCells.push(el("th", {}, `${s.label} Tokens`));
    }
  }
  if (hasSpeed) {
    headerCells.push(el("th", {}, "Speed"));
  }

  table.appendChild(el("thead", {}, el("tr", {}, ...headerCells)));

  const tbody = el("tbody");
  ratings.forEach((r, i) => {
    const cls =
      i === 0
        ? "rating top"
        : i === ratings.length - 1
          ? "rating bottom"
          : "rating";

    const cells = [
      el("td", { className: "rank" }, String(i + 1)),
      el("td", {}, r.model),
      el("td", { className: cls }, String(r.rating)),
    ];
    if (hasCi) {
      if (r.ci95 != null) {
        const lo = Math.round(r.rating - r.ci95);
        const hi = Math.round(r.rating + r.ci95);
        cells.push(el("td", { className: "ci" },
          el("span", { className: "ci-pm" }, `\u00b1${r.ci95}`),
          el("span", { className: "ci-range" }, `${lo}\u2013${hi}`),
        ));
      } else {
        cells.push(el("td", { className: "ci" }, "-"));
      }
    }
    cells.push(
      opts.wlt
        ? el("td", { className: "wlt" }, opts.wlt(r))
        : el("td", { className: "muted" }, String(r.matchCount)),
    );
    if (hasCosts) {
      for (const s of visibleStages) {
        const c = getCostForRating(r, s.key);
        cells.push(
          el("td", { className: "cost" }, c > 0 ? `$${c.toFixed(4)}` : "-"),
        );
      }
    }
    if (hasTokens) {
      for (const s of visibleStages) {
        const t = getTokensForRating(r, s.key);
        cells.push(
          el("td", { className: "muted" }, t > 0 ? t.toLocaleString() : "-"),
        );
      }
    }
    if (hasSpeed && opts.speedByModel) {
      const speed = opts.speedByModel[r.model];
      const speedStr = speed
        ? `${formatSpeed(speed.tokensPerSecond)} tok/s`
        : "-";
      cells.push(el("td", { className: "speed" }, speedStr));
    }
    tbody.appendChild(el("tr", {}, ...cells));
  });
  table.appendChild(tbody);
  const wrapper = el("div", { className: "table-scroll" });
  wrapper.appendChild(table);
  return wrapper;
}

// ── Cost item ───────────────────────────────────────

/** Build sample-to-model lookup maps from manifest sample metadata. */
export function buildSampleMaps(samples: SampleMeta[]): {
  sampleToModel: Map<string, string>;
  revisedSampleToModel: Map<string, string>;
  sampleToFeedbackModel: Map<string, string>;
} {
  const sampleToModel = new Map<string, string>();
  const revisedSampleToModel = new Map<string, string>();
  const sampleToFeedbackModel = new Map<string, string>();

  for (const s of samples) {
    if (s.stage === "initial") {
      sampleToModel.set(s.id, s.model);
    } else {
      revisedSampleToModel.set(s.id, s.model);
      if (s.feedbackModel) {
        sampleToFeedbackModel.set(s.id, s.feedbackModel);
      }
    }
  }

  return { sampleToModel, revisedSampleToModel, sampleToFeedbackModel };
}

/** Convert lean JudgmentMeta[] (from manifest) to PairwiseJudgment[] for engine functions. */
export function judgmentMetaToPairwise(judgments: JudgmentMeta[]): PairwiseJudgment[] {
  return judgments.map((j, i) => ({
    ...j,
    id: `j-${i}`,
    reasoning: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: { input: 0, output: 0, total: 0, totalUncached: 0 },
    latencyMs: 0,
  }));
}

export function renderCostItem(label: string, value: string): HTMLElement {
  return el(
    "div",
    { className: "cost-item" },
    el("div", { className: "label" }, label),
    el("div", { className: "value" }, value),
  );
}

// ── Section descriptions ────────────────────────────

/** Shared description strings for ELO sections. */
export const SECTION_DESC = {
  writerElo:
    "Cumulative head-to-head writing quality across all runs. " +
    "Two outputs for the same prompt are compared by a judge; " +
    "the preferred one wins. Elo (higher = better), " +
    "\u00b1CI is the 95% confidence interval " +
    "-- click to toggle range display.",
  initialWriterElo:
    "Head-to-head writing quality from this run's initial outputs. " +
    "Elo (higher = better), \u00b1CI is the 95% confidence " +
    "interval -- click to toggle range display.",
  revisedElo:
    "Head-to-head quality of revised outputs, scoped by feedback " +
    "source to isolate writing ability from feedback quality.",
  feedbackElo:
    "How useful each model's editorial feedback is, measured " +
    "indirectly through the improvement it produces in revised outputs.",
  judgeQuality:
    "Judge reliability estimated via cross-evaluation consensus. " +
    "Higher-rated judges contribute more to Elo computation.",
  eloByTag:
    "Ratings filtered by prompt category. Expand a tag to see " +
    "how models perform on that subset.",
};

/** Create a description paragraph for use below section headings. */
export function sectionDesc(text: string): HTMLElement {
  return el("p", { className: "section-desc" }, text);
}
