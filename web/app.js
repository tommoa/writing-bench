// writing-bench web viewer — vanilla JS, no dependencies

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "innerHTML") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  }
  return node;
};

const state = { index: null, currentRun: null };

// ── Router ──────────────────────────────────────────

function getPage() {
  const params = new URLSearchParams(location.search);
  if (params.get("run")) return { page: "run", id: params.get("run") };
  if (params.get("page") === "runs") return { page: "runs" };
  return { page: "dashboard" };
}

// ── Data fetching ───────────────────────────────────

async function fetchIndex() {
  const res = await fetch("data/runs.json");
  if (!res.ok) throw new Error("No data found. Run a benchmark and export first.");
  return res.json();
}

async function fetchRun(id) {
  const res = await fetch(`data/runs/${id}.json`);
  if (!res.ok) throw new Error(`Run ${id} not found`);
  return res.json();
}

// ── Rendering ───────────────────────────────────────

function render(content) {
  const app = $("#app");
  app.innerHTML = "";
  if (typeof content === "string") app.innerHTML = content;
  else app.appendChild(content);
}

function renderError(msg) {
  render(`<div id="error">${msg}</div>`);
}

// ── Dashboard ───────────────────────────────────────

function renderDashboard(index) {
  const frag = document.createDocumentFragment();

  // Writer ELO
  if (index.cumulativeElo.writing.length > 0) {
    frag.appendChild(el("h2", {}, "Writer ELO"));
    frag.appendChild(renderEloTable(index.cumulativeElo.writing));
  }

  // Feedback ELO
  if (index.cumulativeElo.feedback.length > 0) {
    frag.appendChild(el("h2", {}, "Feedback Provider ELO"));
    frag.appendChild(renderEloTable(index.cumulativeElo.feedback));
  }

  // ELO History
  if (index.eloHistory.length > 1) {
    frag.appendChild(el("h2", {}, "ELO History"));
    frag.appendChild(renderSparklines(index.eloHistory));
  }

  // Recent runs
  if (index.runs.length > 0) {
    frag.appendChild(el("h2", {}, "Recent Runs"));
    frag.appendChild(renderRunList(index.runs));
  }

  if (index.runs.length === 0 && index.cumulativeElo.writing.length === 0) {
    frag.appendChild(
      el("p", { className: "muted mt-2" }, "No benchmark data yet. Run a benchmark and export results.")
    );
  }

  render(frag);
}

function renderEloTable(ratings) {
  const table = el("table");
  const thead = el("tr", {},
    el("th", { className: "rank" }, "#"),
    el("th", {}, "Model"),
    el("th", { className: "sortable" }, "ELO"),
    el("th", {}, "Matches"),
  );
  table.appendChild(el("thead", {}, thead));

  const tbody = el("tbody");
  ratings.forEach((r, i) => {
    const ratingClass = i === 0 ? "rating top" : i === ratings.length - 1 ? "rating bottom" : "rating";
    tbody.appendChild(
      el("tr", {},
        el("td", { className: "rank" }, String(i + 1)),
        el("td", {}, r.model),
        el("td", { className: ratingClass }, String(r.rating)),
        el("td", { className: "muted" }, String(r.matchCount)),
      )
    );
  });
  table.appendChild(tbody);
  return table;
}

function renderSparklines(history) {
  const container = el("div");

  // Collect all models
  const models = new Set();
  history.forEach(h => Object.keys(h.ratings).forEach(m => models.add(m)));

  for (const model of models) {
    const values = history.map(h => h.ratings[model]).filter(v => v != null);
    if (values.length < 2) continue;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = 120, h = 30, pad = 2;

    const points = values.map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
      const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
      return `${x},${y}`;
    });

    const svg = `<svg viewBox="0 0 ${w} ${h}"><path d="M${points.join("L")}"/></svg>`;

    container.appendChild(
      el("div", { className: "mb-1" },
        el("span", {}, model + " "),
        el("span", { className: "sparkline", innerHTML: svg }),
        el("span", { className: "muted small" }, ` ${values[values.length - 1]}`),
      )
    );
  }

  return container;
}

function renderRunList(runs) {
  const list = el("ul", { className: "run-list" });
  for (const run of runs) {
    const date = new Date(run.timestamp).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const link = el("a", { href: `?run=${run.id}` }, date);
    const meta = el("span", { className: "run-meta" },
      `${run.models.join(", ")} | ${run.promptCount} prompts | $${run.totalCost.toFixed(4)}`
    );
    list.appendChild(el("li", {}, link, meta));
  }
  return list;
}

