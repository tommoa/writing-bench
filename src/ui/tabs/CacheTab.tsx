import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { join } from "path";
import { existsSync } from "fs";
import { ConfirmPrompt } from "../ConfirmPrompt.js";
import { TextInput } from "../TextInput.js";
import { useKeyboardScope } from "../keyboard/use-keyboard-scope.js";
import { KEYBOARD_SCOPE_PRIORITY } from "../keyboard/types.js";
import {
  analyzeCacheStatus,
  computeCacheDiskSize,
  formatBytes as formatCacheBytes,
  projectCoveringsByModel,
  type CacheStatusResult,
  type Covering,
  type CoveringModelProjection,
} from "../../storage/cache-status.js";
import {
  trimModelOutputs,
  clearModelCache,
  specFromModelKey,
  discoverModelKeys,
  combineModelCaches,
  listModelCacheArtifacts,
  loadModelCacheArtifact,
  loadJudgmentComparedOutputs,
  formatCacheArtifactDetail,
  modelKey,
  type CacheArtifactCategory,
  type CacheArtifactDetail,
  type CacheArtifactSummary,
  type JudgmentComparedPair,
} from "../../storage/sample-cache.js";
import { safeReaddir } from "../../storage/fs-utils.js";
import { loadPrompts } from "../../config.js";
import { parseModelSpec } from "../../providers/registry.js";
import { loadLatestRun } from "../../storage/run-store.js";
import type { AppAction, CacheTabState, CacheModelEntry, TabId } from "../state.js";
import type { Column } from "../Table.js";
import { Table } from "../Table.js";
import { usePalette } from "../PaletteContext.js";
import { useLoadOnTabActivation } from "./use-load-on-tab-activation.js";
import { keepTableCursorVisible } from "../scroll-utils.js";

const CACHE_DIR = join(process.cwd(), "data", "cache");
const CATEGORIES = ["writes", "feedback", "revisions", "judgments"] as const;

type CacheViewMode = "overview" | "browser" | "cross";

interface CacheTabProps {
  state: CacheTabState;
  activeTab: TabId;
  dispatch: (action: AppAction) => void;
}

interface MergeDraft {
  sourceModel: string;
  useExisting: boolean;
  targetCursor: number;
  targetSpec: string;
  error: string | null;
}

interface WriteCrossRow {
  promptHash: string;
  outputIndex: number;
  models: string[];
  previews: Record<string, string>;
}

interface CrossSectionState {
  loading: boolean;
  error: string | null;
  promptSourceLabel: string;
  coverageHint: string;
  coverings: Covering[];
  modelStats: CoveringModelProjection[];
  selectedCovering: number;
  focus: "coverings" | "combos";
  comboRows: WriteCrossRow[];
  comboCursor: number;
  coveringCursor: number;
}

const FILTER_OPTIONS: Array<{ label: string; value: CacheArtifactCategory | "all" }> = [
  { label: "All", value: "all" },
  { label: "Writes", value: "writes" },
  { label: "Feedback", value: "feedback" },
  { label: "Revisions", value: "revisions" },
  { label: "Judgments", value: "judgments" },
];

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 3) + "...";
}

function buildCoverageHint(summary: CacheStatusResult["summary"]): string {
  const stageDefs: Array<{ key: keyof CacheStatusResult["summary"]; label: string }> = [
    { key: "writes", label: "writes" },
    { key: "initialJudgments", label: "initial judgments" },
    { key: "feedback", label: "feedback" },
    { key: "revisions", label: "revisions" },
    { key: "improvementJudgments", label: "improvement judgments" },
    { key: "revisedJudgments", label: "revised judgments" },
  ];
  const missing = stageDefs
    .map((stage) => ({
      label: stage.label,
      have: summary[stage.key].have,
      need: summary[stage.key].need,
    }))
    .filter((stage) => stage.need > 0 && stage.have < stage.need)
    .sort((a, b) => {
      const aRatio = a.need > 0 ? a.have / a.need : 1;
      const bRatio = b.need > 0 ? b.have / b.need : 1;
      return aRatio - bRatio;
    });

  if (missing.length === 0) {
    return "All pipeline stages are fully covered for the current prompt set.";
  }

  const top = missing[0];
  return `Largest gap: ${top.label} (${top.have}/${top.need}). Fully cached requires complete writes + feedback + revisions + judgments with >=2 writers.`;
}

async function countFiles(category: string, modelDirKey: string): Promise<number> {
  const dir = join(CACHE_DIR, category, modelDirKey);
  if (!existsSync(dir)) return 0;
  const entries = await safeReaddir(dir);
  return entries.length;
}

async function discoverModels(): Promise<CacheModelEntry[]> {
  const keySet = new Set<string>();
  for (const cat of CATEGORIES) {
    const keys = await discoverModelKeys(join(CACHE_DIR, cat));
    for (const key of keys) keySet.add(key);
  }

  const entries: CacheModelEntry[] = [];
  for (const key of [...keySet].sort()) {
    const [writes, feedback, revisions, judgments] = await Promise.all(
      CATEGORIES.map((cat) => countFiles(cat, key))
    );
    entries.push({
      key,
      displayName: specFromModelKey(key) ?? key,
      writes,
      feedback,
      revisions,
      judgments,
    });
  }
  return entries;
}

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

