import type {
  RunsIndex,
  RunResult,
  RunIndexEntry,
  EloRating,
  EloEntry,
  WritingSample,
  Feedback,
  PairwiseJudgment,
  PromptConfig,
  ModelSpeed,
} from "./types.js";

// ── DOM helpers ─────────────────────────────────────

type Attrs = Record<string, string | boolean | ((e: Event) => void) | null>;

const $ = (sel: string, ctx: ParentNode = document): Element | null =>
  ctx.querySelector(sel);

const $$ = (sel: string, ctx: ParentNode = document): Element[] => [
  ...ctx.querySelectorAll(sel),
];

function el(
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
    else if (typeof v === "string") node.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  }
  return node;
}

// ── State ───────────────────────────────────────────

interface AppState {
  index: RunsIndex | null;
}

const state: AppState = { index: null };

// Cross-section judgment filter API — set by renderJudgmentsSection,
// called by "view judgments" buttons in output sections.
let judgmentApi: {
  focusSample: (sampleId: string) => void;
  focusModel: (model: string) => void;
} | null = null;

// ── Router ──────────────────────────────────────────

interface Page {
  page: "dashboard" | "runs" | "run" | "methodology";
  id?: string;
}

function getPage(): Page {
  const params = new URLSearchParams(location.search);
  const runId = params.get("run");
  if (runId) return { page: "run", id: runId };
  if (params.get("page") === "runs") return { page: "runs" };
  if (params.get("page") === "methodology") return { page: "methodology" };
  return { page: "dashboard" };
}

// ── Data fetching ───────────────────────────────────

async function fetchIndex(): Promise<RunsIndex> {
  const res = await fetch("data/runs.json");
  if (!res.ok)
    throw new Error("No data found. Run a benchmark and export first.");
  return res.json();
}

async function fetchRun(id: string): Promise<RunResult> {
  const res = await fetch(`data/runs/${id}.json`);
  if (!res.ok) throw new Error(`Run ${id} not found`);
  return res.json();
}

// ── Rendering ───────────────────────────────────────

function render(content: string | Node): void {
  const app = $("#app")!;
  app.innerHTML = "";
  if (typeof content === "string") app.innerHTML = content;
  else app.appendChild(content);
}

function renderError(msg: string): void {
  render(`<div id="error">${msg}</div>`);
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSpeed(tps: number): string {
  if (tps >= 100) return `${Math.round(tps)}`;
  if (tps >= 10) return tps.toFixed(1);
  return tps.toFixed(2);
}

function sampleMeta(s: WritingSample): HTMLElement {
  const tokens = s.usage.inputTokens + s.usage.outputTokens;
  if (s.fromCache) {
    return el("p", { className: "muted small mt-1" }, `${tokens} tokens | [cached]`);
  }
  const cachePart = s.usage.cacheReadTokens
    ? ` (${s.usage.cacheReadTokens} cached)`
    : "";
  const uncachedPart =
    s.cost.totalUncached != null &&
    s.cost.totalUncached > s.cost.total + 0.00005
      ? ` (uncached: $${s.cost.totalUncached.toFixed(4)})`
      : "";
  return el(
    "p",
    { className: "muted small mt-1" },
    `${tokens} tokens${cachePart} | $${s.cost.total.toFixed(4)}${uncachedPart} | ${(s.latencyMs / 1000).toFixed(1)}s`
  );
}

function feedbackMeta(fb: Feedback): HTMLElement {
  const tokens = fb.usage
    ? fb.usage.inputTokens + fb.usage.outputTokens
    : 0;
  if (fb.fromCache) {
    return el("p", { className: "muted small mt-1" }, `${tokens} tokens | [cached]`);
  }
  const cost = fb.cost ? fb.cost.total : 0;
  const latency = fb.latencyMs ? (fb.latencyMs / 1000).toFixed(1) : "?";
  return el(
    "p",
    { className: "muted small mt-1" },
    `${tokens} tokens | $${cost.toFixed(4)} | ${latency}s`
  );
}

// ── Dashboard ───────────────────────────────────────

function renderDashboard(index: RunsIndex): void {
  const frag = document.createDocumentFragment();

  if (index.cumulativeElo.writing.length > 0) {
    frag.appendChild(el("h2", {}, "Writer ELO"));
    frag.appendChild(renderEloTable(index.cumulativeElo.writing));
  }

  if (index.cumulativeElo.feedback.length > 0) {
    frag.appendChild(el("h2", {}, "Feedback Provider ELO"));
    frag.appendChild(renderEloTable(index.cumulativeElo.feedback));
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
        el("div", { className: "details-content" }, renderEloTable(ratings))
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
        "No benchmark data yet. Run a benchmark and export results."
      )
    );
  }

  render(frag);
}

function renderEloTable(ratings: EloEntry[]): HTMLElement {
  const table = el("table");
  table.appendChild(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { className: "rank" }, "#"),
        el("th", {}, "Model"),
        el("th", { className: "sortable" }, "ELO"),
        el("th", {}, "Matches")
      )
    )
  );
  const tbody = el("tbody");
  ratings.forEach((r, i) => {
    const cls =
      i === 0
        ? "rating top"
        : i === ratings.length - 1
          ? "rating bottom"
          : "rating";
    tbody.appendChild(
      el(
        "tr",
        {},
        el("td", { className: "rank" }, String(i + 1)),
        el("td", {}, r.model),
        el("td", { className: cls }, String(r.rating)),
        el("td", { className: "muted" }, String(r.matchCount))
      )
    );
  });
  table.appendChild(tbody);
  return table;
}

function renderSparklines(
  history: RunsIndex["eloHistory"]
): HTMLElement {
  const container = el("div");
  const models = new Set<string>();
  history.forEach((h) =>
    Object.keys(h.ratings).forEach((m) => models.add(m))
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
        el("span", { className: "muted small" }, ` ${values[values.length - 1]}`)
      )
    );
  }
  return container;
}

