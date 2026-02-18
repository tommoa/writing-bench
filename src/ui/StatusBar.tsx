import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { BenchmarkStage, CacheSavings } from "../types.js";

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

  // Cache breakdown — only show if anything was cached
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
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {!isComplete && (
          <Text color="cyan">
            <Spinner type="dots" />
            {"  "}
          </Text>
        )}
        <Text bold color={isComplete ? "green" : "yellow"}>
          {stageLabel}
        </Text>
        <Text color="gray">
          {"  "}{pct}%  ({opsDone} ops)
        </Text>
        <Text color="gray">{"  "}|{"  "}</Text>
        <Text color="green">${totalCost.toFixed(4)}</Text>
        {showUncached && (
          <Text color="gray">
            {"  "}(uncached: ${totalCostUncached.toFixed(4)})
          </Text>
        )}
      </Box>
      {stageEntries.length > 0 && (
        <Box marginLeft={3}>
          {stageEntries.map(({ label, cost }, i) => (
            <Text key={label} color="gray">
              {i > 0 ? "  " : ""}
              {label}: <Text color="white">${cost.toFixed(4)}</Text>
            </Text>
          ))}
        </Box>
      )}
      {totalFresh > 0 && hasCacheActivity && (
        <Box marginLeft={3}>
          <Text color="gray">{`Fresh: ${cacheSavings.writes.fresh}w ${cacheSavings.feedback.fresh}fb ${cacheSavings.revisions.fresh}rev ${cacheSavings.judgments.fresh}j`}</Text>
        </Box>
      )}
      {totalCached > 0 && (
        <Box marginLeft={3}>
          <Text color="cyan">{`Cached: ${cacheSavings.writes.cached}w ${cacheSavings.feedback.cached}fb ${cacheSavings.revisions.cached}rev ${cacheSavings.judgments.cached}j (saved ~$${totalSavedCost.toFixed(4)})`}</Text>
        </Box>
      )}
      {judgingRound != null && judgingRound > 0 && (
        <Box marginLeft={3}>
          <Text color="magenta">
            {`Round ${judgingRound}`}
            {batchSummary ? ` | ${batchSummary}` : ""}
            {maxCi != null ? ` | CI \u00b1${maxCi}` : ""}
            {ciThreshold != null ? ` \u2192 target \u00b1${ciThreshold}` : ""}
          </Text>
        </Box>
      )}
      {!isComplete && currentOp && (
        <Box marginLeft={3}>
          {needDescription && (
            <Text color="gray">{needDescription}{" \u2014 "}</Text>
          )}
          <Text color="gray" dimColor>{currentOp}</Text>
        </Box>
      )}
    </Box>
  );
}
