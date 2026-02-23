import { useReducer, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { TabBar } from "./TabBar.js";
import { BenchmarkTab } from "./tabs/BenchmarkTab.js";
import { CostBreakdownTable } from "./CostBreakdownTable.js";
import { appReducer, benchmarkEventToAction, INITIAL_STATE } from "./state.js";
import type { TabId } from "./state.js";
import type { BenchmarkEvent, TerminalPalette } from "../types.js";

const SIDEBAR_MIN_WIDTH = 100;
const SIDEBAR_WIDTH = 42;

interface AppProps {
  subscribe: (handler: (event: BenchmarkEvent) => void) => void;
  showSpeed?: boolean;
  palette: TerminalPalette;
}

export function App({ subscribe, showSpeed, palette }: AppProps) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  const { benchmark } = state;
  const progress = benchmark.progress;
  const { width: termWidth } = useTerminalDimensions();
  const showSidebar = state.activeTab === "benchmark" && termWidth >= SIDEBAR_MIN_WIDTH;

  // ── Benchmark event subscription ──────────────────
  useEffect(() => {
    subscribe((event) => {
      const action = benchmarkEventToAction(event);
      if (action) dispatch(action);
    });
  }, [subscribe]);

  // ── Global keyboard handler ───────────────────────
  useKeyboard((key) => {
    const tab = ({ "1": "benchmark", "2": "cache", "3": "runs" } as Record<string, TabId>)[key.name];
    if (tab) {
      dispatch({ type: "SET_TAB", tab });
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
          <BenchmarkTab
            progress={progress}
            complete={benchmark.complete}
            error={benchmark.error}
            showSpeed={showSpeed}
            showCostInline={!showSidebar}
            palette={palette}
          />
        )}

        {state.activeTab === "cache" && (
          <box flexGrow={1} paddingLeft={1} paddingTop={1}>
            <text fg={palette.gray}>Cache management -- coming soon</text>
          </box>
        )}

        {state.activeTab === "runs" && (
          <box flexGrow={1} paddingLeft={1} paddingTop={1}>
            <text fg={palette.gray}>Run history -- coming soon</text>
          </box>
        )}

        {/* Sidebar: cost breakdown (benchmark tab, wide terminals) */}
        {showSidebar && (
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
    </box>
  );
}