function renderRunList(runs: RunIndexEntry[]): HTMLElement {
  const list = el("ul", { className: "run-list" });
  for (const run of runs) {
    const link = el("a", { href: `?run=${run.id}` }, formatDate(run.timestamp));
    const meta = el(
      "span",
      { className: "run-meta" },
      `${run.models.join(", ")} | ${run.promptCount} prompts | $${run.totalCost.toFixed(4)}`
    );
    list.appendChild(el("li", {}, link, meta));
  }
  return list;
}

function renderRunsPage(index: RunsIndex): void {
  const frag = document.createDocumentFragment();
  frag.appendChild(el("h2", {}, "All Runs"));
  if (index.runs.length > 0) {
    frag.appendChild(renderRunList(index.runs));
  } else {
    frag.appendChild(
      el(
        "p",
        { className: "muted mt-2" },
        "No runs yet. Run a benchmark and export results."
      )
    );
  }
  render(frag);
}

// ── Run Detail ──────────────────────────────────────

function renderRunDetail(run: RunResult): void {
  const frag = document.createDocumentFragment();

  frag.appendChild(el("p", {}, el("a", { href: "?" }, "< back to leaderboard")));
  frag.appendChild(el("h2", {}, `Run: ${formatDate(run.config.timestamp)}`));

  // Run info: writers and judges
  const writerLabels = run.config.models.map((m) => m.label).join(", ");
  if (run.config.judges && run.config.judges.length > 0) {
    const judgeLabels = run.config.judges.map((m) => m.label).join(", ");
    frag.appendChild(
      el("p", { className: "muted" }, `Writers: ${writerLabels} | Judges: ${judgeLabels}`)
    );
  } else {
    frag.appendChild(
      el("p", { className: "muted" }, `Models: ${writerLabels}`)
    );
  }

  // ELO tables
  frag.appendChild(el("h2", {}, "Initial Writer ELO"));
  frag.appendChild(renderRunEloTable(run.elo.initial.ratings));

  frag.appendChild(el("h2", {}, "Revised Writer ELO"));
  frag.appendChild(renderRunEloTable(run.elo.revised.ratings));

  if (
    run.elo.revised.feedbackRatings &&
    run.elo.revised.feedbackRatings.length > 0
  ) {
    frag.appendChild(el("h2", {}, "Feedback Provider ELO"));
    frag.appendChild(renderRunEloTable(run.elo.revised.feedbackRatings));
  }

  // ELO by category
  if (
    run.elo.initial.byTag &&
    Object.keys(run.elo.initial.byTag).length > 0
  ) {
    frag.appendChild(el("h2", {}, "ELO by Tag"));
    for (const [cat, ratings] of Object.entries(run.elo.initial.byTag)) {
      const d = el("details");
      d.appendChild(el("summary", {}, cat));
      const inner = el("div", { className: "details-content" });
      inner.appendChild(el("h4", {}, "Initial"));
      inner.appendChild(renderRunEloTable(ratings));
      if (run.elo.revised.byTag?.[cat]) {
        inner.appendChild(el("h4", {}, "Revised"));
        inner.appendChild(
          renderRunEloTable(run.elo.revised.byTag[cat])
        );
      }
      d.appendChild(inner);
      frag.appendChild(d);
    }
  }

  // Per-prompt sections with filter
  const promptHeader = el("div", { className: "section-header" });
  promptHeader.appendChild(el("h2", {}, "Outputs by Prompt"));

  const promptFilterSelect = document.createElement("select");
  promptFilterSelect.className = "prompt-filter-select";
  promptFilterSelect.appendChild(new Option("All prompts", "all"));
  const tags = [...new Set(run.config.prompts.flatMap((p) => p.tags))].sort();
  if (tags.length > 1) {
    for (const tag of tags) {
      promptFilterSelect.appendChild(new Option(`Tag: ${tag}`, `tag:${tag}`));
    }
  }
  for (const p of run.config.prompts) {
    promptFilterSelect.appendChild(new Option(p.name, `id:${p.id}`));
  }
  promptHeader.appendChild(promptFilterSelect);
  frag.appendChild(promptHeader);

  const promptSections = el("div", { id: "prompt-sections" });
  for (const prompt of run.config.prompts) {
    const section = renderPromptSection(run, prompt);
    section.setAttribute("data-prompt-id", prompt.id);
    section.setAttribute("data-prompt-tags", prompt.tags.join(","));
    promptSections.appendChild(section);
  }
  frag.appendChild(promptSections);

  promptFilterSelect.addEventListener("change", () => {
    const val = promptFilterSelect.value;
    for (const child of $$("[data-prompt-id]", promptSections)) {
      if (val === "all") {
        (child as HTMLElement).style.display = "";
      } else if (val.startsWith("tag:")) {
        const tag = val.slice(4);
        const childTags = (child.getAttribute("data-prompt-tags") ?? "").split(",");
        (child as HTMLElement).style.display =
          childTags.includes(tag) ? "" : "none";
      } else if (val.startsWith("id:")) {
        const id = val.slice(3);
        (child as HTMLElement).style.display =
          child.getAttribute("data-prompt-id") === id ? "" : "none";
      }
    }
  });

  // Judgments section
  frag.appendChild(el("h2", {}, "Judgments"));
  frag.appendChild(renderJudgmentsSection(run));

  // Run metadata
  frag.appendChild(el("h2", {}, "Run Metadata"));
  frag.appendChild(renderRunMetadata(run));

  render(frag);
}

function renderCostItem(label: string, value: string): HTMLElement {
  return el(
    "div",
    { className: "cost-item" },
    el("div", { className: "label" }, label),
    el("div", { className: "value" }, value)
  );
}

function renderRunEloTable(ratings: EloRating[]): HTMLElement {
  const table = el("table");

  table.appendChild(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { className: "rank" }, "#"),
        el("th", {}, "Model"),
        el("th", {}, "ELO"),
        el("th", {}, "W/L/T")
      )
    )
  );

  const tbody = el("tbody");
  ratings.forEach((r, i) => {
    const cls =
      i === 0
        ? "rating top"
        : i === ratings.length - 1
          ? "rating bottom"
          : "rating";
    const wlt = `${r.wins}/${r.losses}/${r.ties}`;

    tbody.appendChild(
      el(
        "tr",
        {},
        el("td", { className: "rank" }, String(i + 1)),
        el("td", {}, r.model),
        el("td", { className: cls }, String(r.rating)),
        el("td", { className: "wlt" }, wlt)
      )
    );
  });
  table.appendChild(tbody);
  return table;
}

