import { useEffect, useCallback, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { join } from "path";
import { rm } from "fs/promises";
import { existsSync } from "fs";
import { ConfirmPrompt } from "../ConfirmPrompt.js";
import { computeCacheDiskSize } from "../../storage/cache-status.js";
import { reverseModelKey } from "../../storage/cache-status.js";
import { trimModelOutputs } from "../../storage/sample-cache.js";
import { safeReaddir } from "../../storage/fs-utils.js";
import type { AppAction, CacheTabState, CacheModelEntry, TabId } from "../state.js";
import type { TerminalPalette } from "../../types.js";

const CACHE_DIR = join(process.cwd(), "data", "cache");
const CATEGORIES = ["writes", "feedback", "revisions", "judgments"] as const;

interface CacheTabProps {
  state: CacheTabState;
  activeTab: TabId;
  dispatch: (action: AppAction) => void;
  palette: TerminalPalette;
}

// ── Helpers ─────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Count files in a cache category directory for a given model key. */
async function countFiles(category: string, modelKey: string): Promise<number> {
  const dir = join(CACHE_DIR, category, modelKey);
  if (!existsSync(dir)) return 0;
  const entries = await safeReaddir(dir);
  return entries.length;
}

/** Discover all model keys across cache categories and count their files. */
async function discoverModels(): Promise<CacheModelEntry[]> {
  const keySet = new Set<string>();
  for (const cat of CATEGORIES) {
    const dirs = await safeReaddir(join(CACHE_DIR, cat));
    for (const d of dirs) keySet.add(d);
  }

  const entries: CacheModelEntry[] = [];
  for (const key of [...keySet].sort()) {
    const [writes, feedback, revisions, judgments] = await Promise.all(
      CATEGORIES.map((cat) => countFiles(cat, key)),
    );
    const displayName = reverseModelKey(key) ?? key;
    entries.push({ key, displayName, writes, feedback, revisions, judgments });
  }
  return entries;
}

/** Load all cache data for the tab. */
async function loadCacheData(dispatch: (action: AppAction) => void) {
  dispatch({ type: "CACHE_LOADING" });
  try {
    const [diskSize, models] = await Promise.all([
      computeCacheDiskSize(CACHE_DIR),
      discoverModels(),
    ]);
    dispatch({ type: "CACHE_LOADED", diskSize, models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dispatch({ type: "CACHE_ERROR", message: `Failed to load cache: ${msg}` });
  }
}

/** Delete all cache directories for a model key. */
async function deleteModelCache(modelKey: string): Promise<void> {
  for (const cat of CATEGORIES) {
    const dir = join(CACHE_DIR, cat, modelKey);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true });
    }
  }
}

// ── Component ───────────────────────────────────────

// Lines before the first model row in the scrollbox:
// disk usage (title+header+sep+4rows+sep+total = 8) + marginBottom(1)
// + model header (title+header+sep = 3) = 12
const MODEL_LIST_OFFSET = 12;

