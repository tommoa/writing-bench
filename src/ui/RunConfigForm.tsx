import { useState, useEffect, useCallback } from "react";
import { TextInput } from "./TextInput.js";
import { NumberInput } from "./NumberInput.js";
import { SelectInput } from "./SelectInput.js";
import { ToggleInput } from "./ToggleInput.js";
import { FormField } from "./FormField.js";
import { useKeyboardScope } from "./keyboard/use-keyboard-scope.js";
import { KEYBOARD_SCOPE_PRIORITY } from "./keyboard/types.js";
import type { ModelPickerModalProps } from "./ModelPickerModal.js";
import { discoverModelsFromCache } from "../engine/run-manager.js";
import { buildModelLabelMap } from "../providers/models.js";
import type { TuiRunConfig, JudgeQualityMode } from "../types.js";
import type { JudgeSensitivity } from "../types.js";
import { DEFAULT_TUI_RUN_CONFIG } from "../types.js";
import { usePalette } from "./PaletteContext.js";

// ── Field Registry ──────────────────────────────────
//
// Each section's fields are declared by type. The field type drives
// keyboard behavior (modal opens on Enter, text/number enters edit mode,
// select/toggle are inline). When adding or removing a field, update the
// registry and the matching JSX below.

type FieldType = "modal" | "text" | "number" | "select" | "toggle";

const FIELD_REGISTRY: readonly FieldType[][] = [
  // Section 0: Models
  [
    "modal",
    "text",
    "text",
  ],
  // Section 1: Judges
  [
    "modal",
    "toggle",
    "select",
    "select",
    "number",
    "number",
  ],
  // Section 2: Convergence
  [
    "number",
    "number",
    "number",
    "number",
    "number",
  ],
  // Section 3: Advanced
  [
    "number",
    "number",
    "toggle",
    "toggle",
    "toggle",
    "toggle",
    "toggle",
  ],
];

interface SectionDef {
  label: string;
  fieldCount: number;
}

const SECTIONS: SectionDef[] = FIELD_REGISTRY.map((fields, i) => ({
  label: ["Models", "Judges", "Convergence", "Advanced"][i],
  fieldCount: fields.length,
}));

const JUDGE_QUALITY_MODES: readonly JudgeQualityMode[] = ["consensus", "writing", "feedback", "revised"];
const JUDGE_SENSITIVITIES: readonly JudgeSensitivity[] = ["low", "medium", "high"];

// ── Props ───────────────────────────────────────────

interface RunConfigFormProps {
  onStart: (config: TuiRunConfig) => void;
  /** Error message from a previous failed run attempt. */
  error?: string | null;
  /** Called when the user presses q to exit (only when not editing). */
  onExit?: () => void;
  /** Called to open a model picker modal at the App root level. */
  onOpenModal?: (props: ModelPickerModalProps) => void;
  /** Whether an app-level modal overlay is currently open. */
  isModalOpen?: boolean;
}

// ── Component ───────────────────────────────────────

