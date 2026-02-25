import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { RGBA } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { TextInput } from "./TextInput.js";
import { truncate } from "./format-utils.js";
import { usePalette } from "./PaletteContext.js";
import { useKeyboardScope } from "./keyboard/use-keyboard-scope.js";
import { KEYBOARD_SCOPE_PRIORITY } from "./keyboard/types.js";

// ── Props ───────────────────────────────────────────

export interface ModelPickerModalProps {
  /** Title displayed at the top. */
  title: string;
  /** Models selected when the modal opens (snapshot). */
  initialModels: string[];
  /** Available cached models for the picker. */
  cachedModels: string[];
  /** Spec -> display name lookup from models.dev. */
  modelLabels: Record<string, string>;
  /** Called when the user confirms the modal selection. */
  onSubmit: (models: string[]) => void;
  /** Called when the user cancels the modal. */
  onCancel: () => void;
}

// ── Constants ───────────────────────────────────────

const SCRIM_ALPHA = 0.4;
const PANEL_WIDTH = 68;
const LABEL_COL_WIDTH = 26;
const SCROLL_MARGIN = 3;

function clampCursor(cursor: number, totalRows: number): number {
  return Math.max(0, Math.min(cursor, Math.max(0, totalRows - 1)));
}

function nextCursor(cursor: number, totalRows: number): number {
  return clampCursor(cursor + 1, totalRows);
}

function keepCursorVisible(
  scrollBox: ScrollBoxRenderable,
  cursor: number,
  listHeight: number,
): void {
  const margin = Math.min(SCROLL_MARGIN, Math.floor(listHeight / 2));
  const top = scrollBox.scrollTop;
  if (cursor < top + margin) {
    scrollBox.scrollTo(Math.max(0, cursor - margin));
    return;
  }
  if (cursor >= top + listHeight - margin) {
    scrollBox.scrollTo(cursor - listHeight + margin + 1);
  }
}

// ── Component ───────────────────────────────────────

/**
 * Full-screen dialog overlay for selecting models. Search-first UX:
 * typing filters the list, Tab toggles selection, Up/Down navigates,
 * Enter/Esc closes.
 *
 * Uses a scrollbox with a deferred scrollTo to keep the cursor visible.
 * The setTimeout(0) ensures scroll position is set after OpenTUI's
 * recalculateBarProps settles when content size changes (filtering).
 */