// ── Prompt Section ──────────────────────────────────
// Tabs select which model's output to view. The active tab shows the
// initial output, a "view judgments" link, and collapsible feedback
// with revisions nested underneath.
//
// Structure:
//   Prompt "Write a story..."
//   [Tab: Claude | Tab: GPT-4]
//   ┌──────────────────────────────
//   │ [Claude's initial output]
//   │ [view 12 judgments →]
//   │ ├── [▸] Feedback from GPT-4
//   │ │     [feedback text]
//   │ │     └── Claude's revision  [view 8 judgments →]
//   │ ├── [▸] Feedback from Gemini
//   │ │     ...
//   └──────────────────────────────

function renderPromptSection(run: RunResult, prompt: PromptConfig): HTMLElement {
  const outerDetails = el("details");
  outerDetails.appendChild(
    el("summary", {}, `${prompt.name} (${prompt.tags.join(", ")})`)
  );

  const content = el("div", { className: "details-content" });
  content.appendChild(el("p", { className: "muted small" }, prompt.description));

  const initialSamples = run.samples
    .filter((s) => s.promptId === prompt.id && s.stage === "initial")
    .sort((a, b) => a.model.localeCompare(b.model) || a.outputIndex - b.outputIndex);

  if (initialSamples.length === 0) {
    content.appendChild(el("p", { className: "muted" }, "No outputs."));
    outerDetails.appendChild(content);
    return outerDetails;
  }

  const useDropdown = initialSamples.length > 4;
  const panels = el("div");

  // Build labels for each sample
  const sampleLabels = initialSamples.map((sample) => {
    const sameModelCount = initialSamples.filter(
      (s) => s.model === sample.model
    ).length;
    const suffix = sameModelCount > 1 ? ` #${sample.outputIndex + 1}` : "";
    return `${sample.model}${suffix}`;
  });

  function activatePanel(index: number): void {
    $$(".tab-content", panels).forEach((p) => p.classList.remove("active"));
    const tabId = `prompt-${prompt.id}-${index}`;
    $(`#${tabId}`, panels)?.classList.add("active");
  }

  let tabBar: HTMLElement;

  if (useDropdown) {
    // Dropdown mode for many models
    const select = document.createElement("select");
    select.className = "model-select";
    for (let i = 0; i < sampleLabels.length; i++) {
      select.appendChild(new Option(sampleLabels[i], String(i)));
    }
    select.addEventListener("change", () => {
      activatePanel(Number(select.value));
    });
    tabBar = el("div", { className: "tabs tabs-dropdown" });
    tabBar.appendChild(select);
  } else {
    // Tab buttons for few models
    tabBar = el("div", { className: "tabs" });
    for (let i = 0; i < sampleLabels.length; i++) {
      const tab = el(
        "button",
        {
          className: i === 0 ? "tab active" : "tab",
          onClick: () => {
            $$(".tab", tabBar).forEach((t) => t.classList.remove("active"));
            tab.classList.add("active");
            activatePanel(i);
          },
        },
        sampleLabels[i]
      );
      tabBar.appendChild(tab);
    }
  }

  initialSamples.forEach((sample, i) => {
    const tabId = `prompt-${prompt.id}-${i}`;

    const panel = el("div", {
      id: tabId,
      "data-sample-id": sample.id,
      className: i === 0 ? "tab-content active" : "tab-content",
    });

    // Initial output
    panel.appendChild(el("div", { className: "output-text" }, sample.text));
    panel.appendChild(sampleMeta(sample));

    // View judgments for initial output
    const initJudgmentCount = run.judgments.filter(
      (j) => j.sampleA === sample.id || j.sampleB === sample.id
    ).length;
    if (initJudgmentCount > 0) {
      panel.appendChild(
        el(
          "button",
          {
            className: "view-judgments-btn",
            onClick: () => judgmentApi?.focusSample(sample.id),
          },
          `view ${initJudgmentCount} judgments \u2192`
        )
      );
    }

    // Feedback on this output, with revisions nested
    const sampleFeedback = run.feedback
      .filter((f) => f.targetSampleId === sample.id)
      .sort((a, b) => a.sourceModel.localeCompare(b.sourceModel));

    for (const fb of sampleFeedback) {
      const fbDetails = el("details");
      fbDetails.appendChild(
        el("summary", {}, `Feedback from ${fb.sourceModel}`)
      );
      const fbInner = el("div", { className: "details-content" });

      const fbBlock = el("div", { className: "feedback-text" });
      fbBlock.appendChild(document.createTextNode(fb.text));
      fbBlock.appendChild(feedbackMeta(fb));
      fbInner.appendChild(fbBlock);

      // The revision the original writer made using this feedback
      const revision = run.samples.find(
        (s) =>
          s.stage === "revised" &&
          s.feedbackUsed === fb.id &&
          s.promptId === prompt.id
      );
      if (revision) {
        const revBlock = el("div", {
          className: "revision-nested",
          id: `sample-${revision.id}`,
        });
        revBlock.appendChild(
          el(
            "div",
            { className: "muted small" },
            `${revision.model}'s revision:`
          )
        );
        revBlock.appendChild(
          el("div", { className: "output-text" }, revision.text)
        );
        revBlock.appendChild(sampleMeta(revision));

        // View judgments for revision
        const revJudgmentCount = run.judgments.filter(
          (j) => j.sampleA === revision.id || j.sampleB === revision.id
        ).length;
        if (revJudgmentCount > 0) {
          revBlock.appendChild(
            el(
              "button",
              {
                className: "view-judgments-btn",
                onClick: () => judgmentApi?.focusSample(revision.id),
              },
              `view ${revJudgmentCount} judgments \u2192`
            )
          );
        }

        fbInner.appendChild(revBlock);
      }

      fbDetails.appendChild(fbInner);
      panel.appendChild(fbDetails);
    }

    panels.appendChild(panel);
  });

  content.appendChild(tabBar);
  content.appendChild(panels);
  outerDetails.appendChild(content);
  return outerDetails;
}



