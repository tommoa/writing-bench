import { useReducer, useEffect, useMemo } from "react";
import { StatusBar } from "./StatusBar.js";
import { EloTable } from "./EloTable.js";
import { JudgeQualityTable } from "./JudgeQualityTable.js";
import { CostBreakdownTable } from "./CostBreakdownTable.js";
import { RunProgress } from "./RunProgress.js";
import { appReducer, benchmarkEventToAction, INITIAL_STATE } from "./state.js";
import type { BenchmarkEvent, ModelSpeed, TerminalPalette } from "../types.js";

interface AppProps {
  subscribe: (handler: (event: BenchmarkEvent) => void) => void;
  showSpeed?: boolean;
  palette: TerminalPalette;
}

/**
 * Extract a { model: value } map for a single stage from the
 * model x stage cross-product maps.
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

export function App({ subscribe, showSpeed, palette }: AppProps) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  const { benchmark } = state;
  const progress = benchmark.progress;

  useEffect(() => {
    subscribe((event) => {
      const action = benchmarkEventToAction(event);
      if (action) dispatch(action);
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
    <box flexDirection="column" flexGrow={1}>
      {/* ── Fixed header ──────────────────────────────── */}
      <box marginBottom={1} paddingLeft={1} paddingTop={1}>
        <text fg={palette.cyan} attributes={1}>writing-bench</text>
      </box>

      <box paddingLeft={1}>
        <StatusBar
          stage={progress.stage}
          activeStages={progress.activeStages}
          currentOp={progress.currentOp}
          totalCost={progress.totalCost}
          totalCostUncached={progress.totalCostUncached}
          costByStage={progress.costByStage}
          stageProgress={progress.stageProgress}
          opsDone={progress.stageDone}
          cacheSavings={progress.cacheSavings}
          judgingRound={progress.judgingRound}
          maxCi={progress.maxCi}
          ciThreshold={progress.ciThreshold}
          needDescription={progress.needDescription}
          batchSummary={progress.batchSummary}
          suspendedModels={progress.suspendedModels}
          palette={palette}
        />
      </box>

      <box paddingLeft={1}>
        <RunProgress progress={progress.stageProgress} opsDone={progress.stageDone} palette={palette} />
      </box>

      {/* ── Scrollable tables area ────────────────────── */}
      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        focused={true}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
      >
        {progress.elo.initial.length > 0 && (
          <EloTable
            title="Writer ELO (Initial)"
            ratings={progress.elo.initial}
            costByModel={initialCost}
            avgTimeByModel={initialTime}
            speedByModel={showSpeed ? progress.speedByModel : undefined}
            ciThreshold={progress.ciThreshold}
            palette={palette}
          />
        )}

        {progress.elo.revised.length > 0 && (
          <EloTable
            title="Writer ELO (Revised)"
            ratings={progress.elo.revised}
            costByModel={revisedCost}
            avgTimeByModel={revisedTime}
            speedByModel={showSpeed ? progress.speedByModel : undefined}
            ciThreshold={progress.ciThreshold}
            palette={palette}
          />
        )}

        {progress.elo.feedback.length > 0 && (
          <EloTable
            title="Feedback Provider ELO"
            ratings={progress.elo.feedback}
            costByModel={feedbackCost}
            avgTimeByModel={feedbackTime}
            speedByModel={showSpeed ? progress.speedByModel : undefined}
            ciThreshold={progress.ciThreshold}
            palette={palette}
          />
        )}

        {progress.elo.judgeQuality && progress.elo.judgeQuality.length > 0 && (
          <JudgeQualityTable
            ratings={progress.elo.judgeQuality}
            weights={progress.judgeWeights}
            pruneThreshold={progress.judgePruneThreshold}
            mode={progress.judgeQualityMode}
            judgeBias={progress.judgeBias}
            palette={palette}
          />
        )}

        <CostBreakdownTable
          costByModelByStage={progress.costByModelByStage}
          costByModel={progress.costByModel}
          speedByModel={progress.speedByModel}
          eloInitial={progress.elo.initial}
          eloRevised={progress.elo.revised}
          palette={palette}
        />
      </scrollbox>

      {/* ── Status footer ─────────────────────────────── */}
      {benchmark.error && (
        <box marginTop={1} paddingLeft={1}>
          <text fg={palette.red}>Error: {benchmark.error}</text>
        </box>
      )}

      {benchmark.complete && (
        <box marginTop={1} paddingLeft={1}>
          <text fg={palette.green} attributes={1}>
            Benchmark complete! Total cost: ${progress.totalCost.toFixed(4)}
            {progress.totalCostUncached > progress.totalCost + 0.00005
              ? ` (uncached: $${progress.totalCostUncached.toFixed(4)})`
              : ""}
          </text>
        </box>
      )}
    </box>
  );
}