export function CacheTab({ state, activeTab, dispatch, palette }: CacheTabProps) {
  const isActive = activeTab === "cache";
  const scrollRef = useRef<any>(null);

  // Scroll to keep cursor visible when it changes
  useEffect(() => {
    if (scrollRef.current && state.models.length > 0) {
      scrollRef.current.scrollTo(MODEL_LIST_OFFSET + state.cursorIndex);
    }
  }, [state.cursorIndex]);

  // Load data on first visit
  useEffect(() => {
    if (isActive && !state.loading && state.diskSize === null) {
      loadCacheData(dispatch);
    }
  }, [isActive]);

  // Keyboard navigation (only when this tab is active)
  useKeyboard((key) => {
    if (!isActive || state.confirmAction) return;

    const maxIdx = Math.max(0, state.models.length - 1);

    switch (key.name) {
      case "j":
      case "down":
        dispatch({ type: "CACHE_CURSOR", index: Math.min(state.cursorIndex + 1, maxIdx) });
        break;
      case "k":
      case "up":
        dispatch({ type: "CACHE_CURSOR", index: Math.max(state.cursorIndex - 1, 0) });
        break;
      case "t":
        if (state.models.length > 0) {
          dispatch({
            type: "CACHE_CONFIRM",
            action: { type: "trim", model: state.models[state.cursorIndex].key },
          });
        }
        break;
      case "d":
        if (state.models.length > 0) {
          dispatch({
            type: "CACHE_CONFIRM",
            action: { type: "delete", model: state.models[state.cursorIndex].key },
          });
        }
        break;
      case "r":
        loadCacheData(dispatch);
        break;
    }
  });

  const handleConfirm = useCallback(async () => {
    if (!state.confirmAction) return;
    const { type, model } = state.confirmAction;
    dispatch({ type: "CACHE_ACTION_DONE" });

    try {
      if (type === "trim") {
        // Trim to 1 output per prompt (conservative default)
        await trimModelOutputs(CACHE_DIR, model, 1);
      } else {
        await deleteModelCache(model);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "CACHE_ERROR", message: `${type} failed: ${msg}` });
      return;
    }

    await loadCacheData(dispatch);
  }, [state.confirmAction, dispatch]);

  const handleCancel = useCallback(() => {
    dispatch({ type: "CACHE_CANCEL" });
  }, [dispatch]);

  // ── Render ────────────────────────────────────────

  if (state.loading) {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.gray}>Loading cache data...</text>
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

  if (state.models.length === 0 && state.diskSize) {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.gray}>No cache data found.</text>
      </box>
    );
  }

  if (!state.diskSize) {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.gray}>Press r to load cache data.</text>
      </box>
    );
  }

  const ds = state.diskSize;

  // ── Disk usage table layout ──────────────────────
  const catW = 12;
  const sizeW = 10;
  const diskSepLen = catW + sizeW;
  const diskHeader = "Category".padEnd(catW) + "Size".padStart(sizeW);
  const diskRows = [
    { label: "Writes", size: ds.writes },
    { label: "Feedback", size: ds.feedback },
    { label: "Revisions", size: ds.revisions },
    { label: "Judgments", size: ds.judgments },
  ];

  // ── Model list table layout ──────────────────────
  const nameW = Math.max(5, ...state.models.map((m) => m.displayName.length)) + 2;
  const colW = 6;
  const modelHeader =
    "  " + "Model".padEnd(nameW) +
    "Writes".padStart(colW) +
    "  " + "Feedbk".padStart(colW) +
    "  " + "Revise".padStart(colW) +
    "  " + "Judge".padStart(colW);
  const modelSepLen = 2 + nameW + colW * 4 + 6;

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <scrollbox ref={scrollRef} flexGrow={1} paddingTop={1}>
        {/* ── Disk usage table ─────────────────────── */}
        <box flexDirection="column" marginBottom={1}>
          <text fg={palette.yellow} attributes={1}>Cache Disk Usage</text>
          <text fg={palette.gray}>{diskHeader}</text>
          <text fg={palette.gray}>{"\u2500".repeat(diskSepLen)}</text>
          {diskRows.map((row) => (
            <text key={row.label}>
              <span fg={palette.fg}>{row.label.padEnd(catW)}</span>
              <span fg={palette.green}>{formatBytes(row.size).padStart(sizeW)}</span>
            </text>
          ))}
          <text fg={palette.gray}>{"\u2500".repeat(diskSepLen)}</text>
          <text>
            <span fg={palette.fg} attributes={1}>{"Total".padEnd(catW)}</span>
            <span fg={palette.green} attributes={1}>{formatBytes(ds.total).padStart(sizeW)}</span>
          </text>
        </box>

        {/* ── Model list table ─────────────────────── */}
        <box flexDirection="column" marginBottom={1}>
          <text fg={palette.yellow} attributes={1}>Models</text>
          <text fg={palette.gray}>{modelHeader}</text>
          <text fg={palette.gray}>{"\u2500".repeat(modelSepLen)}</text>
          {state.models.map((m, i) => {
            const selected = i === state.cursorIndex;
            const prefix = selected ? "> " : "  ";
            const fg = selected ? palette.cyan : palette.fg;
            return (
              <text key={m.key} fg={fg}>
                {prefix}{m.displayName.padEnd(nameW)}{String(m.writes).padStart(colW)}{"  "}{String(m.feedback).padStart(colW)}{"  "}{String(m.revisions).padStart(colW)}{"  "}{String(m.judgments).padStart(colW)}
              </text>
            );
          })}
        </box>
      </scrollbox>

      {/* ── Action bar / confirmation ────────────── */}
      {state.confirmAction ? (
        <ConfirmPrompt
          message={
            state.confirmAction.type === "trim"
              ? `Trim ${state.confirmAction.model} to 1 output per prompt?`
              : `Delete all cache for ${state.confirmAction.model}?`
          }
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          palette={palette}
        />
      ) : (
        <box paddingLeft={1} marginTop={1}>
          <text fg={palette.gray}>[t]rim  [d]elete  [r]efresh</text>
        </box>
      )}
    </box>
  );
}