// ── Run Detail ──────────────────────────────────────

function renderRunDetail(run) {
  const frag = document.createDocumentFragment();

  // Back link
  frag.appendChild(el("p", {}, el("a", { href: "?" }, "< back to leaderboard")));

  // Run header
  const date = new Date(run.config.timestamp).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  frag.appendChild(el("h2", {}, `Run: ${date}`));

  // Cost breakdown
  const costGrid = el("div", { className: "cost-grid" });
  costGrid.appendChild(renderCostItem("Total Cost", `$${run.meta.totalCost.toFixed(4)}`));
  if (run.meta.totalCostUncached != null && run.meta.totalCostUncached > run.meta.totalCost + 0.00005) {
    costGrid.appendChild(renderCostItem("Uncached Cost", `$${run.meta.totalCostUncached.toFixed(4)}`));
  }
  costGrid.appendChild(renderCostItem("Duration", `${(run.meta.durationMs / 1000).toFixed(1)}s`));
  costGrid.appendChild(renderCostItem("Total Tokens", run.meta.totalTokens.toLocaleString()));
  frag.appendChild(costGrid);

  // Cost by stage
  if (run.meta.costByStage && Object.keys(run.meta.costByStage).length > 0) {
    frag.appendChild(el("h3", {}, "Cost by Stage"));
    const stageCostGrid = el("div", { className: "cost-grid" });
    const stageLabels = {
      initial: "Writing",
      initialJudging: "Judging (Initial)",
      feedback: "Feedback",
      revised: "Revising",
      revisedJudging: "Judging (Revised)",
    };
    for (const [stage, cost] of Object.entries(run.meta.costByStage)) {
      const label = stageLabels[stage] ?? stage;
      stageCostGrid.appendChild(renderCostItem(label, `$${cost.toFixed(4)}`));
    }
    frag.appendChild(stageCostGrid);
  }

  // Cost by model
  if (Object.keys(run.meta.costByModel).length > 0) {
    frag.appendChild(el("h3", {}, "Cost by Model"));
    const modelCostGrid = el("div", { className: "cost-grid" });
    for (const [model, cost] of Object.entries(run.meta.costByModel)) {
      modelCostGrid.appendChild(renderCostItem(model, `$${cost.toFixed(4)}`));
    }
    frag.appendChild(modelCostGrid);
  }

  // Speed by model
  if (run.meta.speedByModel && Object.keys(run.meta.speedByModel).length > 0) {
    frag.appendChild(el("h3", {}, "Speed by Model"));
    const speedGrid = el("div", { className: "cost-grid" });
    for (const [model, speed] of Object.entries(run.meta.speedByModel)) {
      const tps = speed.tokensPerSecond;
      const tpsStr = tps >= 100 ? `${Math.round(tps)}` : tps >= 10 ? tps.toFixed(1) : tps.toFixed(2);
      speedGrid.appendChild(
        renderCostItem(model, `${tpsStr} tok/s (${speed.calls} calls, avg ${(speed.avgLatencyMs / 1000).toFixed(1)}s)`)
      );
    }
    frag.appendChild(speedGrid);
  }

  // Model info cards
  if (run.modelInfo && Object.keys(run.modelInfo).length > 0) {
    frag.appendChild(el("h3", {}, "Models"));
    const cards = el("div", { className: "model-cards" });
    for (const [label, info] of Object.entries(run.modelInfo)) {
      cards.appendChild(
        el("div", { className: "model-card" },
          el("div", { className: "name" }, label),
          el("div", { className: "detail" }, info.name),
          el("div", { className: "detail" }, `Family: ${info.family}`),
          el("div", { className: "detail" }, `$${info.costPer1MInput}/M in, $${info.costPer1MOutput}/M out`),
          info.releaseDate ? el("div", { className: "detail" }, `Released: ${info.releaseDate}`) : null,
          el("div", { className: "detail" }, info.openWeights ? "Open weights" : "Proprietary"),
        )
      );
    }
    frag.appendChild(cards);
  }

  // ELO tables
  frag.appendChild(el("h2", {}, "Initial Writer ELO"));
  frag.appendChild(renderRunEloTable(run.elo.initial.ratings, run.meta.costByModel, run.meta.speedByModel));

  frag.appendChild(el("h2", {}, "Revised Writer ELO"));
  frag.appendChild(renderRunEloTable(run.elo.revised.ratings, run.meta.costByModel, run.meta.speedByModel));

  if (run.elo.revised.feedbackRatings && run.elo.revised.feedbackRatings.length > 0) {
    frag.appendChild(el("h2", {}, "Feedback Provider ELO"));
    frag.appendChild(renderRunEloTable(run.elo.revised.feedbackRatings, null, run.meta.speedByModel));
  }

  // Per-prompt sections
  const prompts = run.config.prompts;
  frag.appendChild(el("h2", {}, "Outputs by Prompt"));

  for (const prompt of prompts) {
    const section = renderPromptSection(run, prompt);
    frag.appendChild(section);
  }

  render(frag);
}