// ── Navigation utilities ────────────────────────────

/** Open all ancestor <details> elements so the target is visible. */
function openParentDetails(node: Element): void {
  let current = node.parentElement;
  while (current) {
    if (current.tagName === "DETAILS") {
      current.setAttribute("open", "");
    }
    current = current.parentElement;
  }
}

/** Scroll to a sample's output in the prompt section, opening
 *  the right details and activating the right tab. */
function scrollToSample(sampleId: string, run: RunResult): void {
  const sample = run.samples.find((s) => s.id === sampleId);
  if (!sample) return;

  const initialSamples = run.samples
    .filter((s) => s.promptId === sample.promptId && s.stage === "initial")
    .sort((a, b) => a.model.localeCompare(b.model) || a.outputIndex - b.outputIndex);

  let target: Element | null = null;

  if (sample.stage === "initial") {
    const tabIndex = initialSamples.findIndex((s) => s.id === sampleId);
    if (tabIndex === -1) return;
    const tabId = `prompt-${sample.promptId}-${tabIndex}`;
    const panel = $(`#${tabId}`);
    if (!panel) return;

    openParentDetails(panel);
    activateTab(panel, tabIndex);
    target = panel;
  } else {
    // Revised sample — find by id, activate the original's tab
    const revEl = $(`#sample-${sampleId}`);
    if (!revEl) return;

    openParentDetails(revEl);

    if (sample.originalSampleId) {
      const origIndex = initialSamples.findIndex(
        (s) => s.id === sample.originalSampleId
      );
      if (origIndex !== -1) {
        const tabId = `prompt-${sample.promptId}-${origIndex}`;
        const panel = $(`#${tabId}`);
        if (panel) {
          activateTab(panel, origIndex);
        }
      }
    }
    target = revEl;
  }

  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("scroll-highlight");
    target.addEventListener(
      "animationend",
      () => target.classList.remove("scroll-highlight"),
      { once: true }
    );
  }
}

/** Activate the tab at `index` within the tab group containing `panel`. */
function activateTab(panel: Element, index: number): void {
  const panelsContainer = panel.parentElement;
  if (!panelsContainer) return;
  const tabsBar = panelsContainer.previousElementSibling;
  if (tabsBar && tabsBar.classList.contains("tabs")) {
    // Dropdown mode — update the select value
    const select = $("select.model-select", tabsBar);
    if (select) {
      (select as HTMLSelectElement).value = String(index);
    }
    // Tab button mode — toggle active class
    $$(".tab", tabsBar).forEach((t, i) => {
      t.classList.toggle("active", i === index);
    });
  }
  $$(".tab-content", panelsContainer).forEach((p) =>
    p.classList.remove("active")
  );
  panel.classList.add("active");
}

// ── Judgment label helpers ──────────────────────────

interface JudgmentLabels {
  labelA: string;
  labelB: string;
  winnerLabel: string;
}

function buildJudgmentLabel(
  j: PairwiseJudgment,
  sampleMap: Map<string, WritingSample>
): JudgmentLabels {
  const sA = sampleMap.get(j.sampleA);
  const sB = sampleMap.get(j.sampleB);

  if (j.stage === "improvement") {
    // One sample is initial, one is revised (same writer)
    const aIsOriginal = sA?.stage === "initial";
    const orig = aIsOriginal ? sA : sB;
    const rev = aIsOriginal ? sB : sA;
    const fbModel = rev?.feedbackModel ?? "?";

    const origLabel = `${orig?.model ?? "?"} (original)`;
    const revLabel = `${rev?.model ?? "?"} (revised, fb: ${fbModel})`;

    let winnerLabel: string;
    if (j.winner === "tie") {
      winnerLabel = "Tie";
    } else {
      const winSample = j.winner === "A" ? sA : sB;
      winnerLabel = winSample?.stage === "initial" ? "original" : "revised";
    }

    return aIsOriginal
      ? { labelA: origLabel, labelB: revLabel, winnerLabel }
      : { labelA: revLabel, labelB: origLabel, winnerLabel };
  }

  if (j.stage === "revised") {
    const fbA = sA?.feedbackModel ? ` (fb: ${sA.feedbackModel})` : "";
    const fbB = sB?.feedbackModel ? ` (fb: ${sB.feedbackModel})` : "";
    return {
      labelA: `${sA?.model ?? "?"}${fbA}`,
      labelB: `${sB?.model ?? "?"}${fbB}`,
      winnerLabel:
        j.winner === "tie"
          ? "Tie"
          : j.winner === "A"
            ? sA?.model ?? "?"
            : sB?.model ?? "?",
    };
  }

  // initial — plain model names
  return {
    labelA: sA?.model ?? "?",
    labelB: sB?.model ?? "?",
    winnerLabel:
      j.winner === "tie"
        ? "Tie"
        : j.winner === "A"
          ? sA?.model ?? "?"
          : sB?.model ?? "?",
  };
}

// ── Judgments Section with Model vs Model comparison ─