async function buildWriteCrossRows(modelDirKeys: string[]): Promise<WriteCrossRow[]> {
  const byCombo = new Map<string, WriteCrossRow>();

  await Promise.all(
    modelDirKeys.map(async (modelDirKey) => {
      const artifacts = await listModelCacheArtifacts(CACHE_DIR, modelDirKey);
      const writes = artifacts.filter((a) => a.category === "writes" && a.promptHash != null);
      for (const write of writes) {
        const outputIndex = write.outputIndex ?? 0;
        const comboKey = `${write.promptHash}:${outputIndex}`;
        const existing = byCombo.get(comboKey) ?? {
          promptHash: write.promptHash!,
          outputIndex,
          models: [],
          previews: {},
        };
        if (!existing.models.includes(modelDirKey)) {
          existing.models.push(modelDirKey);
        }
        existing.previews[modelDirKey] = write.preview;
        byCombo.set(comboKey, existing);
      }
    })
  );

  const rows = [...byCombo.values()]
    .filter((row) => row.models.length > 1)
    .sort((a, b) => {
      if (a.models.length !== b.models.length) {
        return b.models.length - a.models.length;
      }
      if (a.promptHash !== b.promptHash) {
        return a.promptHash.localeCompare(b.promptHash);
      }
      return a.outputIndex - b.outputIndex;
    });

  return rows;
}

interface DiskRow {
  label: string;
  size: number;
}
const DISK_LABEL_WIDTH = 12;
const DISK_SIZE_WIDTH = 10;

