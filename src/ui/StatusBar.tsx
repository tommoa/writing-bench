import { useState, useEffect } from "react";
import type { BenchmarkStage, CacheSavings, TerminalPalette } from "../types.js";
import { formatConvergenceTarget } from "../engine/need-identifier.js";

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

const STAGE_COST_LABELS: Record<string, string> = {
  initial: "Write",
  initialJudging: "Judge",
  feedback: "Feedback",
  revised: "Revise",
  revisedJudging: "Re-Judge",
};

// ── Component ────────────────────────────────────────

interface StatusBarProps {
  stage: BenchmarkStage;
  activeStages: BenchmarkStage[];
  currentOp: string;
  totalCost: number;
  totalCostUncached: number;
  costByStage: Record<string, number>;
  stageProgress: number;
  opsDone: number;
  cacheSavings: CacheSavings;
  judgingRound?: number;
  maxCi?: number;
  ciThreshold?: number;
  needDescription?: string;
  batchSummary?: string;
  suspendedModels?: string[];
  palette: TerminalPalette;
}

export function StatusBar({
  stage,
  activeStages,
  currentOp,
  totalCost,
  totalCostUncached,
  costByStage,
  stageProgress,
  opsDone,
  cacheSavings,
  judgingRound,
  maxCi,
  ciThreshold,
  needDescription,
  batchSummary,
  suspendedModels,
  palette,
}: StatusBarProps) {
  const isComplete = stage === "complete";
  const pct = isComplete ? 100 : Math.round(stageProgress * 100);

  const stageEntries = Object.entries(costByStage)
    .filter(([, cost]) => cost > 0)
    .map(([key, cost]) => ({
      label: STAGE_COST_LABELS[key] ?? key,
      cost,
    }));

  // Show uncached cost when it meaningfully differs from actual
  const cacheSaved = totalCostUncached - totalCost;
  const showUncached = cacheSaved > 0.00005;

  // Cache breakdown -- only show if anything was cached
  const totalCached =
    cacheSavings.writes.cached +
    cacheSavings.feedback.cached +
    cacheSavings.revisions.cached +
    cacheSavings.judgments.cached;
  const totalFresh =
    cacheSavings.writes.fresh +
    cacheSavings.feedback.fresh +
    cacheSavings.revisions.fresh +
    cacheSavings.judgments.fresh;
  const totalSavedCost =
    cacheSavings.writes.savedCost +
    cacheSavings.feedback.savedCost +
    cacheSavings.revisions.savedCost +
    cacheSavings.judgments.savedCost;
  const hasCacheActivity = totalCached > 0 || totalFresh > 0;

  // Active stages label
  const stageLabel = isComplete
    ? "Complete"
    : activeStages.length > 0
      ? activeStages.map((s) => STAGE_LABELS[s]).join(", ")
      : "Starting...";

  return (
    <box flexDirection="column" marginBottom={1} live={!isComplete}>
      <text>
        {!isComplete && (
          <>
            <Spinner color={palette.cyan} />
            {"  "}
          </>
        )}
        <b><span fg={isComplete ? palette.green : palette.yellow}>{stageLabel}</span></b>
        <span fg={palette.gray}>{"  "}{pct}%  ({opsDone} ops)</span>
        <span fg={palette.gray}>{"  "}|{"  "}</span>
        <span fg={palette.green}>${totalCost.toFixed(4)}</span>
        {showUncached && (
          <span fg={palette.gray}>{"  "}(uncached: ${totalCostUncached.toFixed(4)})</span>
        )}
      </text>
      {stageEntries.length > 0 && (
        <box marginLeft={3}>
          <text fg={palette.gray}>
            {stageEntries.map(({ label, cost }, i) => (
              <span key={label}>
                {i > 0 ? "  " : ""}
                {label}: <span fg={palette.white}>${cost.toFixed(4)}</span>
              </span>
            ))}
          </text>
        </box>
      )}
      {totalFresh > 0 && hasCacheActivity && (
        <box marginLeft={3}>
          <text fg={palette.gray}>{`Fresh: ${cacheSavings.writes.fresh}w ${cacheSavings.feedback.fresh}fb ${cacheSavings.revisions.fresh}rev ${cacheSavings.judgments.fresh}j`}</text>
        </box>
      )}
      {totalCached > 0 && (
        <box marginLeft={3}>
          <text fg={palette.cyan}>{`Cached: ${cacheSavings.writes.cached}w ${cacheSavings.feedback.cached}fb ${cacheSavings.revisions.cached}rev ${cacheSavings.judgments.cached}j (saved ~$${totalSavedCost.toFixed(4)})`}</text>
        </box>
      )}
      {judgingRound != null && judgingRound > 0 && (
        <box marginLeft={3}>
          <text fg={palette.magenta}>
            {`Round ${judgingRound}`}
            {batchSummary ? ` | ${batchSummary}` : ""}
            {maxCi != null ? ` | CI \u00b1${maxCi}` : ""}
            {ciThreshold != null ? ` \u2192 target ${formatConvergenceTarget(ciThreshold)}` : ""}
          </text>
        </box>
      )}
      {suspendedModels && suspendedModels.length > 0 && (
        <box marginLeft={3}>
          <text fg={palette.yellow}>{"Suspended: "}{suspendedModels.join(", ")}</text>
        </box>
      )}
      {!isComplete && currentOp && (
        <box marginLeft={3}>
          <text>
            {needDescription && (
              <span fg={palette.gray}>{needDescription}{" \u2014 "}</span>
            )}
            <span fg={palette.gray} attributes={2}>{currentOp}</span>
          </text>
        </box>
      )}
    </box>
  );
}
