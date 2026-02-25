import { useReducer, useEffect, useCallback, useState, useRef } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { PaletteProvider } from "./PaletteContext.js";
import { KeyboardScopeProvider } from "./keyboard/KeyboardScopeProvider.js";
import { useKeyboardScope } from "./keyboard/use-keyboard-scope.js";
import { KEYBOARD_SCOPE_PRIORITY } from "./keyboard/types.js";
import { TabBar } from "./TabBar.js";
import { BenchmarkTab } from "./tabs/BenchmarkTab.js";
import { CacheTab } from "./tabs/CacheTab.js";
import { RunsTab } from "./tabs/RunsTab.js";
import { CostBreakdownCompact } from "./CostBreakdownCompact.js";
import { CostSummary } from "./CostSummary.js";
import { RunConfigForm } from "./RunConfigForm.js";
import { ModelPickerModal } from "./ModelPickerModal.js";
import type { ModelPickerModalProps } from "./ModelPickerModal.js";
import { appReducer, benchmarkEventToAction, INITIAL_STATE } from "./state.js";
import type { TabId } from "./state.js";
import type { BenchmarkEvent, TerminalPalette, TuiRunConfig } from "../types.js";

/** Terminal must be at least this wide to show the sidebar. */
const SIDEBAR_THRESHOLD = 100;
const SIDEBAR_DEFAULT = 52;
const SIDEBAR_MIN = 30;
const SIDEBAR_MAX_FRAC = 0.5;

interface AppProps {
  /** Event subscription for benchmark progress/error/complete events. */
  subscribe: (handler: (event: BenchmarkEvent) => void) => void;
  /** Event subscription for benchmark warning messages. */
  subscribeWarning?: (handler: (message: string) => void) => void;
  /** Called to execute a run initiated from the configuration form. */
  onStartRun?: (config: TuiRunConfig) => Promise<void>;
  /** Initial benchmark mode on first render. */
  initialBenchmarkMode?: "configure" | "running";
  showSpeed?: boolean;
  palette: TerminalPalette;
  /** Called when the user presses q to exit. */
  onExit?: () => void;
}

interface MouseDragLike {
  x: number;
  stopPropagation: () => void;
}

export function App(props: AppProps) {
  return (
    <PaletteProvider value={props.palette}>
      <KeyboardScopeProvider>
        <AppContent {...props} />
      </KeyboardScopeProvider>
    </PaletteProvider>
  );
}