function renderCostItem(label, value) {
  return el("div", { className: "cost-item" },
    el("div", { className: "label" }, label),
    el("div", { className: "value" }, value),
  );
}

function renderRunEloTable(ratings, costByModel, speedByModel) {
  const table = el("table");
  const hasC = costByModel && Object.keys(costByModel).length > 0;
  const hasS = speedByModel && Object.keys(speedByModel).length > 0;
  const headerRow = el("tr", {},
    el("th", { className: "rank" }, "#"),
    el("th", {}, "Model"),
    el("th", {}, "ELO"),
    el("th", {}, "W/L/T"),
    hasC ? el("th", {}, "Cost") : null,
    hasS ? el("th", {}, "Speed") : null,
  );
  table.appendChild(el("thead", {}, headerRow));

  const tbody = el("tbody");
  ratings.forEach((r, i) => {
    const ratingClass = i === 0 ? "rating top" : i === ratings.length - 1 ? "rating bottom" : "rating";
    const wlt = `${r.wins}/${r.losses}/${r.ties}`;
    const cost = costByModel?.[r.model];
    const speed = speedByModel?.[r.model];
    let speedStr = "-";
    if (speed) {
      const tps = speed.tokensPerSecond;
      speedStr = (tps >= 100 ? `${Math.round(tps)}` : tps >= 10 ? tps.toFixed(1) : tps.toFixed(2)) + " tok/s";
    }
    tbody.appendChild(
      el("tr", {},
        el("td", { className: "rank" }, String(i + 1)),
        el("td", {}, r.model),
        el("td", { className: ratingClass }, String(r.rating)),
        el("td", { className: "wlt" }, wlt),
        hasC ? el("td", { className: "cost" }, cost != null ? `$${cost.toFixed(4)}` : "-") : null,
        hasS ? el("td", { className: "speed" }, speedStr) : null,
      )
    );
  });
  table.appendChild(tbody);
  return table;
}

function renderPromptSection(run, prompt) {
  const details = el("details");
  details.appendChild(el("summary", {}, `${prompt.name} (${prompt.category})`));

  const content = el("div", { className: "details-content" });
  content.appendChild(el("p", { className: "muted small" }, prompt.description));

  // Initial outputs
  const initialSamples = run.samples.filter(s => s.promptId === prompt.id && s.stage === "initial");
  if (initialSamples.length > 0) {
    content.appendChild(el("h3", {}, "Initial Outputs"));
    content.appendChild(renderTabbedOutputs(initialSamples, `initial-${prompt.id}`));
  }

  // Feedback
  const promptFeedback = run.feedback.filter(f => {
    const sample = run.samples.find(s => s.id === f.targetSampleId);
    return sample && sample.promptId === prompt.id;
  });
  if (promptFeedback.length > 0) {
    content.appendChild(el("h3", {}, "Feedback"));
    for (const fb of promptFeedback) {
      const target = run.samples.find(s => s.id === fb.targetSampleId);
      const wrapper = el("div", { className: "feedback-text" });
      wrapper.appendChild(
        el("div", { className: "feedback-source" },
          `${fb.sourceModel} on ${target?.model ?? "unknown"}'s output:`
        )
      );
      wrapper.appendChild(document.createTextNode(fb.text));
      const fbTokens = fb.usage ? fb.usage.inputTokens + fb.usage.outputTokens : 0;
      const fbCost = fb.cost ? fb.cost.total : 0;
      const fbLatency = fb.latencyMs ? (fb.latencyMs / 1000).toFixed(1) : "?";
      wrapper.appendChild(
        el("p", { className: "muted small mt-1" },
          `${fbTokens} tokens | $${fbCost.toFixed(4)} | ${fbLatency}s`
        )
      );
      content.appendChild(wrapper);
    }
  }

  // Revised outputs
  const revisedSamples = run.samples.filter(s => s.promptId === prompt.id && s.stage === "revised");
  if (revisedSamples.length > 0) {
    content.appendChild(el("h3", {}, "Revised Outputs"));
    content.appendChild(renderTabbedOutputs(revisedSamples, `revised-${prompt.id}`));
  }

  // Judgments
  const promptJudgments = run.judgments.filter(j => j.promptId === prompt.id);
  if (promptJudgments.length > 0) {
    const judgDetails = el("details");
    judgDetails.appendChild(el("summary", {}, `Judgments (${promptJudgments.length})`));
    const judgContent = el("div", { className: "details-content" });
    for (const j of promptJudgments) {
      const sA = run.samples.find(s => s.id === j.sampleA);
      const sB = run.samples.find(s => s.id === j.sampleB);
      const winnerClass = j.winner === "A" ? "a" : j.winner === "B" ? "b" : "tie";
      const winnerLabel = j.winner === "tie" ? "Tie" : j.winner === "A" ? sA?.model : sB?.model;

      judgContent.appendChild(
        el("div", { className: "judgment" },
          el("div", {},
            el("span", { className: "muted small" }, `${j.judgeModel} [${j.stage}]: `),
            el("span", {}, `${sA?.model ?? "?"} vs ${sB?.model ?? "?"} → `),
            el("span", { className: `judgment-winner ${winnerClass}` }, winnerLabel),
          ),
          el("div", { className: "judgment-reasoning" }, j.reasoning),
        )
      );
    }
    judgDetails.appendChild(judgContent);
    content.appendChild(judgDetails);
  }

  details.appendChild(content);
  return details;
}

