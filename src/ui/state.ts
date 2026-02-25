import type {
  BenchmarkProgress,
  BenchmarkEvent,
} from "../types.js";
import type { RunSummary } from "../storage/run-store.js";
import type { RunResult } from "../types.js";
import type { CacheDiskSize } from "../storage/cache-status.js";

// ── Tab Types ───────────────────────────────────────

export type TabId = "benchmark" | "cache" | "runs";

// ── Re-exports ──────────────────────────────────────

export type { CacheDiskSize };

// ── Cache Tab State ─────────────────────────────────

export interface CacheModelEntry {
  key: string;
  displayName: string;
  writes: number;
  feedback: number;
  revisions: number;
  judgments: number;
}

export type CacheConfirmAction =
  | { type: "trim"; model: string }
  | { type: "delete"; model: string };

export interface CacheTabState {
  loading: boolean;
  diskSize: CacheDiskSize | null;
  models: CacheModelEntry[];
  cursorIndex: number;
  confirmAction: CacheConfirmAction | null;
  error: string | null;
}

// ── Runs Tab State ──────────────────────────────────

export interface RunsTabState {
  loading: boolean;
  loaded: boolean;
  summaries: RunSummary[];
  mode: "list" | "detail";
  cursorIndex: number;
  detailRun: RunResult | null;
  confirmDelete: string | null;
  error: string | null;
}

// ── Benchmark Mode ──────────────────────────────────

export type BenchmarkMode = "configure" | "running" | "complete";

// ── App State ───────────────────────────────────────

export interface AppState {
  activeTab: TabId;
  benchmark: {
    mode: BenchmarkMode;
    progress: BenchmarkProgress;
    error: string | null;
  };
  cache: CacheTabState;
  runs: RunsTabState;
}

// ── Initial State ───────────────────────────────────

const INITIAL_PROGRESS: BenchmarkProgress = {
  stage: "initialWriting",
  activeStages: [],
  stageProgress: 0,
  stageDone: 0,
  currentOp: "Starting...",
  elo: { initial: [], revised: [], feedback: [] },
  totalCost: 0,
  totalCostUncached: 0,
  costByModel: {},
  costByStage: {},
  costByModelByStage: {},
  speedByModel: {},
  speedByModelByStage: {},
  cacheSavings: {
    writes:    { cached: 0, fresh: 0, savedCost: 0 },
    feedback:  { cached: 0, fresh: 0, savedCost: 0 },
    revisions: { cached: 0, fresh: 0, savedCost: 0 },
    judgments:  { cached: 0, fresh: 0, savedCost: 0 },
  },
};

export const INITIAL_STATE: AppState = {
  activeTab: "benchmark",
  benchmark: {
    mode: "configure",
    progress: INITIAL_PROGRESS,
    error: null,
  },
  cache: {
    loading: false,
    diskSize: null,
    models: [],
    cursorIndex: 0,
    confirmAction: null,
    error: null,
  },
  runs: {
    loading: false,
    loaded: false,
    summaries: [],
    mode: "list",
    cursorIndex: 0,
    detailRun: null,
    confirmDelete: null,
    error: null,
  },
};

// ── Actions ─────────────────────────────────────────

export type AppAction =
  // Tab
  | { type: "SET_TAB"; tab: TabId }
  // Benchmark
  | { type: "BENCHMARK_START" }
  | { type: "BENCHMARK_PROGRESS"; progress: BenchmarkProgress }
  | { type: "BENCHMARK_COMPLETE" }
  | { type: "BENCHMARK_ERROR"; message: string }
  | { type: "BENCHMARK_WARNING"; message: string }
  | { type: "BENCHMARK_RESET" }
  // Cache
  | { type: "CACHE_LOADING" }
  | { type: "CACHE_LOADED"; diskSize: CacheDiskSize; models: CacheModelEntry[] }
  | { type: "CACHE_CURSOR"; index: number }
  | { type: "CACHE_CONFIRM"; action: CacheConfirmAction }
  | { type: "CACHE_CANCEL" }
  | { type: "CACHE_ACTION_DONE" }
  | { type: "CACHE_ERROR"; message: string }
  // Runs
  | { type: "RUNS_LOADING" }
  | { type: "RUNS_LOADED"; summaries: RunSummary[] }
  | { type: "RUNS_CURSOR"; index: number }
  | { type: "RUNS_DETAIL"; run: RunResult }
  | { type: "RUNS_BACK" }
  | { type: "RUNS_CONFIRM_DELETE"; runId: string }
  | { type: "RUNS_CANCEL_DELETE" }
  | { type: "RUNS_DELETE_DONE"; summaries: RunSummary[] }
  | { type: "RUNS_ERROR"; message: string };