export function RunConfigForm({ onStart, error: externalError, onExit, onOpenModal, isModalOpen = false }: RunConfigFormProps) {
  const palette = usePalette();
  const [form, setForm] = useState<TuiRunConfig>({ ...DEFAULT_TUI_RUN_CONFIG });
  const [cachedModels, setCachedModels] = useState<string[]>([]);
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({});
  const [expandedSection, setExpandedSection] = useState<number | null>(0);
  const [sectionCursor, setSectionCursor] = useState(0);
  const [fieldCursor, setFieldCursor] = useState(0);
  const [inputMode, setInputMode] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Load cached models and their display labels on mount
  useEffect(() => {
    discoverModelsFromCache()
      .then(async (specs) => {
        setCachedModels(specs);
        setModelLabels(await buildModelLabelMap(specs));
      })
      .catch(() => {});
  }, []);

  /** Open a model picker modal via App-level rendering. */
  function openModal(type: "models" | "judges") {
    const key = type === "models" ? "models" as const : "judges" as const;
    onOpenModal?.({
      title: type === "models" ? "Select Models" : "Select Judges",
      initialModels: form[key],
      cachedModels,
      modelLabels,
      onSubmit: (selected) => {
        updateForm(key, selected);
      },
      onCancel: () => {},
    });
  }

  // ── Form update helpers ───────────────────────────

  const updateForm = useCallback(<K extends keyof TuiRunConfig>(key: K, value: TuiRunConfig[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // Enforce mutual exclusion: cacheOnly and noCache
      if (key === "cacheOnly" && value === true) {
        next.noCache = false;
      } else if (key === "noCache" && value === true) {
        next.cacheOnly = false;
      }
      return next;
    });
    setValidationError(null);
  }, []);

  // ── Section state helpers ─────────────────────────

  const isExpanded = expandedSection === sectionCursor;
  const currentSection = SECTIONS[sectionCursor];

  function toggleSection(idx: number) {
    setExpandedSection((prev) => (prev === idx ? null : idx));
    setFieldCursor(0);
  }

  /** Switch to a section, collapsing the old and expanding the new. */
  function moveToSection(idx: number, field: number) {
    setExpandedSection(idx);
    setSectionCursor(idx);
    setFieldCursor(field);
  }

  // ── Validation ────────────────────────────────────

  function validate(): string | null {
    if (form.models.length === 0 && !form.cacheOnly) {
      return "Select models or enable cache-only for auto-discovery";
    }
    if (form.models.length === 1 && !form.cacheOnly) {
      return "At least 2 models required for pairwise comparison";
    }
    if (!form.prompts.trim()) {
      return "Prompts glob pattern is required";
    }
    if (form.confidence != null && form.confidence < 0) {
      return "Confidence must be >= 0";
    }
    if (form.maxRounds < 1) {
      return "Max rounds must be >= 1";
    }
    if (form.concurrency < 1) {
      return "Concurrency must be >= 1";
    }
    if (form.outputs != null && form.outputs < 1) {
      return "Max outputs must be >= 1";
    }
    if (form.writingWeight < 0 || form.feedbackWeight < 0 || form.revisedWeight < 0) {
      return "Priority weights must be >= 0";
    }
    if (form.judgeDecay != null && form.judgeDecay <= 0) {
      return "Judge decay must be > 0";
    }
    if (form.judgePruneThreshold != null && (form.judgePruneThreshold < 0 || form.judgePruneThreshold > 1)) {
      return "Judge prune threshold must be between 0 and 1";
    }
    return null;
  }

  function handleStart() {
    const err = validate();
    if (err) {
      setValidationError(err);
      return;
    }
    onStart(form);
  }

  // ── Section summaries (collapsed previews) ────────

  function sectionSummary(idx: number): string {
    switch (idx) {
      case 0: {
        const n = form.models.length;
        return n === 0 ? "none selected" : `${n} selected`;
      }
      case 1: {
        const n = form.judges.length;
        return n === 0 ? "default (use writers)" : `${n} selected`;
      }
      case 2: {
        const d = DEFAULT_TUI_RUN_CONFIG;
        const isDefault = form.confidence === d.confidence
          && form.maxRounds === d.maxRounds
          && form.writingWeight === d.writingWeight
          && form.feedbackWeight === d.feedbackWeight
          && form.revisedWeight === d.revisedWeight;
        return isDefault ? "default" : "custom";
      }
      case 3: {
        const d = DEFAULT_TUI_RUN_CONFIG;
        const isDefault = form.outputs === d.outputs
          && form.concurrency === d.concurrency
          && form.reasoning === d.reasoning
          && form.noCache === d.noCache
          && form.cacheOnly === d.cacheOnly
          && form.skipSeeding === d.skipSeeding
          && form.speed === d.speed;
        return isDefault ? "default" : "modified";
      }
      default:
        return "";
    }
  }

  // ── Model summary for compact display ─────────────

  function modelSummaryText(specs: string[], fallback: string): string {
    if (specs.length === 0) return fallback;
    const labels = specs.map((s) => modelLabels[s] ?? s);
    const joined = labels.join(", ");
    if (joined.length <= 60) return joined;
    // Truncate to first 2 labels + count when 3+, or just truncate when <= 3
    if (specs.length > 3) return labels.slice(0, 2).join(", ") + `, +${specs.length - 2} more`;
    return joined.slice(0, 57) + "...";
  }

  // ── Field type helpers ─────────────────────────────

