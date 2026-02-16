import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { BenchmarkStage } from "../types.js";

const STAGE_LABELS: Record<BenchmarkStage, string> = {
  initialWriting: "Writing",
  initialJudging: "Judging",
  feedback: "Feedback",
  revisedWriting: "Revising",
  revisedJudging: "Re-Judging",
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
  done: number;
  total: number;
}

export function StatusBar({
  stage,
  activeStages,
  currentOp,
  totalCost,
  totalCostUncached,
  costByStage,
  done,
  total,
}: StatusBarProps) {
  const isComplete = stage === "complete";
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const stageEntries = Object.entries(costByStage)
    .filter(([, cost]) => cost > 0)
    .map(([key, cost]) => ({
      label: STAGE_COST_LABELS[key] ?? key,
      cost,
    }));

  // Show uncached cost when it meaningfully differs from actual
  const cacheSaved = totalCostUncached - totalCost;
  const showUncached = cacheSaved > 0.00005;

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
          {"  "}[{done}/{total}] {pct}%
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
      {!isComplete && currentOp && (
        <Box marginLeft={3}>
          <Text color="gray">{currentOp}</Text>
        </Box>
      )}
    </Box>
  );
}
