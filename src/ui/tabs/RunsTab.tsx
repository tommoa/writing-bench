import { useEffect, useCallback, useState, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { EloTable } from "../EloTable.js";
import { ConfirmPrompt } from "../ConfirmPrompt.js";
import { loadRun } from "../../storage/run-store.js";
import { deleteRunFull, listRunSummaries } from "../../storage/run-store.js";
import type { AppAction, RunsTabState, TabId } from "../state.js";
import type { TerminalPalette } from "../../types.js";

interface RunsTabProps {
  state: RunsTabState;
  activeTab: TabId;
  dispatch: (action: AppAction) => void;
  palette: TerminalPalette;
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

export function RunsTab({ state, activeTab, dispatch, palette }: RunsTabProps) {
  const isActive = activeTab === "runs";
  const [deleteProgress, setDeleteProgress] = useState<string | null>(null);
  const listScrollRef = useRef<any>(null);
  const detailScrollRef = useRef<any>(null);

  // Scroll to keep cursor visible in list mode
  useEffect(() => {
    if (listScrollRef.current && state.mode === "list" && state.summaries.length > 0) {
      listScrollRef.current.scrollTo(state.cursorIndex);
    }
  }, [state.cursorIndex]);

  // Load data on first visit
  useEffect(() => {
    if (isActive && !state.loading && !state.loaded) {
      loadRunsData(dispatch);
    }
  }, [isActive]);

  // Keyboard navigation (only when this tab is active)
  useKeyboard((key) => {
    if (!isActive || state.confirmDelete || deleteProgress) return;

    if (state.mode === "detail") {
      if (key.name === "escape") {
        dispatch({ type: "RUNS_BACK" });
      } else if (detailScrollRef.current) {
        switch (key.name) {
          case "j": case "down":
            detailScrollRef.current.scrollBy(1);
            break;
          case "k": case "up":
            detailScrollRef.current.scrollBy(-1);
            break;
          case "pagedown":
            detailScrollRef.current.scrollBy(10);
            break;
          case "pageup":
            detailScrollRef.current.scrollBy(-10);
            break;
        }
      }
      return;
    }

    // List mode
    const maxIdx = Math.max(0, state.summaries.length - 1);

    switch (key.name) {
      case "j":
      case "down":
        dispatch({ type: "RUNS_CURSOR", index: Math.min(state.cursorIndex + 1, maxIdx) });
        break;
      case "k":
      case "up":
        dispatch({ type: "RUNS_CURSOR", index: Math.max(state.cursorIndex - 1, 0) });
        break;
      case "return":
        if (state.summaries.length > 0) {
          const runId = state.summaries[state.cursorIndex].id;
          loadRun(runId).then(
            (run) => dispatch({ type: "RUNS_DETAIL", run }),
            () => dispatch({ type: "RUNS_ERROR", message: `Failed to load run ${runId}` }),
          );
        }
        break;
      case "d":
        if (state.summaries.length > 0) {
          dispatch({
            type: "RUNS_CONFIRM_DELETE",
            runId: state.summaries[state.cursorIndex].id,
          });
        }
        break;
      case "r":
        loadRunsData(dispatch);
        break;
    }
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
    const fieldW = 12;
    const modelsStr = run.config.models.map((m) => m.label).join(", ");
    const metaRows = [
      { label: "Models", value: modelsStr },
      { label: "Prompts", value: String(run.config.prompts.length) },
      { label: "Cost", value: `$${run.meta.totalCost.toFixed(4)}` },
      { label: "Duration", value: formatDuration(run.meta.durationMs) },
    ];
    const metaSepLen = fieldW + Math.max(...metaRows.map((r) => r.value.length));

    return (
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <scrollbox ref={detailScrollRef} flexGrow={1} paddingTop={1}>
          <box flexDirection="column" marginBottom={1}>
            <text fg={palette.yellow} attributes={1}>Run: {run.config.id}</text>
            <text fg={palette.gray}>{"Field".padEnd(fieldW)}Value</text>
            <text fg={palette.gray}>{"\u2500".repeat(metaSepLen)}</text>
            {metaRows.map((row) => (
              <text key={row.label}>
                <span fg={palette.gray}>{row.label.padEnd(fieldW)}</span>
                <span fg={palette.fg}>{row.value}</span>
              </text>
            ))}
          </box>
          {run.elo.initial.ratings.length > 0 && (
            <EloTable
              title="Writer ELO (Initial)"
              ratings={run.elo.initial.ratings}
              palette={palette}
            />
          )}
          {run.elo.revised.ratings.length > 0 && (
            <EloTable
              title="Writer ELO (Revised)"
              ratings={run.elo.revised.ratings}
              palette={palette}
            />
          )}
          {run.elo.revised.feedbackRatings && run.elo.revised.feedbackRatings.length > 0 && (
            <EloTable
              title="Feedback Provider ELO"
              ratings={run.elo.revised.feedbackRatings}
              palette={palette}
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
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <box marginTop={1} marginBottom={1}>
        <text>
          <span attributes={1} fg={palette.fg}>Historical Runs</span>
          <span fg={palette.gray}>  ({state.summaries.length} run{state.summaries.length !== 1 ? "s" : ""})</span>
        </text>
      </box>

      <scrollbox ref={listScrollRef} flexGrow={1}>
        {state.summaries.map((s, i) => {
          const selected = i === state.cursorIndex;
          const prefix = selected ? "> " : "  ";
          const fg = selected ? palette.cyan : palette.fg;
          const models = s.models.join(", ");
          const modelsTrunc = models.length > 30 ? models.slice(0, 27) + "..." : models;
          return (
            <text key={s.id} fg={fg}>
              {prefix}{s.id.padEnd(28)} {modelsTrunc.padEnd(32)} {String(s.promptCount).padStart(3)}p  ${s.totalCost.toFixed(4).padStart(8)}  {formatDuration(s.durationMs).padStart(7)}
            </text>
          );
        })}
      </scrollbox>

      {/* Action bar / confirmation */}
      {state.confirmDelete ? (
        <ConfirmPrompt
          message={`Delete run ${state.confirmDelete}? This rebuilds cumulative ELO.`}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
          palette={palette}
        />
      ) : (
        <box paddingLeft={1} marginTop={1}>
          <text fg={palette.gray}>[Enter] detail  [d]elete  [r]efresh</text>
        </box>
      )}
    </box>
  );
}
