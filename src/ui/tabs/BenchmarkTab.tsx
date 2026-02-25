import { useMemo } from "react";
import { StatusBar } from "../StatusBar.js";
import { EloTable } from "../EloTable.js";
import { JudgeQualityTable } from "../JudgeQualityTable.js";
import { CostBreakdownTable } from "../CostBreakdownTable.js";
import { RunProgress } from "../RunProgress.js";
import type { BenchmarkProgress, ModelSpeed } from "../../types.js";
import { usePalette } from "../PaletteContext.js";

interface BenchmarkTabProps {
  progress: BenchmarkProgress;
  error: string | null;
  showSpeed?: boolean;
  /** Render CostBreakdownTable inline (when sidebar is hidden). */
  showCostInline: boolean;
  /** Available width in columns for the main content area. */
  contentWidth?: number;
}

// ── Helpers ─────────────────────────────────────────

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

// ── Component ───────────────────────────────────────

export function BenchmarkTab({
  progress,
  error,
  showSpeed,
  showCostInline,
  contentWidth,
}: BenchmarkTabProps) {
  const palette = usePalette();
  const complete = progress.stage === "complete";
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
      <box paddingLeft={1}>
        <StatusBar
          stage={progress.stage}
          activeStages={progress.activeStages}
          currentOp={progress.currentOp}
          stageProgress={progress.stageProgress}
          opsDone={progress.stageDone}
          judgingRound={progress.judgingRound}
          maxCi={progress.maxCi}
          ciThreshold={progress.ciThreshold}
          needDescription={progress.needDescription}
          batchSummary={progress.batchSummary}
          suspendedModels={progress.suspendedModels}
          contentWidth={contentWidth}
        />
      </box>

      <box paddingLeft={1}>
        <RunProgress
          progress={progress.stageProgress}
          opsDone={progress.stageDone}
        />
      </box>

      {/* ── Scrollable tables area ──────────────────── */}
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
          />
        )}

        {progress.elo.judgeQuality && progress.elo.judgeQuality.length > 0 && (
          <JudgeQualityTable
            ratings={progress.elo.judgeQuality}
            weights={progress.judgeWeights}
            pruneThreshold={progress.judgePruneThreshold}
            mode={progress.judgeQualityMode}
            judgeBias={progress.judgeBias}
          />
        )}

        {showCostInline && (
          <CostBreakdownTable
            costByModelByStage={progress.costByModelByStage}
            costByModel={progress.costByModel}
            speedByModel={progress.speedByModel}
            eloInitial={progress.elo.initial}
            eloRevised={progress.elo.revised}
          />
        )}
      </scrollbox>

      {/* ── Status footer ─────────────────────────── */}
      {error && (
        <box marginTop={1} paddingLeft={1}>
          <text fg={palette.red}>{error}</text>
        </box>
      )}

      {complete && (
        <box marginTop={1} paddingLeft={1} flexDirection="column">
          <box>
            <text fg={palette.green} attributes={1}>
              Benchmark complete! Total cost: ${progress.totalCost.toFixed(4)}
              {progress.totalCostUncached > progress.totalCost + 0.00005
                ? ` (uncached: $${progress.totalCostUncached.toFixed(4)})`
                : ""}
            </text>
          </box>
          <box marginTop={1}>
            <text fg={palette.gray}>Press [n] for new run</text>
          </box>
        </box>
      )}
    </box>
  );
}
