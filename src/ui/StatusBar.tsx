import { useState, useEffect } from "react";
import type { BenchmarkStage } from "../types.js";
import { formatConvergenceTarget } from "../engine/need-identifier.js";
import { usePalette } from "./PaletteContext.js";

// ── Spinner ──────────────────────────────────────────

const SPINNER_FRAMES = ["\u28cb", "\u28d9", "\u28f9", "\u28f8", "\u28fc", "\u28f4", "\u28e6", "\u28e7", "\u28c7", "\u28cf"];

function Spinner({ color }: { color: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <span fg={color}>{SPINNER_FRAMES[frame]}</span>;
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
  needDescription,
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
    if (maxCi != null) roundText += ` | CI \u00b1${maxCi}`;
    if (ciThreshold != null) roundText += ` \u2192 target ${formatConvergenceTarget(ciThreshold)}`;
    details.push({ text: roundText, color: palette.magenta });
  }
  if (suspendedModels && suspendedModels.length > 0) {
    details.push({ text: `Suspended: ${suspendedModels.join(", ")}`, color: palette.yellow });
  }
  if (!isComplete && currentOp) {
    details.push({
      text: truncate(
        (needDescription ? `${needDescription} \u2014 ` : "") + currentOp,
        lineMax,
      ),
      color: palette.gray,
    });
  }

  return (
    <box flexDirection="column" marginBottom={1} live={!isComplete}>
      <box>
        <text>
          {!isComplete && (
            <>
              <Spinner color={palette.cyan} />
              {"  "}
            </>
          )}
          <b><span fg={isComplete ? palette.green : palette.yellow}>{stageLabel}</span></b>
          <span fg={palette.gray}>{"  "}{pct}%  ({opsDone} ops)</span>
        </text>
      </box>
      {details.length > 0 && (
        <box marginLeft={3}>
          <text>
            {details.map((d, i) => (
              <span key={i}>
                {i > 0 && "\n"}
                <span fg={d.color}>{d.text}</span>
              </span>
            ))}
          </text>
        </box>
      )}
    </box>
  );
}