function fieldTypeAt(section: number, field: number): FieldType | undefined {
    return FIELD_REGISTRY[section]?.[field];
  }

  /** Returns true if the field is a model picker (opens modal on Enter). */
  function isModelField(section: number, field: number): boolean {
    return fieldTypeAt(section, field) === "modal";
  }

  /** Returns true if the field is a text or number input
   *  (requires Enter to enter edit mode). */
  function isTextOrNumberField(section: number, field: number): boolean {
    const t = fieldTypeAt(section, field);
    return t === "text" || t === "number";
  }

  // ── Keyboard handler (form navigation) ────────────

  useKeyboardScope({
    id: "run-config-form",
    priority: KEYBOARD_SCOPE_PRIORITY["tab-local"],
    enabled: !isModalOpen && !inputMode,
    onKey: (key) => {
      switch (key.name) {
        case "j":
        case "down":
          if (isExpanded && fieldCursor < currentSection.fieldCount - 1) {
            setFieldCursor(fieldCursor + 1);
          } else if (sectionCursor < SECTIONS.length - 1) {
            moveToSection(sectionCursor + 1, 0);
          }
          return "handled";
        case "k":
        case "up":
          if (isExpanded && fieldCursor > 0) {
            setFieldCursor(fieldCursor - 1);
          } else if (sectionCursor > 0) {
            const prev = sectionCursor - 1;
            moveToSection(prev, SECTIONS[prev].fieldCount - 1);
          }
          return "handled";
        case "tab":
        case "]": {
          const next = key.shift
            ? (sectionCursor - 1 + SECTIONS.length) % SECTIONS.length
            : (sectionCursor + 1) % SECTIONS.length;
          moveToSection(next, 0);
          return "handled";
        }
        case "[":
          moveToSection(
            (sectionCursor - 1 + SECTIONS.length) % SECTIONS.length,
            0,
          );
          return "handled";
        case "return":
          if (!isExpanded || fieldCursor === -1) {
            toggleSection(sectionCursor);
          } else if (isModelField(sectionCursor, fieldCursor)) {
            openModal(sectionCursor === 0 ? "models" : "judges");
          } else if (isTextOrNumberField(sectionCursor, fieldCursor)) {
            enterInputMode();
          }
          return "handled";
        case "s":
          if (key.shift) {
            handleStart();
            return "handled";
          }
          return "pass";
        case "q":
          onExit?.();
          return "handled";
        default:
          return "pass";
      }
    },
  });

  // ── Field focus helpers ───────────────────────────

  function isFieldFocused(section: number, field: number): boolean {
    return sectionCursor === section && expandedSection === section && fieldCursor === field;
  }

  // ── Enter/exit input mode for text/number fields ──

  function enterInputMode() { setInputMode(true); }
  function exitInputMode() { setInputMode(false); }

  // ── Render helpers ──────────────────────────────────

  function editHintVisible(section: number, field: number): boolean {
    return isFieldFocused(section, field) && !inputMode && isTextOrNumberField(section, field);
  }

  // ── Form rendering ───────────────────────────────

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1} paddingRight={1}>
      <box marginBottom={1}>
        <text fg={palette.cyan} attributes={1}>Run Configuration</text>
      </box>

      <scrollbox flexGrow={1}>
        {/* ── Section 0: Models ──────────────────── */}
        {renderSectionHeader(0)}
        {expandedSection === 0 && (
          <box flexDirection="column" paddingLeft={2} paddingTop={1}>
            <FormField label="Writers" focused={isFieldFocused(0, 0)} description="Models to benchmark. At least 2 required for pairwise comparison.">
              <box>
                <text fg={form.models.length > 0 ? palette.fg : palette.gray}>
                  {modelSummaryText(form.models, "none")}
                  {isFieldFocused(0, 0) && (
                    <span fg={palette.gray}>{"  "}[Enter to pick]</span>
                  )}
                </text>
              </box>
            </FormField>
            <FormField label="Prompts glob" focused={isFieldFocused(0, 1)} showEditHint={editHintVisible(0, 1)} description="Glob pattern for TOML prompt files.">
              <TextInput
                value={form.prompts}
                onChange={(v) => updateForm("prompts", v)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                placeholder="prompts/*.toml"
                focused={isFieldFocused(0, 1) && inputMode}
              />
            </FormField>
            <FormField label="Filter" focused={isFieldFocused(0, 2)} showEditHint={editHintVisible(0, 2)} description="Filter prompts by id or tag (space-separated).">
              <TextInput
                value={form.filter.join(" ")}
                onChange={(v) => updateForm("filter", v.trim() ? v.split(/\s+/) : [])}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                placeholder="tag or prompt id"
                focused={isFieldFocused(0, 2) && inputMode}
              />
            </FormField>
          </box>
        )}

        {/* ── Section 1: Judges ──────────────────── */}
        {renderSectionHeader(1)}
        {expandedSection === 1 && (
          <box flexDirection="column" paddingLeft={2} paddingTop={1}>
            <FormField label="Judge models" focused={isFieldFocused(1, 0)} description="Separate judge models. If omitted, writers are used for judging.">
              <box>
                <text fg={form.judges.length > 0 ? palette.fg : palette.gray}>
                  {modelSummaryText(form.judges, "default (same as writers)")}
                  {isFieldFocused(1, 0) && (
                    <span fg={palette.gray}>{"  "}[Enter to pick]</span>
                  )}
                </text>
              </box>
            </FormField>
            <FormField label="Judge quality" focused={isFieldFocused(1, 1)} description="Estimate judge quality and weight ratings accordingly.">
              <ToggleInput
                value={form.judgeQuality}
                onChange={(v) => updateForm("judgeQuality", v)}
                focused={isFieldFocused(1, 1)}
              />
            </FormField>
            <FormField label="Quality mode" focused={isFieldFocused(1, 2)} description="Signal for judge weights: consensus (majority vote) or model Elo from a dimension.">
              <SelectInput
                value={form.judgeQualityMode}
                options={JUDGE_QUALITY_MODES}
                onChange={(v) => updateForm("judgeQualityMode", v)}
                focused={isFieldFocused(1, 2)}
              />
            </FormField>
            <FormField label="Sensitivity" focused={isFieldFocused(1, 3)} description="How aggressively to down-weight low-quality judges.">
              <SelectInput
                value={form.judgeSensitivity}
                options={JUDGE_SENSITIVITIES}
                onChange={(v) => updateForm("judgeSensitivity", v)}
                focused={isFieldFocused(1, 3)}
              />
            </FormField>
            <FormField label="Decay rate" focused={isFieldFocused(1, 4)} hint="(override)" showEditHint={editHintVisible(1, 4)} description="Exponential decay rate for judge weights. Overrides sensitivity preset.">
              <NumberInput
                value={form.judgeDecay}
                onChange={(v) => updateForm("judgeDecay", v)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={true}
                placeholder="auto"
                focused={isFieldFocused(1, 4) && inputMode}
              />
            </FormField>
            <FormField label="Prune threshold" focused={isFieldFocused(1, 5)} hint="(0-1)" showEditHint={editHintVisible(1, 5)} description="Drop judges with weight below this threshold (0-1).">
              <NumberInput
                value={form.judgePruneThreshold}
                onChange={(v) => updateForm("judgePruneThreshold", v)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={true}
                placeholder="auto"
                focused={isFieldFocused(1, 5) && inputMode}
              />
            </FormField>
          </box>
        )}

        {/* ── Section 2: Convergence ─────────────── */}
        {renderSectionHeader(2)}
        {expandedSection === 2 && (
          <box flexDirection="column" paddingLeft={2} paddingTop={1}>
            <FormField label="Confidence (CI)" focused={isFieldFocused(2, 0)} hint="0 = overlap" showEditHint={editHintVisible(2, 0)} description="CI threshold in Elo points. 0 = stop when no CIs overlap.">
              <NumberInput
                value={form.confidence}
                onChange={(v) => updateForm("confidence", v ?? 0)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={true}
                placeholder="0"
                focused={isFieldFocused(2, 0) && inputMode}
              />
            </FormField>
            <FormField label="Max rounds" focused={isFieldFocused(2, 1)} showEditHint={editHintVisible(2, 1)} description="Maximum productive adaptive rounds before stopping.">
              <NumberInput
                value={form.maxRounds}
                onChange={(v) => updateForm("maxRounds", v ?? 50)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={false}
                placeholder="50"
                focused={isFieldFocused(2, 1) && inputMode}
              />
            </FormField>
            <FormField label="Writing weight" focused={isFieldFocused(2, 2)} showEditHint={editHintVisible(2, 2)} description="Priority weight for initial writing quality judgments.">
              <NumberInput
                value={form.writingWeight}
                onChange={(v) => updateForm("writingWeight", v ?? 1.0)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={true}
                placeholder="1.0"
                focused={isFieldFocused(2, 2) && inputMode}
              />
            </FormField>
            <FormField label="Feedback weight" focused={isFieldFocused(2, 3)} showEditHint={editHintVisible(2, 3)} description="Priority weight for feedback quality judgments.">
              <NumberInput
                value={form.feedbackWeight}
                onChange={(v) => updateForm("feedbackWeight", v ?? 0.25)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={true}
                placeholder="0.25"
                focused={isFieldFocused(2, 3) && inputMode}
              />
            </FormField>
            <FormField label="Revised weight" focused={isFieldFocused(2, 4)} showEditHint={editHintVisible(2, 4)} description="Priority weight for revised writing quality judgments.">
              <NumberInput
                value={form.revisedWeight}
                onChange={(v) => updateForm("revisedWeight", v ?? 0.4)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={true}
                placeholder="0.4"
                focused={isFieldFocused(2, 4) && inputMode}
              />
            </FormField>
          </box>
        )}

        {/* ── Section 3: Advanced ────────────────── */}
        {renderSectionHeader(3)}
        {expandedSection === 3 && (
          <box flexDirection="column" paddingLeft={2} paddingTop={1}>
            <FormField label="Max outputs" focused={isFieldFocused(3, 0)} hint="blank = adaptive" showEditHint={editHintVisible(3, 0)} description="Max outputs per model per prompt. Blank = adaptive (driven by convergence).">
              <NumberInput
                value={form.outputs}
                onChange={(v) => updateForm("outputs", v)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={false}
                placeholder="adaptive"
                focused={isFieldFocused(3, 0) && inputMode}
              />
            </FormField>
            <FormField label="Concurrency" focused={isFieldFocused(3, 1)} showEditHint={editHintVisible(3, 1)} description="Concurrent needs to fulfill. Lower if you hit rate limits.">
              <NumberInput
                value={form.concurrency}
                onChange={(v) => updateForm("concurrency", v ?? 8)}
                onSubmit={exitInputMode}
                onCancel={exitInputMode}
                allowFloat={false}
                placeholder="8"
                focused={isFieldFocused(3, 1) && inputMode}
              />
            </FormField>
            <FormField label="Reasoning" focused={isFieldFocused(3, 2)} description="Include reasoning in judgments for better quality.">
              <ToggleInput
                value={form.reasoning}
                onChange={(v) => updateForm("reasoning", v)}
                focused={isFieldFocused(3, 2)}
              />
            </FormField>
            <FormField label="Use cache" focused={isFieldFocused(3, 3)} description="Read from sample cache. Disabling still writes to cache.">
              <ToggleInput
                value={!form.noCache}
                onChange={(v) => updateForm("noCache", !v)}
                focused={isFieldFocused(3, 3)}
              />
            </FormField>
            <FormField label="Cache only" focused={isFieldFocused(3, 4)} description="Only use cached data, no API calls. Auto-discovers models from cache.">
              <ToggleInput
                value={form.cacheOnly}
                onChange={(v) => updateForm("cacheOnly", v)}
                focused={isFieldFocused(3, 4)}
              />
            </FormField>
            <FormField label="Skip seeding" focused={isFieldFocused(3, 5)} description="Skip exhaustive cache scan (Phase 1). Discovers cached data lazily.">
              <ToggleInput
                value={form.skipSeeding}
                onChange={(v) => updateForm("skipSeeding", v)}
                focused={isFieldFocused(3, 5)}
              />
            </FormField>
            <FormField label="Show speed" focused={isFieldFocused(3, 6)} description="Show raw tok/s speed per model in results.">
              <ToggleInput
                value={form.speed}
                onChange={(v) => updateForm("speed", v)}
                focused={isFieldFocused(3, 6)}
              />
            </FormField>
          </box>
        )}
      </scrollbox>

      {/* ── Error display ────────────────────────── */}
      {(validationError || externalError) && (
        <box marginTop={1}>
          <text fg={palette.red}>{validationError ?? externalError}</text>
        </box>
      )}

      {/* ── Action bar ───────────────────────────── */}
      <box marginTop={1}>
        <text fg={palette.gray}>
          [Tab/{"[]"}] sections  [j/k] fields  [Enter] expand/edit  [Shift+S] start
        </text>
      </box>

    </box>
  );

  // ── Section header renderer ───────────────────────

  function renderSectionHeader(idx: number) {
    const isCurrent = sectionCursor === idx;
    const expanded = expandedSection === idx;
    const arrow = expanded ? "\u25BC" : "\u25B6";
    const label = SECTIONS[idx].label;
    const summary = sectionSummary(idx);
    const fg = isCurrent ? palette.cyan : palette.fg;

    return (
      <box flexDirection="column" marginTop={idx > 0 ? 1 : 0}>
        <box>
          <text fg={fg} attributes={isCurrent ? 1 : 0}>
            {arrow} {label}
            <span fg={palette.gray}>  ({summary})</span>
          </text>
        </box>
        {expanded && (
          <box>
            <text fg={palette.gray}>{"\u2500".repeat(40)}</text>
          </box>
        )}
      </box>
    );
  }
}