export function CacheTab({ state, activeTab, dispatch }: CacheTabProps) {
  const palette = usePalette();
  const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
  const isActive = activeTab === "cache";
  const [mode, setMode] = useState<CacheViewMode>("overview");
  const [notice, setNotice] = useState<string | null>(null);
  const [mergeDraft, setMergeDraft] = useState<MergeDraft | null>(null);

  const [browserModelKey, setBrowserModelKey] = useState<string | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [browserArtifacts, setBrowserArtifacts] = useState<CacheArtifactSummary[]>([]);
  const [browserFilter, setBrowserFilter] = useState<CacheArtifactCategory | "all">("all");
  const [browserFilterPickerOpen, setBrowserFilterPickerOpen] = useState(false);
  const [browserFilterCursor, setBrowserFilterCursor] = useState(0);
  const [browserCursor, setBrowserCursor] = useState(0);
  const [browserDetail, setBrowserDetail] = useState<CacheArtifactDetail | null>(null);
  const [browserJudgmentPair, setBrowserJudgmentPair] = useState<JudgmentComparedPair | null>(null);
  const [browserShowJudgmentOutputs, setBrowserShowJudgmentOutputs] = useState(false);

  const [cross, setCross] = useState<CrossSectionState>({
    loading: false,
    error: null,
    promptSourceLabel: "-",
    coverageHint: "",
    coverings: [],
    modelStats: [],
    selectedCovering: 0,
    focus: "coverings",
    comboRows: [],
    comboCursor: 0,
    coveringCursor: 0,
  });

  const overviewScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const crossCoveringsScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const crossCombosScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const loadData = useCallback(() => {
    void loadCacheData(dispatch);
  }, [dispatch]);

  const existingMergeTargets = useMemo(() => {
    if (!mergeDraft) return [];
    return state.models.filter((m) => m.key !== mergeDraft.sourceModel);
  }, [state.models, mergeDraft]);

  const filteredArtifacts = useMemo(() => {
    if (browserFilter === "all") {
      return browserArtifacts;
    }
    return browserArtifacts.filter((a) => a.category === browserFilter);
  }, [browserArtifacts, browserFilter]);

  const activeCovering = cross.coverings[cross.selectedCovering] ?? null;

  const constrainedComboRows = useMemo(() => {
    if (!activeCovering) {
      return cross.comboRows;
    }
    const writerSet = new Set(activeCovering.writerKeys);
    return cross.comboRows
      .map((row) => {
        const models = row.models.filter((m) => writerSet.has(m));
        if (models.length < 2) return null;
        const previews: Record<string, string> = {};
        for (const modelDirKey of models) {
          previews[modelDirKey] = row.previews[modelDirKey] ?? "";
        }
        return {
          ...row,
          models,
          previews,
        };
      })
      .filter((row): row is WriteCrossRow => row != null);
  }, [cross.comboRows, activeCovering]);

  const overviewViewportRows = Math.max(6, terminalHeight - 16);
  const browserViewportRows = Math.max(6, terminalHeight - (browserFilterPickerOpen ? 20 : 10));
  const browserTableWidth = Math.max(40, terminalWidth - 4);
  const crossTableWidth = Math.max(40, terminalWidth - 4);
  const detailTableWidth = Math.max(40, terminalWidth - 4);
  const browserWindowSize = Math.max(10, browserViewportRows - 1);
  const browserWindowStart = useMemo(() => {
    if (filteredArtifacts.length <= browserWindowSize) {
      return 0;
    }
    const half = Math.floor(browserWindowSize / 2);
    return Math.max(
      0,
      Math.min(browserCursor - half, filteredArtifacts.length - browserWindowSize)
    );
  }, [browserCursor, filteredArtifacts.length, browserWindowSize]);
  const browserWindowData = useMemo(
    () => filteredArtifacts.slice(browserWindowStart, browserWindowStart + browserWindowSize),
    [filteredArtifacts, browserWindowStart, browserWindowSize]
  );

  useEffect(() => {
    if (mode === "overview" && overviewScrollRef.current && state.models.length > 0) {
      keepTableCursorVisible(overviewScrollRef.current, state.cursorIndex, overviewViewportRows);
    }
  }, [mode, state.cursorIndex, state.models.length, overviewViewportRows]);

  useEffect(() => {
    if (mode === "cross" && cross.focus === "coverings" && crossCoveringsScrollRef.current) {
      keepTableCursorVisible(crossCoveringsScrollRef.current, cross.coveringCursor, 8);
    }
    if (mode === "cross" && cross.focus === "combos" && crossCombosScrollRef.current) {
      keepTableCursorVisible(crossCombosScrollRef.current, cross.comboCursor, 8);
    }
  }, [mode, cross.focus, cross.coveringCursor, cross.comboCursor]);

  useLoadOnTabActivation({
    isActive,
    loading: state.loading,
    loaded: state.diskSize !== null || state.error !== null,
    load: loadData,
  });

  const loadBrowser = useCallback(async (modelDirKey: string) => {
    setBrowserLoading(true);
    setBrowserError(null);
    setBrowserDetail(null);
    setBrowserJudgmentPair(null);
    setBrowserShowJudgmentOutputs(false);
    try {
      const artifacts = await listModelCacheArtifacts(CACHE_DIR, modelDirKey);
      setBrowserArtifacts(artifacts);
      setBrowserCursor(0);
      setBrowserFilter("all");
      setBrowserFilterCursor(0);
      setBrowserFilterPickerOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBrowserError(`Failed to load model artifacts: ${msg}`);
    } finally {
      setBrowserLoading(false);
    }
  }, []);

  const openBrowserForSelected = useCallback(() => {
    if (state.models.length === 0) {
      return;
    }
    const modelDirKey = state.models[state.cursorIndex].key;
    setBrowserModelKey(modelDirKey);
    setMode("browser");
    void loadBrowser(modelDirKey);
  }, [state.models, state.cursorIndex, loadBrowser]);

  const loadCrossSection = useCallback(async () => {
    setCross((prev) => ({ ...prev, loading: true, error: null }));
    try {
      let latestRun = null;
      try {
        latestRun = await loadLatestRun();
      } catch {
        latestRun = null;
      }
      const prompts = latestRun?.config.prompts.length
        ? latestRun.config.prompts
        : await loadPrompts("prompts/*.toml");
      const promptSourceLabel = latestRun?.config.prompts.length
        ? `latest run (${latestRun.config.id})`
        : "prompts/*.toml";

      const status = await analyzeCacheStatus({
        prompts,
        outputsPerModel: 0,
        cacheDir: CACHE_DIR,
      });
      const modelStats = projectCoveringsByModel(status.coverings);
      const writeModels = state.models.filter((m) => m.writes > 0).map((m) => m.key);
      const comboRows = await buildWriteCrossRows(writeModels);
      setCross({
        loading: false,
        error: null,
        promptSourceLabel,
        coverageHint: buildCoverageHint(status.summary),
        coverings: status.coverings,
        modelStats,
        selectedCovering: status.coverings.length > 0 ? 0 : -1,
        focus: "coverings",
        comboRows,
        comboCursor: 0,
        coveringCursor: 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCross((prev) => ({
        ...prev,
        loading: false,
        error: `Failed to load cross-sections: ${msg}`,
      }));
    }
  }, [state.models]);

  const startMerge = useCallback(() => {
    if (state.models.length === 0) {
      return;
    }
    const sourceModel = state.models[state.cursorIndex].key;
    setMergeDraft({
      sourceModel,
      useExisting: true,
      targetCursor: 0,
      targetSpec: "",
      error: null,
    });
  }, [state.models, state.cursorIndex]);

  const confirmMergeFromDraft = useCallback(() => {
    if (!mergeDraft) return;

    if (mergeDraft.useExisting) {
      if (existingMergeTargets.length === 0) {
        setMergeDraft({ ...mergeDraft, error: "No other model is available as a merge target." });
        return;
      }
      const target = existingMergeTargets[Math.min(mergeDraft.targetCursor, existingMergeTargets.length - 1)];
      if (!target) return;
      if (target.key === mergeDraft.sourceModel) {
        setMergeDraft({ ...mergeDraft, error: "Source and target must be different." });
        return;
      }
      dispatch({
        type: "CACHE_CONFIRM",
        action: {
          type: "merge",
          sourceModel: mergeDraft.sourceModel,
          targetModel: target.key,
          targetSpec: target.displayName,
        },
      });
      setMergeDraft(null);
      return;
    }

    try {
      const parsed = parseModelSpec(mergeDraft.targetSpec.trim());
      const targetDirKey = modelKey(parsed.provider, parsed.model);
      if (targetDirKey === mergeDraft.sourceModel) {
        setMergeDraft({ ...mergeDraft, error: "Source and target resolve to the same model key." });
        return;
      }
      dispatch({
        type: "CACHE_CONFIRM",
        action: {
          type: "merge",
          sourceModel: mergeDraft.sourceModel,
          targetModel: targetDirKey,
          targetSpec: `${parsed.provider}:${parsed.model}`,
        },
      });
      setMergeDraft(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMergeDraft({ ...mergeDraft, error: msg });
    }
  }, [mergeDraft, existingMergeTargets, dispatch]);

  useKeyboardScope({
    id: "cache-merge-draft",
    priority: KEYBOARD_SCOPE_PRIORITY.modal,
    enabled: isActive && mergeDraft !== null && state.confirmAction === null,
    onKey: (key) => {
      if (!mergeDraft) return "pass";
      if (key.name === "escape") {
        setMergeDraft(null);
        return "handled";
      }
      if (key.name === "tab") {
        setMergeDraft({
          ...mergeDraft,
          useExisting: !mergeDraft.useExisting,
          error: null,
        });
        return "handled";
      }
      if (key.name === "return" && mergeDraft.useExisting) {
        confirmMergeFromDraft();
        return "handled";
      }
      if (mergeDraft.useExisting && (key.name === "j" || key.name === "down")) {
        const max = Math.max(0, existingMergeTargets.length - 1);
        setMergeDraft({
          ...mergeDraft,
          targetCursor: Math.min(mergeDraft.targetCursor + 1, max),
          error: null,
        });
        return "handled";
      }
      if (mergeDraft.useExisting && (key.name === "k" || key.name === "up")) {
        setMergeDraft({
          ...mergeDraft,
          targetCursor: Math.max(mergeDraft.targetCursor - 1, 0),
          error: null,
        });
        return "handled";
      }
      return "pass";
    },
  });

  useKeyboardScope({
    id: "cache-tab",
    priority: KEYBOARD_SCOPE_PRIORITY["tab-local"],
    enabled: isActive && state.confirmAction === null && mergeDraft === null,
    onKey: (key) => {
      const maxIdx = Math.max(0, state.models.length - 1);

      if (mode === "overview") {
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
          case "m":
            startMerge();
            return "handled";
          case "return":
          case "b":
            openBrowserForSelected();
            return "handled";
          case "x":
            setMode("cross");
            setNotice(null);
            void loadCrossSection();
            return "handled";
          case "r":
            setNotice(null);
            loadData();
            return "handled";
          default:
            return "pass";
        }
      }

      if (mode === "browser") {
        if (browserDetail) {
          switch (key.name) {
            case "escape":
              setBrowserDetail(null);
              setBrowserJudgmentPair(null);
              setBrowserShowJudgmentOutputs(false);
              return "handled";
            case "o":
              if (browserDetail.category !== "judgments") {
                return "handled";
              }
              if (browserJudgmentPair) {
                setBrowserShowJudgmentOutputs(!browserShowJudgmentOutputs);
                return "handled";
              }
              void loadJudgmentComparedOutputs(CACHE_DIR, browserDetail).then((pair) => {
                if (!pair) {
                  setBrowserError("Could not resolve compared outputs. This is usually a legacy judgment without pair metadata, or one where compared outputs are no longer present in cache/run history.");
                  return;
                }
                setBrowserJudgmentPair(pair);
                setBrowserShowJudgmentOutputs(true);
              });
              return "handled";
            case "j":
            case "down":
              detailScrollRef.current?.scrollBy(1);
              return "handled";
            case "k":
            case "up":
              detailScrollRef.current?.scrollBy(-1);
              return "handled";
            case "pagedown":
              detailScrollRef.current?.scrollBy(10);
              return "handled";
            case "pageup":
              detailScrollRef.current?.scrollBy(-10);
              return "handled";
            default:
              return "pass";
          }
        }

        if (browserFilterPickerOpen) {
          const maxFilterIdx = FILTER_OPTIONS.length - 1;
          switch (key.name) {
            case "j":
            case "down":
              setBrowserFilterCursor(Math.min(browserFilterCursor + 1, maxFilterIdx));
              return "handled";
            case "k":
            case "up":
              setBrowserFilterCursor(Math.max(browserFilterCursor - 1, 0));
              return "handled";
            case "return": {
              const chosen = FILTER_OPTIONS[browserFilterCursor];
              setBrowserFilter(chosen.value);
              setBrowserCursor(0);
              setBrowserFilterPickerOpen(false);
              return "handled";
            }
            case "escape":
              setBrowserFilterPickerOpen(false);
              return "handled";
            default:
              return "pass";
          }
        }

        const maxArtifactIdx = Math.max(0, filteredArtifacts.length - 1);
        switch (key.name) {
          case "j":
          case "down":
            setBrowserCursor(Math.min(browserCursor + 1, maxArtifactIdx));
            return "handled";
          case "k":
          case "up":
            setBrowserCursor(Math.max(browserCursor - 1, 0));
            return "handled";
          case "f": {
            const idx = FILTER_OPTIONS.findIndex((option) => option.value === browserFilter);
            setBrowserFilterCursor(idx >= 0 ? idx : 0);
            setBrowserFilterPickerOpen(true);
            return "handled";
          }
          case "return": {
            const selected = filteredArtifacts[browserCursor];
            if (!selected || !browserModelKey) return "handled";
            void loadModelCacheArtifact(
              CACHE_DIR,
              browserModelKey,
              selected.category,
              selected.artifactKey
            ).then((detail) => {
              if (detail) {
                setBrowserDetail(detail);
                setBrowserJudgmentPair(null);
                setBrowserShowJudgmentOutputs(false);
                setBrowserError(null);
                if (detail.category === "judgments") {
                  void loadJudgmentComparedOutputs(CACHE_DIR, detail).then((pair) => {
                    if (pair) {
                      setBrowserJudgmentPair(pair);
                    }
                  });
                }
              } else {
                setBrowserError("Failed to load artifact detail.");
              }
            });
            return "handled";
          }
          case "r":
            if (browserModelKey) {
              void loadBrowser(browserModelKey);
            }
            return "handled";
          case "escape":
            setBrowserFilterPickerOpen(false);
            setMode("overview");
            return "handled";
          default:
            return "pass";
        }
      }

      if (mode === "cross") {
        const maxCovering = Math.max(0, cross.coverings.length - 1);
        const maxCombo = Math.max(0, constrainedComboRows.length - 1);

        switch (key.name) {
          case "tab":
            setCross((prev) => ({
              ...prev,
              focus: prev.focus === "coverings" ? "combos" : "coverings",
            }));
            return "handled";
          case "j":
          case "down":
            if (cross.focus === "coverings") {
              setCross((prev) => ({ ...prev, coveringCursor: Math.min(prev.coveringCursor + 1, maxCovering) }));
            } else {
              setCross((prev) => ({ ...prev, comboCursor: Math.min(prev.comboCursor + 1, maxCombo) }));
            }
            return "handled";
          case "k":
          case "up":
            if (cross.focus === "coverings") {
              setCross((prev) => ({ ...prev, coveringCursor: Math.max(prev.coveringCursor - 1, 0) }));
            } else {
              setCross((prev) => ({ ...prev, comboCursor: Math.max(prev.comboCursor - 1, 0) }));
            }
            return "handled";
          case "return":
            if (cross.focus === "coverings") {
              setCross((prev) => ({ ...prev, selectedCovering: prev.coveringCursor, comboCursor: 0 }));
            }
            return "handled";
          case "r":
            void loadCrossSection();
            return "handled";
          case "escape":
            setMode("overview");
            return "handled";
          default:
            return "pass";
        }
      }

      return "pass";
    },
  });

  const handleConfirm = useCallback(async () => {
    if (!state.confirmAction) return;
    const action = state.confirmAction;
    dispatch({ type: "CACHE_ACTION_DONE" });
    setNotice(null);

    try {
      if (action.type === "trim") {
        await trimModelOutputs(CACHE_DIR, action.model, 1);
        setNotice(`Trimmed ${specFromModelKey(action.model) ?? action.model} to 1 output per prompt.`);
      } else if (action.type === "delete") {
        await clearModelCache(CACHE_DIR, action.model);
        setNotice(`Deleted all cache for ${specFromModelKey(action.model) ?? action.model}.`);
      } else {
        const result = await combineModelCaches(CACHE_DIR, action.sourceModel, action.targetModel);
        const conflictCount = result.feedbackConflicts + result.revisionsConflicts + result.judgmentsConflicts;
        setNotice(
          `Merged ${specFromModelKey(action.sourceModel) ?? action.sourceModel} into ${action.targetSpec} `
            + `(${result.writesMoved} writes, ${result.feedbackMoved} feedback, ${result.revisionsMoved} revisions, ${result.judgmentsMoved} judgments` 
            + `${conflictCount > 0 ? `, ${conflictCount} conflicts skipped` : ""}).`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "CACHE_ERROR", message: `Cache action failed: ${msg}` });
      return;
    }

    await loadCacheData(dispatch);
    if (mode === "browser" && browserModelKey) {
      await loadBrowser(browserModelKey);
    }
    if (mode === "cross") {
      await loadCrossSection();
    }
  }, [state.confirmAction, dispatch, mode, browserModelKey, loadBrowser, loadCrossSection]);

  const handleCancel = useCallback(() => {
    dispatch({ type: "CACHE_CANCEL" });
  }, [dispatch]);

  if (state.loading && mode === "overview") {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.gray}>Loading cache data...</text>
      </box>
    );
  }

  if (state.error && mode === "overview") {
    return (
      <box flexGrow={1} paddingLeft={1} paddingTop={1} flexDirection="column">
        <box><text fg={palette.red}>{state.error}</text></box>
        <box><text fg={palette.gray}>Press r to retry.</text></box>
      </box>
    );
  }

  if (mode === "browser") {
    const modelLabel = browserModelKey ? specFromModelKey(browserModelKey) ?? browserModelKey : "(none)";
    const detailText = browserDetail ? formatCacheArtifactDetail(browserDetail) : "";
    const firstComparedModel = browserJudgmentPair
      ? specFromModelKey(browserJudgmentPair.first.modelKey) ?? browserJudgmentPair.first.modelKey
      : "";
    const secondComparedModel = browserJudgmentPair
      ? specFromModelKey(browserJudgmentPair.second.modelKey) ?? browserJudgmentPair.second.modelKey
      : "";
    const artifactColumns: Column<CacheArtifactSummary>[] = [
      {
        header: "  Type",
        width: 12,
        value: (row, i) => `${browserWindowStart + i === browserCursor ? "> " : "  "}${row.category}`,
      },
      {
        header: "Key",
        width: 26,
        minWidth: 10,
        truncate: true,
        value: (row) => truncate(row.artifactKey, 26),
        color: () => palette.gray,
      },
      {
        header: "CacheId",
        width: 16,
        minWidth: 8,
        truncate: true,
        value: (row) => truncate(row.cacheId ?? "-", 16),
      },
      {
        header: "Compared",
        width: 30,
        minWidth: 10,
        truncate: true,
        value: (row) => truncate(row.comparisonLabel ?? "-", 30),
        color: () => palette.gray,
      },
      {
        header: "Preview",
        width: 34,
        minWidth: 12,
        truncate: true,
        value: (row) => truncate(row.preview || "(empty)", 34),
      },
    ];

    if (browserLoading) {
      return (
        <box flexGrow={1} paddingLeft={1} paddingTop={1}>
          <text fg={palette.gray}>Loading artifacts for {modelLabel}...</text>
        </box>
      );
    }

    return (
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <box paddingTop={1}><text fg={palette.yellow} attributes={1}>Model Browser: {modelLabel}</text></box>
        {browserError && <box><text fg={palette.red}>{browserError}</text></box>}

        {browserDetail ? (
          <>
            <box marginTop={1}><text fg={palette.cyan}>Detail: {browserDetail.category} / {browserDetail.artifactKey}</text></box>
            <scrollbox ref={detailScrollRef} flexGrow={1} marginTop={1}>
              <box flexDirection="column">
                <box>
                  <text fg={palette.fg}>{detailText}</text>
                </box>
                {browserJudgmentPair && (
                  <>
                    <box marginTop={1}><text fg={palette.cyan}>Resolved Pair</text></box>
                    <box><text fg={palette.gray}>A: {firstComparedModel} ({browserJudgmentPair.first.category}) -- {browserJudgmentPair.first.cacheId}</text></box>
                    <box><text fg={palette.gray}>B: {secondComparedModel} ({browserJudgmentPair.second.category}) -- {browserJudgmentPair.second.cacheId}</text></box>
                    {browserShowJudgmentOutputs && (
                      <>
                        <box marginTop={1}><text fg={palette.yellow}>Compared Output 1</text></box>
                        <box><text fg={palette.gray}>{firstComparedModel} ({browserJudgmentPair.first.category})</text></box>
                        <box><text fg={palette.gray}>Cache ID: {browserJudgmentPair.first.cacheId}</text></box>
                        <box><text fg={palette.fg}>{browserJudgmentPair.first.text}</text></box>
                        <box marginTop={1}><text fg={palette.yellow}>Compared Output 2</text></box>
                        <box><text fg={palette.gray}>{secondComparedModel} ({browserJudgmentPair.second.category})</text></box>
                        <box><text fg={palette.gray}>Cache ID: {browserJudgmentPair.second.cacheId}</text></box>
                        <box><text fg={palette.fg}>{browserJudgmentPair.second.text}</text></box>
                      </>
                    )}
                  </>
                )}
              </box>
            </scrollbox>
            <box marginTop={1}>
              <text fg={palette.gray}>
                {browserDetail.category === "judgments"
                  ? browserJudgmentPair
                    ? "[o] toggle compared outputs  [j/k] scroll  [Esc] back"
                    : "[o] resolve compared outputs  [j/k] scroll  [Esc] back"
                  : "[j/k] scroll  [Esc] back"}
              </text>
            </box>
          </>
        ) : (
          <>
            <box marginTop={1}><text fg={palette.gray}>Filter: {browserFilter}</text></box>
            {browserFilterPickerOpen && (
              <box flexDirection="column" marginTop={1}>
                <box><text fg={palette.yellow}>Select Category</text></box>
                {FILTER_OPTIONS.map((option, idx) => (
                  <box key={option.value}>
                    <text fg={idx === browserFilterCursor ? palette.cyan : palette.gray}>
                      {idx === browserFilterCursor ? "> " : "  "}
                      {option.label}
                    </text>
                  </box>
                ))}
                <box><text fg={palette.gray}>[j/k] move  [Enter] apply  [Esc] cancel</text></box>
              </box>
            )}
            {!browserFilterPickerOpen && (
              <>
                <box marginTop={1}>
                  <text fg={palette.gray}>
                    Showing {filteredArtifacts.length === 0 ? 0 : browserWindowStart + 1}
                    -{Math.min(filteredArtifacts.length, browserWindowStart + browserWindowData.length)}
                    {` of ${filteredArtifacts.length}`}
                  </text>
                </box>
                <Table
                  data={browserWindowData}
                  columns={artifactColumns}
                  maxWidth={browserTableWidth}
                  keyFn={(row) => `${row.category}:${row.artifactKey}`}
                  rowFg={(_row, i) => (browserWindowStart + i === browserCursor ? palette.cyan : palette.fg)}
                  marginBottom={0}
                />
                <box marginTop={1}><text fg={palette.gray}>[f] filter  [Enter] detail  [r]efresh  [Esc] back</text></box>
              </>
            )}
            {browserFilterPickerOpen && (
              <box marginTop={1}><text fg={palette.gray}>[1]/[2]/[3] switch tabs  [Esc] close picker</text></box>
            )}
          </>
        )}
      </box>
    );
  }

  if (mode === "cross") {
    const coveringColumns: Column<Covering>[] = [
      {
        header: "  Covering",
        width: 10,
        value: (_row, i) => `${i === cross.coveringCursor ? "> " : "  "}${i + 1}`,
      },
      { header: "Wr", width: 3, align: "right", value: (row) => String(row.writerKeys.length) },
      { header: "Pm", width: 3, align: "right", value: (row) => String(row.promptIds.length) },
      { header: "Jd", width: 3, align: "right", value: (row) => String(row.judgeKeys.length) },
      { header: "N", width: 3, align: "right", value: (row) => String(row.outputsPerModel) },
    ];

    const comboColumns: Column<WriteCrossRow>[] = [
      {
        header: "  PromptHash",
        width: 18,
        value: (row, i) => `${i === cross.comboCursor ? "> " : "  "}${row.promptHash}`,
      },
      { header: "Idx", width: 3, align: "right", value: (row) => String(row.outputIndex) },
      { header: "Models", width: 6, align: "right", value: (row) => String(row.models.length) },
    ];

    const selectedCombo = constrainedComboRows[cross.comboCursor] ?? null;
    const selectedEntries = selectedCombo
      ? selectedCombo.models.map((modelDirKey) => ({
          model: specFromModelKey(modelDirKey) ?? modelDirKey,
          preview: selectedCombo.previews[modelDirKey] ?? "",
        }))
      : [];

    const entryColumns: Column<{ model: string; preview: string }>[] = [
      {
        header: "Model",
        width: 32,
        minWidth: 12,
        truncate: true,
        value: (row) => truncate(row.model, 32),
      },
      {
        header: "Preview",
        width: 72,
        minWidth: 16,
        truncate: true,
        value: (row) => truncate(row.preview || "(empty)", 72),
      },
    ];

    return (
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <box paddingTop={1}><text fg={palette.yellow} attributes={1}>Cross-Sections</text></box>
        {cross.loading && <box><text fg={palette.gray}>Loading cross-sections...</text></box>}
        {cross.error && <box><text fg={palette.red}>{cross.error}</text></box>}
        <box>
          <text fg={palette.gray}>Prompt source: {cross.promptSourceLabel}</text>
        </box>
        <box>
          <text fg={palette.gray}>{cross.coverageHint}</text>
        </box>

        <box marginTop={1}><text fg={palette.cyan}>Fully Cached Coverings</text></box>
        <scrollbox ref={crossCoveringsScrollRef} height={8}>
          <Table
            data={cross.coverings}
            columns={coveringColumns}
            maxWidth={crossTableWidth}
            keyFn={(_row, i) => `covering-${i}`}
            rowFg={(_row, i) => (i === cross.coveringCursor ? palette.cyan : palette.fg)}
            marginBottom={0}
          />
        </scrollbox>
        {cross.coverings.length === 0 && (
          <box>
            <text fg={palette.yellow}>No fully cached coverings found for this prompt set.</text>
          </box>
        )}
        {cross.coverings.length === 0 && cross.comboRows.length > 0 && (
          <box>
            <text fg={palette.gray}>Shared writes exist, but downstream feedback/revisions/judgments are not fully complete.</text>
          </box>
        )}

        <box marginTop={1}><text fg={palette.cyan}>Model Participation</text></box>
        <box>
          <text fg={palette.gray}>
            {cross.modelStats.length > 0
              ? cross.modelStats
                .slice(0, 4)
                .map((m) => `${specFromModelKey(m.modelKey) ?? m.modelKey}: ${m.coveringCount} cov`)
                .join("  |  ")
              : "No model participation data yet."}
          </text>
        </box>

        <box marginTop={1}><text fg={palette.cyan}>Output Cross-Section (writes)</text></box>
        <scrollbox ref={crossCombosScrollRef} height={8}>
          <Table
            data={constrainedComboRows}
            columns={comboColumns}
            maxWidth={crossTableWidth}
            keyFn={(row) => `${row.promptHash}:${row.outputIndex}`}
            rowFg={(_row, i) => (i === cross.comboCursor ? palette.cyan : palette.fg)}
            marginBottom={0}
          />
        </scrollbox>

        <box marginTop={1}><text fg={palette.cyan}>Selected Combo Side-by-Side</text></box>
        <scrollbox flexGrow={1}>
          <Table
            data={selectedEntries}
            columns={entryColumns}
            maxWidth={detailTableWidth}
            keyFn={(row) => row.model}
            marginBottom={0}
          />
        </scrollbox>

        <box marginTop={1}><text fg={palette.gray}>[Tab] focus  [Enter] select covering  [j/k] move  [r]efresh  [Esc] back</text></box>
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
  const diskSeparatorLen = DISK_LABEL_WIDTH + 2 + DISK_SIZE_WIDTH;

  const modelColumns: Column<CacheModelEntry>[] = [
    {
      header: "  Model",
      computeWidth: (data) => 2 + Math.max(5, ...data.map((m) => m.displayName.length)),
      value: (m, i) => `${i === state.cursorIndex ? "> " : "  "}${m.displayName}`,
    },
    { header: "Writes", width: 6, align: "right", value: (m) => String(m.writes) },
    { header: "Feedbk", width: 6, align: "right", value: (m) => String(m.feedback) },
    { header: "Revise", width: 6, align: "right", value: (m) => String(m.revisions) },
    { header: "Judge", width: 6, align: "right", value: (m) => String(m.judgments) },
  ];

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <box paddingTop={1}>
        <box flexDirection="column" marginBottom={1}>
          <box>
            <text fg={palette.yellow} attributes={1}>Cache Disk Usage</text>
          </box>
          <box>
            <text fg={palette.gray}>
              {`${"Category".padEnd(DISK_LABEL_WIDTH)}  ${"Size".padStart(DISK_SIZE_WIDTH)}`}
            </text>
          </box>
          {diskRows.map((row) => (
            <box key={row.label}>
              <text fg={palette.fg}>
                {`${row.label.padEnd(DISK_LABEL_WIDTH)}  ${formatCacheBytes(row.size).padStart(DISK_SIZE_WIDTH)}`}
              </text>
            </box>
          ))}
          <box>
            <text fg={palette.gray}>{"\u2500".repeat(diskSeparatorLen)}</text>
          </box>
          <box>
            <text>
              <span fg={palette.fg} attributes={1}>{"Total".padEnd(DISK_LABEL_WIDTH)}</span>
              <span fg={palette.green} attributes={1}>{`  ${formatCacheBytes(ds.total).padStart(DISK_SIZE_WIDTH)}`}</span>
            </text>
          </box>
        </box>
      </box>

      {notice && (
        <box marginBottom={1}>
          <text fg={palette.green}>{notice}</text>
        </box>
      )}

      <box marginBottom={1}>
        <text fg={palette.yellow} attributes={1}>Models</text>
      </box>

      <scrollbox ref={overviewScrollRef} flexGrow={1}>
        <Table
          data={state.models}
          columns={modelColumns}
          keyFn={(m) => m.key}
          rowFg={(_row, i) => (i === state.cursorIndex ? palette.cyan : palette.fg)}
          marginBottom={0}
        />
      </scrollbox>

      {mergeDraft ? (
        <box flexDirection="column" paddingLeft={1} marginTop={1}>
          <box>
            <text fg={palette.yellow}>Merge source: {specFromModelKey(mergeDraft.sourceModel) ?? mergeDraft.sourceModel}</text>
          </box>
          <box>
            <text fg={palette.gray}>[Tab] switch target mode  [Enter] continue  [Esc] cancel</text>
          </box>
          <box>
            <text fg={palette.cyan}>Mode: {mergeDraft.useExisting ? "existing model" : "custom provider:model"}</text>
          </box>
          {mergeDraft.useExisting ? (
            <box>
              <text fg={palette.fg}>
                Target: {existingMergeTargets.length > 0
                  ? existingMergeTargets[Math.min(mergeDraft.targetCursor, existingMergeTargets.length - 1)].displayName
                  : "(none)"}
              </text>
            </box>
          ) : (
            <box flexDirection="column">
              <box>
                <TextInput
                  value={mergeDraft.targetSpec}
                  onChange={(value) => setMergeDraft({ ...mergeDraft, targetSpec: value, error: null })}
                  onSubmit={() => confirmMergeFromDraft()}
                  onCancel={() => setMergeDraft(null)}
                  placeholder="provider:model"
                  focused={true}
                />
              </box>
            </box>
          )}
          {mergeDraft.error && (
            <box>
              <text fg={palette.red}>{mergeDraft.error}</text>
            </box>
          )}
        </box>
      ) : state.confirmAction ? (
        <ConfirmPrompt
          message={
            state.confirmAction.type === "trim"
              ? `Trim ${state.confirmAction.model} to 1 output per prompt?`
              : state.confirmAction.type === "delete"
                ? `Delete all cache for ${state.confirmAction.model}?`
                : `Merge ${state.confirmAction.sourceModel} into ${state.confirmAction.targetSpec}? Source will be removed.`
          }
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      ) : (
        <box paddingLeft={1} marginTop={1}>
          <text fg={palette.gray}>[Enter]/[b] browse  [m]erge  [x] cross-sections  [t]rim  [d]elete  [r]efresh</text>
        </box>
      )}
    </box>
  );
}