export function ModelPickerModal({
  title,
  initialModels,
  cachedModels,
  modelLabels,
  onSubmit,
  onCancel,
}: ModelPickerModalProps) {
  const palette = usePalette();
  // Internal selection state -- initialized from snapshot, independent from parent
  const [models, setModels] = useState(initialModels);
  const customModels = useMemo(
    () => models.filter((m) => !cachedModels.includes(m)),
    [models, cachedModels],
  );
  const allEntries = useMemo(
    () => [...cachedModels, ...customModels],
    [cachedModels, customModels],
  );
  const { width: termWidth, height: termHeight } = useTerminalDimensions();

  /** Look up display name for a spec, falling back to the raw spec. */
  const labelFor = (spec: string) => modelLabels[spec] ?? spec;

  // Derive scrim color from palette bg with alpha
  const scrimColor = useMemo(() => {
    const c = RGBA.fromHex(palette.bg);
    c.a = SCRIM_ALPHA;
    return c;
  }, [palette.bg]);

  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(0);
  const [addInputActive, setAddInputActive] = useState(false);
  const [addInputValue, setAddInputValue] = useState("");
  const [addInputError, setAddInputError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Filter entries by search query
  const filtered = useMemo(
    () => {
      if (!search) return allEntries;
      const q = search.toLowerCase();
      return allEntries.filter((spec) =>
        spec.toLowerCase().includes(q) ||
        labelFor(spec).toLowerCase().includes(q),
      );
    },
    [search, allEntries, modelLabels],
  );

  // Check if search looks like a custom spec that could be added
  const searchIsSpec = search.includes(":");
  const searchAlreadyExists =
    searchIsSpec && (allEntries.includes(search.trim()) || models.includes(search.trim()));
  const showAddHint = searchIsSpec && !searchAlreadyExists && search.trim().length > 2;

  // Total navigable rows: filtered entries + optional "add as custom" row
  const totalRows = filtered.length + (showAddHint ? 1 : 0);

  // Clamp cursor when filter changes
  const clampedCursor = clampCursor(cursor, totalRows);

  // Panel sizing -- compute height first, then center vertically.
  // Fixed rows: padding(2) + header(1) + search with margins(3) + footer with margin(2) = 8
  const PANEL_FIXED_ROWS = 8;
  const PANEL_MARGIN = 2; // min rows between panel edge and terminal edge
  const panelWidth = Math.min(PANEL_WIDTH, termWidth - 4);
  const listMaxHeight = termHeight - PANEL_FIXED_ROWS - PANEL_MARGIN * 2;
  const listHeight = Math.max(1, Math.min(allEntries.length, listMaxHeight));
  const panelHeight = PANEL_FIXED_ROWS + listHeight;
  const panelTop = Math.max(1, Math.floor((termHeight - panelHeight) / 2));
  const panelLeft = Math.floor((termWidth - panelWidth) / 2);

  // Scroll to keep cursor visible with a margin of SCROLL_MARGIN rows.
  // Only scrolls when the cursor would be within SCROLL_MARGIN of the
  // viewport edge. Uses setTimeout(0) to let OpenTUI's
  // recalculateBarProps (which runs on process.nextTick) settle first
  // when the filtered list changes size.
  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox) return;
    setTimeout(() => {
      keepCursorVisible(scrollBox, clampedCursor, listHeight);
    }, 0);
  }, [clampedCursor, filtered.length, listHeight]);

  // Available width for the spec column:
  // panel inner = panelWidth - 6 (panel padding 3+3)
  // row content = 1 (box paddingLeft) + 2 (arrow) + 2 (indicator) + label + spec
  // Safety margin of 4 accounts for terminals that render unicode
  // geometric shapes (▸ ○ ● …) as double-width, which is common
  // when the terminal's East Asian Ambiguous Width setting differs
  // from what Bun.stringWidth reports.
  const panelInner = panelWidth - 6;
  const rowPrefix = 1 + 2 + 2; // paddingLeft + arrow + indicator
  const specMaxLen = panelInner - rowPrefix - LABEL_COL_WIDTH - 4;

  // ── Add-input submit/cancel handlers ───────────────
  const handleAddSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setAddInputActive(false);
      setAddInputValue("");
      return;
    }
    if (!trimmed.includes(":")) {
      setAddInputError("Use provider:model format");
      return;
    }
    if (models.includes(trimmed) || cachedModels.includes(trimmed)) {
      setAddInputError("Already in list");
      return;
    }
    setModels((prev) => [...prev, trimmed]);
    setAddInputValue("");
    setAddInputError(null);
    setAddInputActive(false);
  }, [models, cachedModels]);

  const handleAddCancel = useCallback(() => {
    setAddInputActive(false);
    setAddInputValue("");
    setAddInputError(null);
  }, []);

  useKeyboardScope({
    id: "model-picker-modal",
    priority: KEYBOARD_SCOPE_PRIORITY.modal,
    enabled: !addInputActive,
    onKey: (key) => {
      switch (key.name) {
        case "up":
          setCursor(Math.max(0, clampedCursor - 1));
          return "handled";
        case "down":
          setCursor(nextCursor(clampedCursor, totalRows));
          return "handled";
        case "tab": {
          if (clampedCursor < filtered.length) {
            const spec = filtered[clampedCursor];
            const isSelected = models.includes(spec);
            if (isSelected) {
              setModels((prev) => prev.filter((m) => m !== spec));
            } else {
              setModels((prev) => [...prev, spec]);
            }
            setCursor(nextCursor(clampedCursor, totalRows));
          } else if (showAddHint && clampedCursor === filtered.length) {
            const trimmed = search.trim();
            setModels((prev) => [...prev, trimmed]);
            setSearch("");
            setCursor(0);
          }
          return "handled";
        }
        case "return":
          if (showAddHint && clampedCursor === filtered.length) {
            const trimmed = search.trim();
            setModels((prev) => [...prev, trimmed]);
            setSearch("");
            setCursor(0);
          } else {
            onSubmit(models);
          }
          return "handled";
        case "escape":
          onCancel();
          return "handled";
      }

      if (key.ctrl && key.name === "a") {
        setAddInputActive(true);
        setAddInputError(null);
        setAddInputValue("");
        return "handled";
      }

      return "pass";
    },
  });

  const selectedCount = models.length;

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={termWidth}
      height={termHeight}
      backgroundColor={scrimColor}
      buffered={true}
      zIndex={100}
    >
      {/* ── Dialog panel ─────────────────────────── */}
      <box
        position="absolute"
        top={panelTop}
        left={panelLeft}
        width={panelWidth}
        flexDirection="column"
        backgroundColor={palette.bg}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
      >
        {/* Header */}
        <box>
          <text fg={palette.fg} attributes={1}>
            {title}
            <span fg={palette.gray} attributes={0}>{"  "}{selectedCount} selected</span>
          </text>
        </box>

        {/* Search input */}
        <box marginTop={1} marginBottom={1} flexDirection="row" alignItems="center">
          <box marginRight={1}>
            <text fg={palette.gray}>&gt; </text>
          </box>
          <box flexGrow={1}>
            <TextInput
              value={search}
              onChange={(v) => {
                setSearch(v);
                setCursor(0);
              }}
              placeholder="Search..."
              focused={!addInputActive}
            />
          </box>
        </box>

        {/* ── Model list ─────────────────────────── */}
        {filtered.length === 0 && !showAddHint ? (
          <box paddingLeft={2} flexDirection="column">
            <text fg={palette.gray}>
              {allEntries.length === 0 && !search
                ? "No cached models. Press Ctrl+A to add a model."
                : "No matches"}
            </text>
          </box>
        ) : (
          <scrollbox
            ref={scrollRef}
            height={listHeight}
          >
            {/* All model items (scrollbox handles viewport clipping) */}
            {filtered.map((spec, idx) => {
              const isSelected = models.includes(spec);
              const isCursor = clampedCursor === idx;
              const isCustom = customModels.includes(spec);
              const rawLabel = labelFor(spec);
              const label = truncate(rawLabel, LABEL_COL_WIDTH - 1);

              const indicator = isSelected ? "\u25CF" : "\u25CB";
              const indicatorColor = isSelected ? palette.cyan : palette.gray;
              const labelColor = isCursor
                ? palette.fg
                : isSelected ? palette.fg : palette.gray;
              const specColor = palette.gray;
              const arrow = isCursor ? "\u25B8 " : "  ";
              const effectiveSpecMax = specMaxLen - (isCustom ? 2 : 0);

              return (
                <box key={spec} paddingLeft={1}>
                  <text attributes={isCursor ? 1 : 0}>
                    <span fg={isCursor ? palette.cyan : palette.gray}>{arrow}</span>
                    <span fg={isCursor ? palette.cyan : indicatorColor}>{indicator} </span>
                    <span fg={labelColor}>{label.padEnd(LABEL_COL_WIDTH)}</span>
                    <span fg={specColor}>{truncate(spec, Math.max(effectiveSpecMax, 10))}</span>
                    {isCustom && <span fg={palette.yellow}> *</span>}
                  </text>
                </box>
              );
            })}

            {/* "Add as custom" hint row */}
            {showAddHint && (
              <box paddingLeft={1}>
                <text
                  fg={clampedCursor === filtered.length ? palette.cyan : palette.gray}
                  attributes={clampedCursor === filtered.length ? 1 : 0}
                >
                  {clampedCursor === filtered.length ? "\u25B8 " : "  "}{"\u2500"} Add "{search.trim()}"
                </text>
              </box>
            )}
          </scrollbox>
        )}

        {/* ── Manual add input (Ctrl+A) ──────────── */}
        {addInputActive && (
          <box marginTop={1} flexDirection="column">
            <box flexDirection="row">
              <box width={5}>
                <text fg={palette.gray}>Add: </text>
              </box>
              <TextInput
                value={addInputValue}
                onChange={(v) => { setAddInputValue(v); setAddInputError(null); }}
                onSubmit={handleAddSubmit}
                onCancel={handleAddCancel}
                placeholder="provider:model"
                focused={addInputActive}
              />
            </box>
            {addInputError && (
              <box>
                <text fg={palette.red}>{addInputError}</text>
              </box>
            )}
          </box>
        )}

        {/* ── Footer ─────────────────────────────── */}
        <box marginTop={1}>
          <text fg={palette.gray}>
            Tab toggle  Ctrl+A add  Enter{showAddHint ? " add" : " apply"}  Esc cancel
          </text>
        </box>
      </box>
    </box>
  );
}
