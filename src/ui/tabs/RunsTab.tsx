import { useEffect, useCallback, useState, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { EloTable } from "../EloTable.js";
import { ConfirmPrompt } from "../ConfirmPrompt.js";
import { useKeyboardScope } from "../keyboard/use-keyboard-scope.js";
import { KEYBOARD_SCOPE_PRIORITY } from "../keyboard/types.js";
import type { Column } from "../Table.js";
import { Table } from "../Table.js";
import { loadRun } from "../../storage/run-store.js";
import { deleteRunFull, listRunSummaries } from "../../storage/run-store.js";
import type { AppAction, RunsTabState, TabId } from "../state.js";
import { usePalette } from "../PaletteContext.js";
import { useLoadOnTabActivation } from "./use-load-on-tab-activation.js";
import { scrollToTableCursor } from "../scroll-utils.js";

interface RunsTabProps {
  state: RunsTabState;
  activeTab: TabId;
  dispatch: (action: AppAction) => void;
}

// ── Helpers ─────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs.toFixed(0)}s`;
}

async function loadRunsData(dispatch: (action: AppAction) => void) {
  dispatch({ type: "RUNS_LOADING" });
  try {
    const summaries = await listRunSummaries();
    dispatch({ type: "RUNS_LOADED", summaries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dispatch({ type: "RUNS_ERROR", message: `Failed to load runs: ${msg}` });
  }
}

// ── Component ───────────────────────────────────────

export function RunsTab({ state, activeTab, dispatch }: RunsTabProps) {
  const palette = usePalette();
  const isActive = activeTab === "runs";
  const [deleteProgress, setDeleteProgress] = useState<string | null>(null);
  const listScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadData = useCallback(() => {
    void loadRunsData(dispatch);
  }, [dispatch]);

  // Scroll to keep cursor visible in list mode
  useEffect(() => {
    if (listScrollRef.current && state.mode === "list" && state.summaries.length > 0) {
      scrollToTableCursor(listScrollRef.current, state.cursorIndex);
    }
  }, [state.cursorIndex]);

  useLoadOnTabActivation({
    isActive,
    loading: state.loading,
    loaded: state.loaded,
    load: loadData,
  });

  useKeyboardScope({
    id: "runs-tab",
    priority: KEYBOARD_SCOPE_PRIORITY["tab-local"],
    enabled: isActive && !state.confirmDelete && !deleteProgress,
    onKey: (key) => {
      if (state.mode === "detail") {
        if (key.name === "escape") {
          dispatch({ type: "RUNS_BACK" });
          return "handled";
        }
        if (detailScrollRef.current) {
          switch (key.name) {
            case "j":
            case "down":
              detailScrollRef.current.scrollBy(1);
              return "handled";
            case "k":
            case "up":
              detailScrollRef.current.scrollBy(-1);
              return "handled";
            case "pagedown":
              detailScrollRef.current.scrollBy(10);
              return "handled";
            case "pageup":
              detailScrollRef.current.scrollBy(-10);
              return "handled";
          }
        }
        return "pass";
      }

      const maxIdx = Math.max(0, state.summaries.length - 1);

      switch (key.name) {
        case "j":
        case "down":
          dispatch({ type: "RUNS_CURSOR", index: Math.min(state.cursorIndex + 1, maxIdx) });
          return "handled";
        case "k":
        case "up":
          dispatch({ type: "RUNS_CURSOR", index: Math.max(state.cursorIndex - 1, 0) });
          return "handled";
        case "return":
          if (state.summaries.length > 0) {
            const runId = state.summaries[state.cursorIndex].id;
            loadRun(runId).then(
              (run) => dispatch({ type: "RUNS_DETAIL", run }),
              () => dispatch({ type: "RUNS_ERROR", message: `Failed to load run ${runId}` }),
            );
          }
          return "handled";
        case "d":
          if (state.summaries.length > 0) {
            dispatch({
              type: "RUNS_CONFIRM_DELETE",
              runId: state.summaries[state.cursorIndex].id,
            });
          }
          return "handled";
        case "r":
          loadData();
          return "handled";
        default:
          return "pass";
      }
    },
  });

  const handleConfirmDelete = useCallback(async () => {
    if (!state.confirmDelete) return;
    const runId = state.confirmDelete;
    setDeleteProgress("Deleting...");
    dispatch({ type: "RUNS_CANCEL_DELETE" });

    try {
      await deleteRunFull(runId, (step) => {
        setDeleteProgress(step);
      });
      const summaries = await listRunSummaries();
      dispatch({ type: "RUNS_DELETE_DONE", summaries });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "RUNS_ERROR", message: `Delete failed: ${msg}` });
    } finally {
      setDeleteProgress(null);
    }
  }, [state.confirmDelete, dispatch]);

  const handleCancelDelete = useCallback(() => {
    dispatch({ type: "RUNS_CANCEL_DELETE" });
  }, [dispatch]);

  // ── Render ────────────────────────────────────────

  if (state.loading) {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.gray}>Loading runs...</text>
      </box>
    );
  }

  if (deleteProgress) {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.yellow}>{deleteProgress}</text>
      </box>
    );
  }

  if (state.error) {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1} flexDirection="column">
        <box><text fg={palette.red}>{state.error}</text></box>
        <box><text fg={palette.gray}>Press r to retry.</text></box>
      </box>
    );
  }

  if (state.summaries.length === 0) {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.gray}>No runs found.</text>
      </box>
    );
  }

  // ── Detail mode ───────────────────────────────────
  if (state.mode === "detail" && state.detailRun) {
    const run = state.detailRun;
    const modelsStr = run.config.models.map((m) => m.label).join(", ");
    const metaRows = [
      { label: "Models", value: modelsStr },
      { label: "Prompts", value: String(run.config.prompts.length) },
      { label: "Cost", value: `$${run.meta.totalCost.toFixed(4)}` },
      { label: "Duration", value: formatDuration(run.meta.durationMs) },
    ];

    const metaColumns: Column<{ label: string; value: string }>[] = [
      { header: "Field", width: 12, value: (r) => r.label, color: () => palette.gray },
      { header: "Value", value: (r) => r.value, color: () => palette.fg },
    ];

    return (
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <scrollbox ref={detailScrollRef} flexGrow={1} paddingTop={1}>
          <Table
            title={`Run: ${run.config.id}`}
            data={metaRows}
            columns={metaColumns}
            keyFn={(r) => r.label}
          />
          {run.elo.initial.ratings.length > 0 && (
            <EloTable
              title="Writer ELO (Initial)"
              ratings={run.elo.initial.ratings}
            />
          )}
          {run.elo.revised.ratings.length > 0 && (
            <EloTable
              title="Writer ELO (Revised)"
              ratings={run.elo.revised.ratings}
            />
          )}
          {run.elo.revised.feedbackRatings && run.elo.revised.feedbackRatings.length > 0 && (
            <EloTable
              title="Feedback Provider ELO"
              ratings={run.elo.revised.feedbackRatings}
            />
          )}
        </scrollbox>
        <box marginTop={1}>
          <text fg={palette.gray}>[ESC] back to list</text>
        </box>
      </box>
    );
  }

  // ── List mode ─────────────────────────────────────
  const listColumns: Column<typeof state.summaries[number]>[] = [
    {
      header: "  ID",
      width: 30,
      value: (s, i) => `${i === state.cursorIndex ? "> " : "  "}${s.id}`,
    },
    {
      header: "Models",
      width: 32,
      value: (s) => {
        const models = s.models.join(", ");
        return models.length > 30 ? models.slice(0, 27) + "..." : models;
      },
      color: () => palette.gray,
    },
    {
      header: "Prm",
      width: 3,
      align: "right",
      value: (s) => String(s.promptCount),
      color: () => palette.gray,
    },
    {
      header: "Cost",
      width: 9,
      align: "right",
      value: (s) => `$${s.totalCost.toFixed(4)}`,
      color: () => palette.green,
    },
    {
      header: "Duration",
      width: 8,
      align: "right",
      value: (s) => formatDuration(s.durationMs),
      color: () => palette.cyan,
    },
  ];

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <box marginTop={1} marginBottom={1}>
        <text>
          <span attributes={1} fg={palette.fg}>Historical Runs</span>
          <span fg={palette.gray}>  ({state.summaries.length} run{state.summaries.length !== 1 ? "s" : ""})</span>
        </text>
      </box>

      <scrollbox ref={listScrollRef} flexGrow={1}>
        <Table
          data={state.summaries}
          columns={listColumns}
          keyFn={(s) => s.id}
          rowFg={(_s, i) => i === state.cursorIndex ? palette.cyan : palette.fg}
          marginBottom={0}
        />
      </scrollbox>

      {/* Action bar / confirmation */}
      {state.confirmDelete ? (
        <ConfirmPrompt
          message={`Delete run ${state.confirmDelete}? This rebuilds cumulative ELO.`}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      ) : (
        <box paddingLeft={1} marginTop={1}>
          <text fg={palette.gray}>[Enter] detail  [d]elete  [r]efresh</text>
        </box>
      )}
    </box>
  );
}