function renderTabbedOutputs(samples, prefix) {
  const container = el("div");
  const tabs = el("div", { className: "tabs" });
  const contents = el("div");

  samples.forEach((s, i) => {
    const tabId = `${prefix}-${i}`;
    const label = s.feedbackModel ? `${s.model} (fb: ${s.feedbackModel})` : s.model;

    const tab = el("button", {
      className: i === 0 ? "tab active" : "tab",
      onClick: () => {
        $$(".tab", tabs).forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        $$(".tab-content", contents).forEach(tc => tc.classList.remove("active"));
        $(`#${tabId}`, contents)?.classList.add("active");
      },
    }, label);
    tabs.appendChild(tab);

    const tabContent = el("div", {
      id: tabId,
      className: i === 0 ? "tab-content active" : "tab-content",
    });
    tabContent.appendChild(el("div", { className: "output-text" }, s.text));
    const cachePart = s.usage.cacheReadTokens ? ` (${s.usage.cacheReadTokens} cached)` : "";
    const uncachedPart = s.cost.totalUncached != null && s.cost.totalUncached > s.cost.total + 0.00005
      ? ` (uncached: $${s.cost.totalUncached.toFixed(4)})`
      : "";
    tabContent.appendChild(
      el("p", { className: "muted small mt-1" },
        `${s.usage.inputTokens + s.usage.outputTokens} tokens${cachePart} | $${s.cost.total.toFixed(4)}${uncachedPart} | ${(s.latencyMs / 1000).toFixed(1)}s`
      )
    );
    contents.appendChild(tabContent);
  });

  container.appendChild(tabs);
  container.appendChild(contents);
  return container;
}

// ── Init ────────────────────────────────────────────

async function init() {
  try {
    state.index = await fetchIndex();
  } catch (e) {
    renderError(e.message);
    return;
  }

  // Set up nav
  $$(".nav a").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      history.pushState(null, "", a.getAttribute("href"));
      route();
    });
  });

  window.addEventListener("popstate", route);
  route();
}

function route() {
  const { page, id } = getPage();

  // Update nav active state
  $$(".nav a").forEach(a => {
    a.classList.toggle("active", a.dataset.page === page || (page === "run" && a.dataset.page === "runs"));
  });

  switch (page) {
    case "dashboard":
      renderDashboard(state.index);
      break;
    case "runs":
      renderDashboard(state.index); // runs list is on dashboard
      break;
    case "run":
      renderRunDetailPage(id);
      break;
  }
}

async function renderRunDetailPage(id) {
  render(`<div id="loading">loading run...</div>`);
  try {
    const run = await fetchRun(id);
    renderRunDetail(run);
  } catch (e) {
    renderError(e.message);
  }
}

init();