function renderJudgmentsSection(run: RunResult): HTMLElement {
  const container = el("div");
  container.id = "judgments-section";
  const judgments = run.judgments;
  if (judgments.length === 0) {
    container.appendChild(el("p", { className: "muted" }, "No judgments."));
    return container;
  }

  // Build sample lookup once
  const sampleMap = new Map(run.samples.map((s) => [s.id, s]));

  // Collect unique values for filters
  const stages = [...new Set(judgments.map((j) => j.stage))].sort();
  const judges = [...new Set(judgments.map((j) => j.judgeModel))].sort();
  const allModels = [...new Set(run.samples.map((s) => s.model))].sort();
  const allPrompts = run.config.prompts;
  const judgmentTags = [...new Set(allPrompts.flatMap((p) => p.tags))].sort();

  // Filter state
  let filterStage = "all";
  let filterJudge = "all";
  let filterModelA = "all";
  let filterModelB = "all";
  let filterPrompt = "all";
  let filterSampleId: string | null = null;

  // Build filter bar
  const filterBar = el("div", { className: "judgment-filters" });

  const promptSelect = document.createElement("select");
  promptSelect.appendChild(new Option("All prompts", "all"));
  if (judgmentTags.length > 1) {
    for (const tag of judgmentTags) {
      promptSelect.appendChild(new Option(`Tag: ${tag}`, `tag:${tag}`));
    }
  }
  for (const p of allPrompts) {
    promptSelect.appendChild(new Option(p.name, `id:${p.id}`));
  }

  const stageSelect = document.createElement("select");
  stageSelect.appendChild(new Option("All stages", "all"));
  for (const s of stages) stageSelect.appendChild(new Option(s, s));

  const judgeSelect = document.createElement("select");
  judgeSelect.appendChild(new Option("All judges", "all"));
  for (const j of judges) judgeSelect.appendChild(new Option(j, j));

  const modelASelect = document.createElement("select");
  modelASelect.appendChild(new Option("All models", "all"));
  for (const m of allModels) modelASelect.appendChild(new Option(m, m));

  const modelBSelect = document.createElement("select");
  modelBSelect.appendChild(new Option("All models", "all"));
  for (const m of allModels) modelBSelect.appendChild(new Option(m, m));

  filterBar.appendChild(el("span", { className: "muted small" }, "Prompt: "));
  filterBar.appendChild(promptSelect);
  filterBar.appendChild(el("span", { className: "muted small" }, " Stage: "));
  filterBar.appendChild(stageSelect);
  filterBar.appendChild(el("span", { className: "muted small" }, " Judge: "));
  filterBar.appendChild(judgeSelect);
  filterBar.appendChild(el("span", { className: "muted small" }, " Model A: "));
  filterBar.appendChild(modelASelect);
  filterBar.appendChild(el("span", { className: "muted small" }, " vs B: "));
  filterBar.appendChild(modelBSelect);

  container.appendChild(filterBar);

  // Sample filter badge (shown when filtering by specific output)
  const sampleBadge = el("div", { className: "sample-filter-badge" });
  sampleBadge.style.display = "none";
  container.appendChild(sampleBadge);

  // Head-to-head summary (shown when both models selected)
  const h2hContainer = el("div", { className: "h2h-summary" });
  h2hContainer.style.display = "none";
  container.appendChild(h2hContainer);

  // Judgment list container
  const listContainer = el("div");
  container.appendChild(listContainer);

  const rerender = (): void => {
    let filtered = judgments;

    // Sample ID filter (from "view judgments" button)
    if (filterSampleId) {
      filtered = filtered.filter(
        (j) => j.sampleA === filterSampleId || j.sampleB === filterSampleId
      );
      const sample = sampleMap.get(filterSampleId);
      sampleBadge.innerHTML = "";
      sampleBadge.style.display = "flex";
      sampleBadge.appendChild(
        el(
          "span",
          {},
          `Showing judgments for ${sample?.model ?? "unknown"}'s output`
        )
      );
      sampleBadge.appendChild(
        el(
          "button",
          {
            className: "badge-clear",
            onClick: () => {
              filterSampleId = null;
              rerender();
            },
          },
          "\u2715 clear"
        )
      );
    } else {
      sampleBadge.style.display = "none";
    }

    if (filterPrompt !== "all") {
      if (filterPrompt.startsWith("tag:")) {
        const tag = filterPrompt.slice(4);
        const promptIds = new Set(
          allPrompts.filter((p) => p.tags.includes(tag)).map((p) => p.id)
        );
        filtered = filtered.filter((j) => promptIds.has(j.promptId));
      } else if (filterPrompt.startsWith("id:")) {
        const id = filterPrompt.slice(3);
        filtered = filtered.filter((j) => j.promptId === id);
      }
    }
    if (filterStage !== "all") {
      filtered = filtered.filter((j) => j.stage === filterStage);
    }
    if (filterJudge !== "all") {
      filtered = filtered.filter((j) => j.judgeModel === filterJudge);
    }

    // Model A/B filtering
    if (filterModelA !== "all" && filterModelB !== "all") {
      // Head-to-head: both samples must match (one A, one B)
      filtered = filtered.filter((j) => {
        const mA = sampleMap.get(j.sampleA)?.model;
        const mB = sampleMap.get(j.sampleB)?.model;
        return (
          (mA === filterModelA && mB === filterModelB) ||
          (mA === filterModelB && mB === filterModelA)
        );
      });
    } else if (filterModelA !== "all") {
      filtered = filtered.filter((j) => {
        const mA = sampleMap.get(j.sampleA)?.model;
        const mB = sampleMap.get(j.sampleB)?.model;
        return mA === filterModelA || mB === filterModelA;
      });
    } else if (filterModelB !== "all") {
      filtered = filtered.filter((j) => {
        const mA = sampleMap.get(j.sampleA)?.model;
        const mB = sampleMap.get(j.sampleB)?.model;
        return mA === filterModelB || mB === filterModelB;
      });
    }

    // Head-to-head summary
    if (filterModelA !== "all" && filterModelB !== "all" && filterModelA !== filterModelB) {
      let winsA = 0;
      let winsB = 0;
      let ties = 0;
      for (const j of filtered) {
        const mA = sampleMap.get(j.sampleA)?.model;
        if (j.winner === "tie") {
          ties++;
        } else if (j.winner === "A") {
          if (mA === filterModelA) winsA++;
          else winsB++;
        } else {
          if (mA === filterModelA) winsB++;
          else winsA++;
        }
      }
      h2hContainer.innerHTML = "";
      h2hContainer.style.display = "block";
      h2hContainer.appendChild(
        el(
          "div",
          { className: "h2h-record" },
          el("span", { className: "h2h-model" }, filterModelA),
          el("span", { className: "h2h-wins" }, ` ${winsA}W`),
          el("span", { className: "muted" }, " / "),
          el("span", { className: "h2h-losses" }, `${winsB}L`),
          el("span", { className: "muted" }, " / "),
          el("span", { className: "h2h-ties" }, `${ties}T`),
          el("span", { className: "muted" }, ` vs `),
          el("span", { className: "h2h-model" }, filterModelB)
        )
      );
    } else {
      h2hContainer.style.display = "none";
    }

    listContainer.innerHTML = "";
    listContainer.appendChild(
      el(
        "p",
        { className: "muted small mb-1" },
        `${filtered.length} of ${judgments.length} judgments`
      )
    );

    for (const j of filtered) {
      const prompt = run.config.prompts.find((p) => p.id === j.promptId);
      const { labelA, labelB, winnerLabel } = buildJudgmentLabel(
        j,
        sampleMap
      );
      const winnerClass =
        j.winner === "A" ? "a" : j.winner === "B" ? "b" : "tie";

      const linkA = el(
        "a",
        {
          href: "#",
          className: "judgment-sample-link",
          onClick: (e: Event) => {
            e.preventDefault();
            scrollToSample(j.sampleA, run);
          },
        },
        labelA
      );

      const linkB = el(
        "a",
        {
          href: "#",
          className: "judgment-sample-link",
          onClick: (e: Event) => {
            e.preventDefault();
            scrollToSample(j.sampleB, run);
          },
        },
        labelB
      );

      const judgEl = el("div", { className: "judgment" });

      // Line 1: stage, prompt, judge
      judgEl.appendChild(
        el(
          "div",
          { className: "judgment-header" },
          el("span", { className: "judgment-stage" }, j.stage),
          el("span", {}, ` ${prompt?.name ?? j.promptId}`),
          el(
            "span",
            { className: "judgment-judge" },
            `Judge: ${j.judgeModel}`
          )
        )
      );

      // Line 2: matchup
      judgEl.appendChild(
        el(
          "div",
          { className: "judgment-matchup" },
          linkA,
          el("span", { className: "muted" }, " vs "),
          linkB
        )
      );

      // Line 3: winner
      judgEl.appendChild(
        el(
          "div",
          { className: "judgment-result" },
          el("span", { className: "muted" }, "\u2192 "),
          el(
            "span",
            { className: `judgment-winner ${winnerClass}` },
            winnerLabel
          )
        )
      );

      if (j.reasoning) {
        judgEl.appendChild(
          el("div", { className: "judgment-reasoning" }, j.reasoning)
        );
      }

      listContainer.appendChild(judgEl);
    }
  };

  promptSelect.addEventListener("change", () => {
    filterPrompt = promptSelect.value;
    filterSampleId = null;
    rerender();
  });
  stageSelect.addEventListener("change", () => {
    filterStage = stageSelect.value;
    filterSampleId = null;
    rerender();
  });
  judgeSelect.addEventListener("change", () => {
    filterJudge = judgeSelect.value;
    filterSampleId = null;
    rerender();
  });
  modelASelect.addEventListener("change", () => {
    filterModelA = modelASelect.value;
    filterSampleId = null;
    rerender();
  });
  modelBSelect.addEventListener("change", () => {
    filterModelB = modelBSelect.value;
    filterSampleId = null;
    rerender();
  });

  // Expose API for cross-section interaction
  judgmentApi = {
    focusSample(sampleId: string) {
      const sample = sampleMap.get(sampleId);
      filterSampleId = sampleId;
      filterPrompt = "all";
      filterStage = "all";
      filterJudge = "all";
      filterModelA = sample?.model ?? "all";
      filterModelB = "all";
      promptSelect.value = "all";
      stageSelect.value = "all";
      judgeSelect.value = "all";
      modelASelect.value = filterModelA;
      modelBSelect.value = "all";
      rerender();
      container.scrollIntoView({ behavior: "smooth" });
    },
    focusModel(model: string) {
      filterSampleId = null;
      filterPrompt = "all";
      filterModelA = model;
      filterModelB = "all";
      filterStage = "all";
      filterJudge = "all";
      promptSelect.value = "all";
      stageSelect.value = "all";
      judgeSelect.value = "all";
      modelASelect.value = model;
      modelBSelect.value = "all";
      rerender();
      container.scrollIntoView({ behavior: "smooth" });
    },
  };

  rerender();
  return container;
}

