import type { RunsIndex } from "./types.js";
import { $$, renderError } from "./helpers.js";
import { state, setJudgmentApi } from "./state.js";

// ── Router ──────────────────────────────────────────

interface Page {
  page: "dashboard" | "runs" | "run";
  id?: string;
}

function getPage(): Page {
  const params = new URLSearchParams(location.search);
  const runId = params.get("run");
  if (runId) return { page: "run", id: runId };
  if (params.get("page") === "runs") return { page: "runs" };
  return { page: "dashboard" };
}

// ── Data fetching ───────────────────────────────────

async function fetchIndex(): Promise<RunsIndex> {
  const res = await fetch("data/runs.json");
  if (!res.ok)
    throw new Error("No data found. Run a benchmark and export first.");
  return res.json();
}

// ── Routing ─────────────────────────────────────────

let currentRouteToken = 0;
let currentAbort: AbortController | null = null;

async function route(): Promise<void> {
  const token = ++currentRouteToken;
  currentAbort?.abort();
  currentAbort = new AbortController();
  const signal = currentAbort.signal;

  const { page, id } = getPage();
  setJudgmentApi(null);

  $$(".nav a").forEach((a) => {
    const dataPage = a.getAttribute("data-page");
    const isActive =
      dataPage === page || (page === "run" && dataPage === "runs");
    a.classList.toggle("active", isActive);
  });

  switch (page) {
    case "dashboard": {
      const { renderDashboard } = await import("./dashboard.js");
      if (token !== currentRouteToken) return;
      renderDashboard(state.index!);
      break;
    }
    case "runs": {
      const { renderRunsPage } = await import("./dashboard.js");
      if (token !== currentRouteToken) return;
      renderRunsPage(state.index!);
      break;
    }
    case "run": {
      const { renderRunDetailPage } = await import("./run-detail.js");
      if (token !== currentRouteToken) return;
      await renderRunDetailPage(id!, signal);
      if (token !== currentRouteToken) return;
      break;
    }
  }
}

// ── Init ────────────────────────────────────────────

async function init(): Promise<void> {
  $$(".nav a[data-page]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      history.pushState(null, "", a.getAttribute("href"));
      void route();
    });
  });
  window.addEventListener("popstate", () => {
    void route();
  });

  try {
    state.index = await fetchIndex();
  } catch (e) {
    renderError(e instanceof Error ? e.message : String(e));
    return;
  }

  await route();
}

init();
