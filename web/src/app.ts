import type { RunsIndex } from "./types.js";
import { $$, renderError } from "./helpers.js";
import { state, setJudgmentApi } from "./state.js";
import { renderDashboard, renderRunsPage } from "./dashboard.js";
import { renderRunDetailPage } from "./run-detail.js";

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

function route(): void {
  const { page, id } = getPage();
  setJudgmentApi(null);

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
  }
}

// ── Init ────────────────────────────────────────────

async function init(): Promise<void> {
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
    renderError(e instanceof Error ? e.message : String(e));
    return;
  }

  route();
}

init();
