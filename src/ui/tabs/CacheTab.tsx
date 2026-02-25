import { useEffect, useCallback, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { join, dirname } from "path";
import { rm } from "fs/promises";
import { existsSync } from "fs";
import { ConfirmPrompt } from "../ConfirmPrompt.js";
import { useKeyboardScope } from "../keyboard/use-keyboard-scope.js";
import { KEYBOARD_SCOPE_PRIORITY } from "../keyboard/types.js";
import { computeCacheDiskSize } from "../../storage/cache-status.js";
import { trimModelOutputs, specFromModelKey, discoverModelKeys } from "../../storage/sample-cache.js";
import { safeReaddir, removeIfEmpty } from "../../storage/fs-utils.js";
import type { AppAction, CacheTabState, CacheModelEntry, TabId } from "../state.js";
import type { Column } from "../Table.js";
import { Table, computeTableLayout } from "../Table.js";
import { usePalette } from "../PaletteContext.js";
import { useLoadOnTabActivation } from "./use-load-on-tab-activation.js";
import { scrollToTableCursor } from "../scroll-utils.js";

const CACHE_DIR = join(process.cwd(), "data", "cache");
const CATEGORIES = ["writes", "feedback", "revisions", "judgments"] as const;
interface CacheTabProps {
  state: CacheTabState;
  activeTab: TabId;
  dispatch: (action: AppAction) => void;
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
    const keys = await discoverModelKeys(join(CACHE_DIR, cat));
    for (const k of keys) keySet.add(k);
  }

  const entries: CacheModelEntry[] = [];
  for (const key of [...keySet].sort()) {
    const [writes, feedback, revisions, judgments] = await Promise.all(
      CATEGORIES.map((cat) => countFiles(cat, key)),
    );
    const displayName = specFromModelKey(key) ?? key;
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
      await removeIfEmpty(dirname(dir), join(CACHE_DIR, cat));
    }
  }
}

// ── Column Definitions ─────────────────────────────

interface DiskRow {
  label: string;
  size: number;
}

const DISK_COLUMNS: Column<DiskRow>[] = [
  { header: "Category", width: 12, value: (r) => r.label },
  {
    header: "Size",
    width: 10,
    align: "right",
    value: (r) => formatBytes(r.size),
  },
];

// ── Component ───────────────────────────────────────

export function CacheTab({ state, activeTab, dispatch }: CacheTabProps) {
  const palette = usePalette();
  const isActive = activeTab === "cache";
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadData = useCallback(() => {
    void loadCacheData(dispatch);
  }, [dispatch]);

  // Scroll to keep cursor visible when it changes.
  useEffect(() => {
    if (scrollRef.current && state.models.length > 0) {
      scrollToTableCursor(scrollRef.current, state.cursorIndex);
    }
  }, [state.cursorIndex]);

  useLoadOnTabActivation({
    isActive,
    loading: state.loading,
    loaded: state.diskSize !== null || state.error !== null,
    load: loadData,
  });

  useKeyboardScope({
    id: "cache-tab",
    priority: KEYBOARD_SCOPE_PRIORITY["tab-local"],
    enabled: isActive && state.confirmAction === null,
    onKey: (key) => {
      const maxIdx = Math.max(0, state.models.length - 1);

      switch (key.name) {
        case "j":
        case "down":
          dispatch({ type: "CACHE_CURSOR", index: Math.min(state.cursorIndex + 1, maxIdx) });
          return "handled";
        case "k":
        case "up":
          dispatch({ type: "CACHE_CURSOR", index: Math.max(state.cursorIndex - 1, 0) });
          return "handled";
        case "t":
          if (state.models.length > 0) {
            dispatch({
              type: "CACHE_CONFIRM",
              action: { type: "trim", model: state.models[state.cursorIndex].key },
            });
          }
          return "handled";
        case "d":
          if (state.models.length > 0) {
            dispatch({
              type: "CACHE_CONFIRM",
              action: { type: "delete", model: state.models[state.cursorIndex].key },
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

  const diskRows: DiskRow[] = [
    { label: "Writes", size: ds.writes },
    { label: "Feedback", size: ds.feedback },
    { label: "Revisions", size: ds.revisions },
    { label: "Judgments", size: ds.judgments },
  ];

  const diskLayout = computeTableLayout(DISK_COLUMNS, diskRows);

  // ── Model list table columns (depend on render-time state) ──
  const modelColumns: Column<CacheModelEntry>[] = [
    {
      header: "  Model",
      computeWidth: (data) => 2 + Math.max(5, ...data.map((m) => m.displayName.length)),
      value: (m, i) => {
        const prefix = i === state.cursorIndex ? "> " : "  ";
        return prefix + m.displayName;
      },
    },
    { header: "Writes", width: 6, align: "right", value: (m) => String(m.writes) },
    { header: "Feedbk", width: 6, align: "right", value: (m) => String(m.feedback) },
    { header: "Revise", width: 6, align: "right", value: (m) => String(m.revisions) },
    { header: "Judge", width: 6, align: "right", value: (m) => String(m.judgments) },
  ];

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1}>
      {/* ── Disk usage table ───────────────────────── */}
      <box paddingTop={1}>
        <Table
          title="Cache Disk Usage"
          data={diskRows}
          columns={DISK_COLUMNS}
          keyFn={(r) => r.label}
          marginBottom={1}
        >
          <box>
            <text fg={palette.gray}>{"\u2500".repeat(diskLayout.sepLen)}</text>
          </box>
          <box>
            <text>
              <span fg={palette.fg} attributes={1}>{"Total".padEnd(12)}</span>
              <span fg={palette.green} attributes={1}>{diskLayout.gap}{formatBytes(ds.total).padStart(10)}</span>
            </text>
          </box>
        </Table>
      </box>

      {/* ── Model list table ───────────────────────── */}
      <box marginBottom={1}>
        <text fg={palette.yellow} attributes={1}>Models</text>
      </box>
      <scrollbox ref={scrollRef} flexGrow={1}>
        <Table
          data={state.models}
          columns={modelColumns}
          keyFn={(m) => m.key}
          rowFg={(_row, i) => i === state.cursorIndex ? palette.cyan : palette.fg}
          marginBottom={0}
        />
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
        />
      ) : (
        <box paddingLeft={1} marginTop={1}>
          <text fg={palette.gray}>[t]rim  [d]elete  [r]efresh</text>
        </box>
      )}
    </box>
  );
}