// ── Run Metadata ────────────────────────────────────

function renderRunMetadata(run: RunResult): HTMLElement {
  const container = el("div");

  const costGrid = el("div", { className: "cost-grid" });
  costGrid.appendChild(
    renderCostItem("Total Cost", `$${run.meta.totalCost.toFixed(4)}`)
  );
  if (
    run.meta.totalCostUncached != null &&
    run.meta.totalCostUncached > run.meta.totalCost + 0.00005
  ) {
    costGrid.appendChild(
      renderCostItem(
        "Uncached Cost",
        `$${run.meta.totalCostUncached.toFixed(4)}`
      )
    );
  }
  costGrid.appendChild(
    renderCostItem(
      "Duration",
      `${(run.meta.durationMs / 1000).toFixed(1)}s`
    )
  );
  costGrid.appendChild(
    renderCostItem("Total Tokens", run.meta.totalTokens.toLocaleString())
  );
  container.appendChild(costGrid);

  // Cost breakdown table (model × stage), matching TUI layout
  const stageCols = [
    { key: "initial", label: "Write" },
    { key: "initialJudging", label: "Judge" },
    { key: "feedback", label: "Feedback" },
    { key: "revised", label: "Revise" },
    { key: "revisedJudging", label: "Re-Judge" },
  ];

  const models = Object.keys(run.meta.costByModel).sort();
  const mbms = run.meta.costByModelByStage ?? {};

  // Only show stage columns that have data
  const activeStages = stageCols.filter((s) =>
    models.some((m) => (mbms[m]?.[s.key] ?? 0) > 0)
  );

  if (models.length > 0 && activeStages.length > 0) {
    container.appendChild(el("h3", {}, "Cost Breakdown"));

    const table = el("table", { className: "cost-breakdown-table" });
    const headerCells = [
      el("th", {}, "Model"),
      ...activeStages.map((s) => el("th", {}, s.label)),
      el("th", {}, "Total"),
      el("th", {}, "Speed"),
    ];
    table.appendChild(el("thead", {}, el("tr", {}, ...headerCells)));

    const tbody = el("tbody");
    for (const model of models) {
      const stages = mbms[model] ?? {};
      const total = run.meta.costByModel[model] ?? 0;
      const speed = run.meta.speedByModel?.[model];
      const speedStr = speed
        ? `${formatSpeed(speed.tokensPerSecond)} tok/s`
        : "-";

      const cells = [
        el("td", {}, model),
        ...activeStages.map((s) => {
          const c = stages[s.key] ?? 0;
          return el("td", { className: "cost" }, c > 0 ? `$${c.toFixed(4)}` : "-");
        }),
        el("td", { className: "cost total" }, `$${total.toFixed(4)}`),
        el("td", { className: "speed" }, speedStr),
      ];
      tbody.appendChild(el("tr", {}, ...cells));
    }
    table.appendChild(tbody);
    container.appendChild(table);
  }

  if (run.modelInfo && Object.keys(run.modelInfo).length > 0) {
    container.appendChild(el("h3", {}, "Models"));
    const cards = el("div", { className: "model-cards" });
    for (const [label, info] of Object.entries(run.modelInfo)) {
      cards.appendChild(
        el(
          "div",
          { className: "model-card" },
          el("div", { className: "name" }, label),
          el("div", { className: "detail" }, info.name),
          el("div", { className: "detail" }, `Family: ${info.family}`),
          el(
            "div",
            { className: "detail" },
            `$${info.costPer1MInput}/M in, $${info.costPer1MOutput}/M out`
          ),
          info.releaseDate
            ? el("div", { className: "detail" }, `Released: ${info.releaseDate}`)
            : null,
          el(
            "div",
            { className: "detail" },
            info.openWeights ? "Open weights" : "Proprietary"
          )
        )
      );
    }
    container.appendChild(cards);
  }

  return container;
}