function AppContent({
  subscribe,
  subscribeWarning,
  onStartRun,
  initialBenchmarkMode = "configure",
  showSpeed: showSpeedProp,
  palette,
  onExit,
}: AppProps) {
  const [state, dispatch] = useReducer(appReducer, initialBenchmarkMode, (mode) => ({
    ...INITIAL_STATE,
    benchmark: {
      ...INITIAL_STATE.benchmark,
      mode,
    },
  }));
  const [modalProps, setModalProps] = useState<ModelPickerModalProps | null>(null);
  const { benchmark } = state;
  const progress = benchmark.progress;
  const { width: termWidth, height: termHeight } = useTerminalDimensions();
  const showSidebar = state.activeTab === "benchmark"
    && benchmark.mode !== "configure"
    && termWidth >= SIDEBAR_THRESHOLD;

  // ── Resizable sidebar ────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const clampedWidth = Math.max(SIDEBAR_MIN, Math.min(sidebarWidth, Math.floor(termWidth * SIDEBAR_MAX_FRAC)));
  const contentWidth = termWidth - (showSidebar ? clampedWidth + 2 : 0); // +2 for handle

  const handleResizeDown = useCallback((e: MouseDragLike) => {
    dragRef.current = { startX: e.x, startWidth: clampedWidth };
    e.stopPropagation();
  }, [clampedWidth]);

  const handleResizeDrag = useCallback((e: MouseDragLike) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startX - e.x; // dragging left = wider sidebar
    setSidebarWidth(dragRef.current.startWidth + delta);
    e.stopPropagation();
  }, []);

  const handleResizeDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Track showSpeed for TUI-initiated runs when no CLI override is provided
  const [runShowSpeed, setRunShowSpeed] = useState(false);
  const showSpeed = showSpeedProp ?? runShowSpeed;

  // ── Benchmark event subscription (CLI-initiated runs) ──
  const handleBenchmarkEvent = useCallback((event: BenchmarkEvent) => {
    dispatch(benchmarkEventToAction(event));
  }, []);

  useEffect(() => {
    subscribe(handleBenchmarkEvent);
  }, [subscribe, handleBenchmarkEvent]);

  useEffect(() => {
    if (!subscribeWarning) {
      return;
    }
    subscribeWarning((message) => {
      dispatch({ type: "BENCHMARK_WARNING", message });
    });
  }, [subscribeWarning]);

  // ── TUI-initiated run handler ─────────────────────
  const handleStartRun = useCallback(async (tuiConfig: TuiRunConfig) => {
    if (!onStartRun) {
      return;
    }
    setRunShowSpeed(tuiConfig.speed);
    dispatch({ type: "BENCHMARK_START" });
    try {
      await onStartRun(tuiConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "BENCHMARK_ERROR", message });
    }
  }, [onStartRun]);

  const confirmActive = state.cache.confirmAction !== null || state.runs.confirmDelete !== null;
  const canExit = benchmark.mode === "complete"
    || (benchmark.mode === "configure" && state.activeTab !== "benchmark");

  useKeyboardScope({
    id: "app-emergency",
    priority: KEYBOARD_SCOPE_PRIORITY.emergency,
    enabled: true,
    onKey: (key) => {
      if (key.ctrl && key.name === "c") {
        onExit?.();
        return "handled";
      }
      return "pass";
    },
  });

  useKeyboardScope({
    id: "app-global",
    priority: KEYBOARD_SCOPE_PRIORITY["app-global"],
    enabled: !modalProps && !confirmActive,
    onKey: (key) => {
      const tab = ({ "1": "benchmark", "2": "cache", "3": "runs" } as Record<string, TabId>)[key.name];
      if (tab) {
        dispatch({ type: "SET_TAB", tab });
        return "handled";
      }

      if (key.name === "n" && benchmark.mode === "complete" && state.activeTab === "benchmark") {
        dispatch({ type: "BENCHMARK_RESET" });
        return "handled";
      }

      if (key.name === "q" && canExit) {
        onExit?.();
        return "handled";
      }

      return "pass";
    },
  });

  return (
    <box flexDirection="column" flexGrow={1} position="relative">
      {/* ── Fixed header ──────────────────────────── */}
      <box marginBottom={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.cyan} attributes={1}>writing-bench</text>
      </box>

      <TabBar activeTab={state.activeTab} />

      {/* ── Tab content + optional sidebar ─────────── */}
      <box flexDirection="row" flexGrow={1}>
        {/* Main content area */}
        {state.activeTab === "benchmark" && (
          benchmark.mode === "configure" ? (
            <RunConfigForm
              onStart={handleStartRun}
              error={benchmark.error}
              onExit={onExit}
              onOpenModal={setModalProps}
              isModalOpen={modalProps !== null}
            />
          ) : (
            <BenchmarkTab
              progress={progress}
              error={benchmark.error}
              showSpeed={showSpeed}
              showCostInline={!showSidebar}
              contentWidth={contentWidth}
            />
          )
        )}

        {state.activeTab === "cache" && (
          <CacheTab
            state={state.cache}
            activeTab={state.activeTab}
            dispatch={dispatch}
          />
        )}

        {state.activeTab === "runs" && (
          <RunsTab
            state={state.runs}
            activeTab={state.activeTab}
            dispatch={dispatch}
          />
        )}

        {/* Sidebar: drag handle + cost summary + per-model breakdown */}
        {showSidebar && (
          <>
            <box
              width={2}
              onMouseDown={handleResizeDown}
              onMouseDrag={handleResizeDrag}
              onMouseDragEnd={handleResizeDragEnd}
            >
              <text fg={palette.gray}>{Array(termHeight).fill(" \u2502").join("\n")}</text>
            </box>
            <box width={clampedWidth} flexDirection="column">
            <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
              <CostSummary
                totalCost={progress.totalCost}
                totalCostUncached={progress.totalCostUncached}
                costByStage={progress.costByStage}
                cacheSavings={progress.cacheSavings}
                maxWidth={clampedWidth - 3}
              />
              <CostBreakdownCompact
                costByModel={progress.costByModel}
                speedByModel={progress.speedByModel}
                eloInitial={progress.elo.initial}
                eloRevised={progress.elo.revised}
                maxWidth={clampedWidth - 3}
              />
            </scrollbox>
            </box>
          </>
        )}
      </box>

      {/* ── Footer ────────────────────────────────── */}
      <box paddingLeft={1} marginTop={1}>
        <text fg={palette.gray}>
          [1-3] switch tabs
          {benchmark.mode === "complete" ? "  [n] new run" : ""}
          {benchmark.mode !== "running" ? "  [q] exit" : ""}
        </text>
      </box>

      {/* ── Full-screen overlay (modal dialogs) ───── */}
      {modalProps && (
        <ModelPickerModal
          {...modalProps}
          onSubmit={(models) => {
            modalProps.onSubmit(models);
            setModalProps(null);
          }}
          onCancel={() => {
            modalProps.onCancel();
            setModalProps(null);
          }}
        />
      )}
    </box>
  );
}
