import { useState, useEffect } from "react";
import type { BenchmarkStage } from "../types.js";
import { formatConvergenceTarget } from "../engine/need-identifier.js";
import { usePalette } from "./PaletteContext.js";

// ── Spinner ──────────────────────────────────────────

const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

function Spinner({ color }: { color: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <text fg={color}>{SPINNER_FRAMES[frame]}</text>;
}

// ── Constants ────────────────────────────────────────

const STAGE_LABELS: Record<BenchmarkStage, string> = {
  initialWriting: "Writing",
  initialJudging: "Judging",
  feedback: "Feedback",
  revisedWriting: "Revising",
  revisedJudging: "Re-Judging",
  computingElo: "Computing ELO",
  seeding: "Seeding Cache",
  adaptive: "Adaptive",
  complete: "Complete",
};

// ── Component ────────────────────────────────────────

import { truncate } from "./format-utils.js";

function fitStatusLine(text: string, maxWidth: number): string {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return text;
  }

  const clipped = truncate(text, maxWidth);
  return clipped.padEnd(maxWidth, " ");
}

interface StatusBarProps {
  stage: BenchmarkStage;
  activeStages: BenchmarkStage[];
  currentOp: string;
  stageProgress: number;
  opsDone: number;
  judgingRound?: number;
  maxCi?: number;
  ciThreshold?: number;
  needDescription?: string;
  batchSummary?: string;
  suspendedModels?: string[];
  /** Available width in columns for the content area. */
  contentWidth?: number;
}

export function StatusBar({
  stage,
  activeStages,
  currentOp,
  stageProgress,
  opsDone,
  judgingRound,
  maxCi,
  ciThreshold,
  batchSummary,
  suspendedModels,
  contentWidth,
}: StatusBarProps) {
  const palette = usePalette();
  const isComplete = stage === "complete";
  const pct = isComplete ? 100 : Math.round(stageProgress * 100);

  // Active stages label
  const stageLabel = isComplete
    ? "Complete"
    : activeStages.length > 0
      ? activeStages.map((s) => STAGE_LABELS[s]).join(", ")
      : "Starting...";

  // Max text width for indented lines (3 marginLeft + 1 paddingLeft from parent)
  const lineMax = contentWidth != null ? contentWidth - 4 : Infinity;

  // ── Build detail lines ──
  const details: Array<{ text: string; color: string }> = [];

  if (judgingRound != null && judgingRound > 0) {
    let roundText = `Round ${judgingRound}`;
    if (batchSummary) roundText += ` | ${batchSummary}`;
    if (maxCi != null) roundText += ` | CI +/-${maxCi}`;
    if (ciThreshold != null) roundText += ` -> target ${formatConvergenceTarget(ciThreshold)}`;
    details.push({ text: fitStatusLine(roundText, lineMax), color: palette.magenta });
  }
  if (suspendedModels && suspendedModels.length > 0) {
    details.push({
      text: fitStatusLine(`Suspended: ${suspendedModels.join(", ")}`, lineMax),
      color: palette.yellow,
    });
  }
  if (!isComplete && currentOp) {
    details.push({
      text: fitStatusLine(currentOp, lineMax),
      color: palette.gray,
    });
  }

  return (
    <box flexDirection="column" marginBottom={1}>
      <box height={1}>
        <box flexDirection="row">
          {!isComplete && (
            <>
              <box width={1} backgroundColor={palette.bg}>
                <Spinner color={palette.cyan} />
              </box>
              <box width={2}>
                <text>{"  "}</text>
              </box>
            </>
          )}
          <box>
            <text>
              <b><span fg={isComplete ? palette.green : palette.yellow}>{stageLabel}</span></b>
              <span fg={palette.gray}>{"  "}{pct}%  ({opsDone} ops)</span>
            </text>
          </box>
        </box>
      </box>
      {details.length > 0 && (
        <box
          marginLeft={3}
          flexDirection="column"
          {...(Number.isFinite(lineMax) ? { width: lineMax } : {})}
        >
          {details.map((d, i) => (
            <box key={`${i}:${d.text}`} height={1}>
              <text fg={d.color}>{d.text}</text>
            </box>
          ))}
        </box>
      )}
    </box>
  );
}
