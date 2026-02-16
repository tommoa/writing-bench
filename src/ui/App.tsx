import React, { useState, useEffect, useMemo } from "react";
import { Box, Text } from "ink";
import { StatusBar } from "./StatusBar.js";
import { EloTable } from "./EloTable.js";
import { CostBreakdownTable } from "./CostBreakdownTable.js";
import { RunProgress } from "./RunProgress.js";
import type { BenchmarkEvent, BenchmarkProgress, CacheSavings, ModelSpeed } from "../types.js";

interface AppProps {
  subscribe: (handler: (event: BenchmarkEvent) => void) => void;
  showSpeed?: boolean;
}

/**
 * Extract a { model: value } map for a single stage from the
 * model×stage cross-product maps.
 */
function sliceCostForStage(
  byModelByStage: Record<string, Record<string, number>>,
  stage: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, stages] of Object.entries(byModelByStage)) {
    const v = stages[stage];
    if (v != null && v > 0) out[model] = v;
  }
  return out;
}

function sliceAvgTimeForStage(
  byModelByStage: Record<string, Record<string, ModelSpeed>>,
  stage: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, stages] of Object.entries(byModelByStage)) {
    const s = stages[stage];
    if (s) out[model] = s.avgLatencyMs;
  }
  return out;
}

export function App({ subscribe, showSpeed }: AppProps) {
  const [progress, setProgress] = useState<BenchmarkProgress>({
    stage: "initialWriting",
    activeStages: [],
    stageProgress: 0,
    stageTotal: 0,
    stageDone: 0,
    currentOp: "Starting...",
    elo: { initial: [], revised: [], feedback: [] },
    totalCost: 0,
    totalCostUncached: 0,
    costByModel: {},
    costByStage: {},
    costByModelByStage: {},
    speedByModel: {},
    speedByModelByStage: {},
    cacheSavings: {
      writes:    { cached: 0, fresh: 0, savedCost: 0 },
      feedback:  { cached: 0, fresh: 0, savedCost: 0 },
      revisions: { cached: 0, fresh: 0, savedCost: 0 },
      judgments:  { cached: 0, fresh: 0, savedCost: 0 },
    },
  });

  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    subscribe((event) => {
      switch (event.type) {
        case "progress":
          setProgress(event.data);
          break;
        case "stageComplete":
          break;
        case "complete":
          setProgress((prev) => ({
            ...prev,
            stage: "complete",
            currentOp: "Benchmark complete!",
          }));
          setComplete(true);
          break;
        case "error":
          setError(event.data.message);
          break;
      }
    });
  }, [subscribe]);

  // Stage-specific slices for ELO table cost/time columns
  const initialCost = useMemo(
    () => sliceCostForStage(progress.costByModelByStage, "initial"),
    [progress.costByModelByStage]
  );
  const initialTime = useMemo(
    () => sliceAvgTimeForStage(progress.speedByModelByStage, "initial"),
    [progress.speedByModelByStage]
  );
  const revisedCost = useMemo(
    () => sliceCostForStage(progress.costByModelByStage, "revised"),
    [progress.costByModelByStage]
  );
  const revisedTime = useMemo(
    () => sliceAvgTimeForStage(progress.speedByModelByStage, "revised"),
    [progress.speedByModelByStage]
  );
  const feedbackCost = useMemo(
    () => sliceCostForStage(progress.costByModelByStage, "feedback"),
    [progress.costByModelByStage]
  );
  const feedbackTime = useMemo(
    () => sliceAvgTimeForStage(progress.speedByModelByStage, "feedback"),
    [progress.speedByModelByStage]
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          writing-bench
        </Text>
      </Box>

      <StatusBar
        stage={progress.stage}
        activeStages={progress.activeStages}
        currentOp={progress.currentOp}
        totalCost={progress.totalCost}
        totalCostUncached={progress.totalCostUncached}
        costByStage={progress.costByStage}
        done={progress.stageDone}
        total={progress.stageTotal}
        cacheSavings={progress.cacheSavings}
      />

      <RunProgress done={progress.stageDone} total={progress.stageTotal} />

      <Box marginTop={1} />

      {progress.elo.initial.length > 0 && (
        <EloTable
          title="Writer ELO (Initial)"
          ratings={progress.elo.initial}
          costByModel={initialCost}
          avgTimeByModel={initialTime}
          speedByModel={showSpeed ? progress.speedByModel : undefined}
        />
      )}

      {progress.elo.revised.length > 0 && (
        <EloTable
          title="Writer ELO (Revised)"
          ratings={progress.elo.revised}
          costByModel={revisedCost}
          avgTimeByModel={revisedTime}
          speedByModel={showSpeed ? progress.speedByModel : undefined}
        />
      )}

      {progress.elo.feedback.length > 0 && (
        <EloTable
          title="Feedback Provider ELO"
          ratings={progress.elo.feedback}
          costByModel={feedbackCost}
          avgTimeByModel={feedbackTime}
          speedByModel={showSpeed ? progress.speedByModel : undefined}
        />
      )}

      <CostBreakdownTable
        costByModelByStage={progress.costByModelByStage}
        costByModel={progress.costByModel}
        speedByModel={progress.speedByModel}
        eloInitial={progress.elo.initial}
        eloRevised={progress.elo.revised}
      />

      {error && (
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {complete && (
        <Box marginTop={1}>
          <Text color="green" bold>
            Benchmark complete! Total cost: ${progress.totalCost.toFixed(4)}
            {progress.totalCostUncached > progress.totalCost + 0.00005
              ? ` (uncached: $${progress.totalCostUncached.toFixed(4)})`
              : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
}