// ── Reducer ─────────────────────────────────────────

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    // ── Tab ──
    case "SET_TAB":
      return {
        ...state,
        activeTab: action.tab,
        cache: { ...state.cache, confirmAction: null },
        runs: { ...state.runs, confirmDelete: null },
      };

    // ── Benchmark ──
    case "BENCHMARK_START":
      return {
        ...state,
        benchmark: {
          mode: "running",
          progress: INITIAL_PROGRESS,
          error: null,
        },
      };
    case "BENCHMARK_PROGRESS":
      return {
        ...state,
        benchmark: { ...state.benchmark, progress: action.progress },
      };
    case "BENCHMARK_COMPLETE":
      return {
        ...state,
        benchmark: {
          ...state.benchmark,
          mode: "complete",
          progress: {
            ...state.benchmark.progress,
            stage: "complete",
            stageProgress: 1,
            currentOp: "Benchmark complete!",
          },
        },
      };
    case "BENCHMARK_ERROR":
      return {
        ...state,
        benchmark: {
          ...state.benchmark,
          // If the run hasn't started producing results yet (still in
          // "running" with no progress), return to configure mode so
          // the user can fix the issue and retry. Otherwise transition
          // to complete so the user can view partial results and isn't
          // stuck in "running" mode with no exit path.
          mode: state.benchmark.mode === "running" && state.benchmark.progress.stageDone === 0
            ? "configure"
            : "complete",
          error: action.message,
        },
      };
    case "BENCHMARK_WARNING":
      return {
        ...state,
        benchmark: {
          ...state.benchmark,
          // Append to existing warnings so multiple provider warnings
          // (e.g. missing API keys for 3 providers) are all visible.
          error: state.benchmark.error
            ? state.benchmark.error + "\n" + action.message
            : action.message,
        },
      };
    case "BENCHMARK_RESET":
      return {
        ...state,
        benchmark: {
          mode: "configure",
          progress: INITIAL_PROGRESS,
          error: null,
        },
      };

    // ── Cache ──
    case "CACHE_LOADING":
      return {
        ...state,
        cache: { ...state.cache, loading: true, error: null },
      };
    case "CACHE_LOADED":
      return {
        ...state,
        cache: {
          ...state.cache,
          loading: false,
          diskSize: action.diskSize,
          models: action.models,
          cursorIndex: Math.min(
            state.cache.cursorIndex,
            Math.max(0, action.models.length - 1),
          ),
        },
      };
    case "CACHE_CURSOR":
      return {
        ...state,
        cache: { ...state.cache, cursorIndex: action.index },
      };
    case "CACHE_CONFIRM":
      return {
        ...state,
        cache: { ...state.cache, confirmAction: action.action },
      };
    case "CACHE_CANCEL":
      return {
        ...state,
        cache: { ...state.cache, confirmAction: null },
      };
    case "CACHE_ACTION_DONE":
      return {
        ...state,
        cache: { ...state.cache, confirmAction: null, loading: true },
      };
    case "CACHE_ERROR":
      return {
        ...state,
        cache: { ...state.cache, loading: false, error: action.message },
      };

    // ── Runs ──
    case "RUNS_LOADING":
      return {
        ...state,
        runs: { ...state.runs, loading: true, error: null },
      };
    case "RUNS_LOADED":
      return {
        ...state,
        runs: { ...state.runs, loading: false, loaded: true, summaries: action.summaries },
      };
    case "RUNS_CURSOR":
      return {
        ...state,
        runs: { ...state.runs, cursorIndex: action.index },
      };
    case "RUNS_DETAIL":
      return {
        ...state,
        runs: { ...state.runs, mode: "detail", detailRun: action.run },
      };
    case "RUNS_BACK":
      return {
        ...state,
        runs: { ...state.runs, mode: "list", detailRun: null },
      };
    case "RUNS_CONFIRM_DELETE":
      return {
        ...state,
        runs: { ...state.runs, confirmDelete: action.runId },
      };
    case "RUNS_CANCEL_DELETE":
      return {
        ...state,
        runs: { ...state.runs, confirmDelete: null },
      };
    case "RUNS_DELETE_DONE":
      return {
        ...state,
        runs: {
          ...state.runs,
          confirmDelete: null,
          loading: false,
          loaded: true,
          error: null,
          mode: "list",
          detailRun: null,
          summaries: action.summaries,
          cursorIndex: Math.min(
            state.runs.cursorIndex,
            Math.max(0, action.summaries.length - 1),
          ),
        },
      };
    case "RUNS_ERROR":
      return {
        ...state,
        runs: { ...state.runs, error: action.message },
      };

    default:
      return state;
  }
}

// ── Event Handler ───────────────────────────────────

/**
 * Convert a BenchmarkEvent into an AppAction for the reducer.
 */
export function benchmarkEventToAction(
  event: BenchmarkEvent,
): AppAction {
  switch (event.type) {
    case "progress":
      return { type: "BENCHMARK_PROGRESS", progress: event.data };
    case "complete":
      return { type: "BENCHMARK_COMPLETE" };
    case "error":
      return { type: "BENCHMARK_ERROR", message: event.data.message };
  }
}