// ── Methodology Page ────────────────────────────────

function renderMethodologyPage(): void {
  const container = el("div", { className: "methodology" },

    // ── How Models Are Compared ──────────────────────
    el("h2", {}, "How Models Are Compared"),
    el("p", {},
      "Writing quality is evaluated through pairwise blind judging. " +
      "For each prompt, an LLM judge is shown two writing samples labeled " +
      "\"Sample A\" and \"Sample B\" with no indication of which model produced " +
      "which text. The judge decides which sample is better (A, B, or tie) " +
      "and provides reasoning."
    ),
    el("p", {},
      "Each prompt defines its own judging criteria tailored to the genre. " +
      "A sermon prompt might specify theological accuracy and pastoral warmth, " +
      "while a short story prompt might focus on narrative voice and character " +
      "interiority. The judge evaluates against all listed criteria holistically."
    ),
    el("p", {},
      "Judging uses structured JSON output (a Zod schema requesting " +
      "winner and reasoning). If a judge model does not support structured " +
      "output, the system falls back to free-text generation and extracts " +
      "JSON from the response."
    ),
    el("h3", {}, "Position Bias Mitigation"),
    el("p", {},
      "LLMs can exhibit position bias \u2014 a tendency to favor whichever sample " +
      "appears first. To counteract this, the benchmark randomly swaps the " +
      "presentation order of each pair with 50% probability. After the judge " +
      "responds, the winner is mapped back to the canonical ordering. This " +
      "ensures that any position preference cancels out over many comparisons."
    ),

    // ── The Benchmark Pipeline ──────────────────────
    el("h2", {}, "The Benchmark Pipeline"),
    el("p", {},
      "The benchmark runs as a reactive pipeline. Tasks fire as soon as " +
      "their dependencies are met rather than waiting for entire stages to " +
      "complete. Judging begins as soon as two samples for the same prompt " +
      "exist; feedback starts as soon as a sample is written; revisions " +
      "start as soon as feedback arrives."
    ),
    el("ol", {},
      el("li", {},
        el("strong", {}, "Write"),
        " \u2014 Each model generates an output for each prompt."
      ),
      el("li", {},
        el("strong", {}, "Judge (initial)"),
        " \u2014 Pairwise blind comparison of initial outputs. Every unique " +
        "pair of samples for a prompt is judged by every judge model."
      ),
      el("li", {},
        el("strong", {}, "Feedback"),
        " \u2014 Each model critiques every other model\u2019s initial output, " +
        "identifying strengths and areas for improvement."
      ),
      el("li", {},
        el("strong", {}, "Revise"),
        " \u2014 The original writer revises its piece using another model\u2019s " +
        "feedback."
      ),
      el("li", {},
        el("strong", {}, "Judge (revised)"),
        " \u2014 Revised outputs are compared head-to-head. Only revisions " +
        "that used feedback from the same source model are compared, so " +
        "the comparison isolates writing ability from feedback quality."
      ),
      el("li", {},
        el("strong", {}, "Judge (improvement)"),
        " \u2014 Each revision is compared against its own original to " +
        "measure whether the feedback actually helped improve the writing."
      ),
    ),

    // ── Bradley-Terry Rating System ─────────────────
    el("h2", {}, "Bradley-Terry Rating System"),
    el("p", {},
      "Ratings are computed using the Bradley-Terry model, a maximum " +
      "likelihood estimation method for pairwise comparison data. Unlike " +
      "sequential ELO (where processing the same judgments in a different " +
      "order gives different ratings), Bradley-Terry computes strength " +
      "parameters from all outcomes simultaneously. The same set of " +
      "judgments always produces the same ratings."
    ),
    el("h3", {}, "The Algorithm"),
    el("p", {},
      "Each model is assigned a strength parameter p, initially set to 1. " +
      "The algorithm iterates:"
    ),
    el("div", { className: "formula" },
      "For each model i:\n" +
      "  score\u1d62 = wins\u1d62 + 0.5 \u00d7 ties\u1d62\n" +
      "  expected\u1d62 = \u03a3\u2c7c N\u1d62\u2c7c \u00d7 p\u1d62 / (p\u1d62 + p\u2c7c)\n" +
      "  p\u1d62 \u2190 (score\u1d62 / expected\u1d62) \u00d7 p\u1d62\n\n" +
      "Normalize all strengths by their geometric mean.\n" +
      "Repeat until convergence (max relative change < 10\u207b\u2076, up to 50 iterations)."
    ),
    el("p", {},
      "A model\u2019s strength increases when its observed win " +
      "rate exceeds what the current strength estimates predict, and " +
      "decreases when it falls short. Ties count as half a win for each " +
      "side. The geometric mean normalization prevents strengths from " +
      "drifting to infinity."
    ),
    el("h3", {}, "ELO-Scale Conversion"),
    el("p", {},
      "Bradley-Terry strengths are converted to a familiar ELO-like scale:"
    ),
    el("div", { className: "formula" },
      "rating = 400 \u00d7 log\u2081\u2080(strength) + 1500"
    ),
    el("p", {},
      "This means a model whose BT strength is 10\u00d7 another\u2019s will be " +
      "rated 400 points higher, matching the standard ELO interpretation " +
      "where a 400-point gap implies roughly 10:1 win odds."
    ),

    // ── Three Rating Types ──────────────────────────
    el("h2", {}, "Three Rating Types"),
    el("h3", {}, "Writing ELO"),
    el("p", {},
      "Direct head-to-head writing quality. Two writing samples for the " +
      "same prompt are shown to a judge; the winning model gets credit. " +
      "Both initial and revised stage judgments contribute to writing " +
      "ratings."
    ),
    el("h3", {}, "Feedback ELO"),
    el("p", {},
      "How useful a model\u2019s editorial feedback is, measured indirectly. " +
      "The system does not compare feedback texts directly. Instead, it " +
      "uses improvement judgments (revision vs. original) to determine " +
      "whether feedback led to a better revision."
    ),
    el("p", {},
      "The algorithm groups improvement judgments by prompt and judge, " +
      "then pairs up different feedback providers within each group. If " +
      "feedback model A\u2019s revision beat the original but feedback model " +
      "B\u2019s did not, A wins. If both improved or both failed, it\u2019s a tie. " +
      "These synthetic pairwise outcomes are then fed into the same " +
      "Bradley-Terry computation."
    ),
    el("h3", {}, "Per-Tag ELO"),
    el("p", {},
      "Each prompt has genre tags (e.g. \"speech\", \"theological\", " +
      "\"creative\"). Per-tag ratings run the same Bradley-Terry computation " +
      "restricted to judgments from prompts with a given tag. This reveals " +
      "category-specific strengths \u2014 a model might excel at essays but " +
      "struggle with creative fiction."
    ),

    // ── Cumulative Ratings ──────────────────────────
    el("h2", {}, "Cumulative Ratings"),
    el("p", {},
      "Ratings accumulate across multiple benchmark runs. Rather than " +
      "applying sequential updates (which would be order-dependent), the " +
      "system stores pairwise records: for each pair of models, the total " +
      "number of wins for each side and ties."
    ),
    el("p", {},
      "When a new run completes, its pairwise outcomes are merged with " +
      "the existing accumulated records. Ratings are then recomputed " +
      "from scratch using Bradley-Terry on the full merged dataset. This " +
      "means the order in which runs are processed does not affect the " +
      "final ratings."
    ),
    el("p", {},
      "The leaderboard on the dashboard page always reflects the " +
      "cumulative ratings across all runs. Individual run pages show " +
      "ratings computed from that run\u2019s judgments alone."
    ),

    // ── Reading the Results ─────────────────────────
    el("h2", {}, "Reading the Results"),
    el("ul", {},
      el("li", {},
        el("strong", {}, "1500"),
        " is the baseline rating. A model with no wins or losses, or one " +
        "at the geometric mean of all model strengths, sits at 1500."
      ),
      el("li", {},
        el("strong", {}, "400-point gap"),
        " corresponds to roughly 10:1 expected win odds. A model rated " +
        "1900 is expected to beat a 1500-rated model about 90% of the time."
      ),
      el("li", {},
        el("strong", {}, "W / L / T"),
        " are raw win, loss, and tie counts from all pairwise matches " +
        "the model participated in. These are the direct inputs to the " +
        "Bradley-Terry computation."
      ),
      el("li", {},
        el("strong", {}, "Matches"),
        " is the total number of pairwise comparisons involving the model " +
        "(W + L + T). More matches produce more reliable ratings."
      ),
    ),
    el("p", { className: "note" },
      "Ratings from a small number of matches should be interpreted " +
      "cautiously. As more runs accumulate, the cumulative ratings " +
      "converge toward stable values."
    ),
  );

  render(container.outerHTML);
}

