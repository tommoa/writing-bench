import { useReducer, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { TabBar } from "./TabBar.js";
import { BenchmarkTab } from "./tabs/BenchmarkTab.js";
import { CacheTab } from "./tabs/CacheTab.js";
import { CostBreakdownTable } from "./CostBreakdownTable.js";
import { appReducer, benchmarkEventToAction, INITIAL_STATE } from "./state.js";
import type { TabId } from "./state.js";
import type { BenchmarkEvent, TerminalPalette } from "../types.js";

const SIDEBAR_MIN_WIDTH = 100;
const SIDEBAR_WIDTH = 42;

interface AppProps {
  /** Event subscription for an active benchmark. Null in standalone mode. */
  subscribe: ((handler: (event: BenchmarkEvent) => void) => void) | null;
  showSpeed?: boolean;
  palette: TerminalPalette;
  /** Called when the user presses q to exit. */
  onExit?: () => void;
}

export function App({ subscribe, showSpeed, palette, onExit }: AppProps) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  const { benchmark } = state;
  const progress = benchmark.progress;
  const { width: termWidth } = useTerminalDimensions();
  const showSidebar = state.activeTab === "benchmark" && termWidth >= SIDEBAR_MIN_WIDTH;
  const standalone = subscribe === null;

  // ── Benchmark event subscription ──────────────────
  useEffect(() => {
    if (!subscribe) return;
    subscribe((event) => {
      const action = benchmarkEventToAction(event);
      if (action) dispatch(action);
    });
  }, [subscribe]);

  // ── Global keyboard handler ───────────────────────
  useKeyboard((key) => {
    // Tab switching
    const tab = ({ "1": "benchmark", "2": "cache", "3": "runs" } as Record<string, TabId>)[key.name];
    if (tab) {
      dispatch({ type: "SET_TAB", tab });
      return;
    }

    // Exit on q (when benchmark is complete or in standalone mode,
    // but not during an active confirmation prompt)
    const confirmActive = state.cache.confirmAction !== null || state.runs.confirmDelete !== null;
    if (key.name === "q" && (benchmark.complete || standalone) && !confirmActive) {
      onExit?.();
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* ── Fixed header ──────────────────────────── */}
      <box marginBottom={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.cyan} attributes={1}>writing-bench</text>
      </box>

      <TabBar activeTab={state.activeTab} palette={palette} />

      {/* ── Tab content + optional sidebar ─────────── */}
      <box flexDirection="row" flexGrow={1}>
        {/* Main content area */}
        {state.activeTab === "benchmark" && (
          standalone ? (
            <box flexGrow={1} paddingLeft={1} paddingTop={1}>
              <text fg={palette.gray}>
                No active benchmark. Run `writing-bench run` to start one.
              </text>
            </box>
          ) : (
            <BenchmarkTab
              progress={progress}
              complete={benchmark.complete}
              error={benchmark.error}
              showSpeed={showSpeed}
              showCostInline={!showSidebar}
              palette={palette}
            />
          )
        )}

        {state.activeTab === "cache" && (
          <CacheTab
            state={state.cache}
            activeTab={state.activeTab}
            dispatch={dispatch}
            palette={palette}
          />
        )}

        {state.activeTab === "runs" && (
          <box flexGrow={1} paddingLeft={1} paddingTop={1}>
            <text fg={palette.gray}>Run history -- coming soon</text>
          </box>
        )}

        {/* Sidebar: cost breakdown (benchmark tab, wide terminals) */}
        {showSidebar && !standalone && (
          <box width={SIDEBAR_WIDTH} flexDirection="column">
            <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
              <CostBreakdownTable
                costByModelByStage={progress.costByModelByStage}
                costByModel={progress.costByModel}
                speedByModel={progress.speedByModel}
                eloInitial={progress.elo.initial}
                eloRevised={progress.elo.revised}
                palette={palette}
              />
            </scrollbox>
          </box>
        )}
      </box>

      {/* ── Footer ────────────────────────────────── */}
      {(benchmark.complete || standalone) && (
        <box paddingLeft={1} marginTop={1}>
          <text fg={palette.gray}>Press q to exit</text>
        </box>
      )}
    </box>
  );
}