// ── Init ────────────────────────────────────────────

async function init(): Promise<void> {
  // Set up navigation first — the methodology page is pure static
  // content and must work even when no benchmark data exists.
  $$(".nav a[data-page]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      history.pushState(null, "", a.getAttribute("href"));
      route();
    });
  });
  window.addEventListener("popstate", route);

  try {
    state.index = await fetchIndex();
  } catch (e) {
    // Methodology page doesn't need data — let it render
    if (getPage().page !== "methodology") {
      renderError(e instanceof Error ? e.message : String(e));
      return;
    }
  }

  route();
}

function route(): void {
  const { page, id } = getPage();
  judgmentApi = null;

  $$(".nav a").forEach((a) => {
    const dataPage = a.getAttribute("data-page");
    const isActive =
      dataPage === page || (page === "run" && dataPage === "runs");
    a.classList.toggle("active", isActive);
  });

  switch (page) {
    case "dashboard":
      renderDashboard(state.index!);
      break;
    case "runs":
      renderRunsPage(state.index!);
      break;
    case "run":
      renderRunDetailPage(id!);
      break;
    case "methodology":
      renderMethodologyPage();
      break;
  }
}

async function renderRunDetailPage(id: string): Promise<void> {
  render(`<div id="loading">loading run...</div>`);
  try {
    const run = await fetchRun(id);
    renderRunDetail(run);
  } catch (e) {
    renderError(e instanceof Error ? e.message : String(e));
  }
}

init();
