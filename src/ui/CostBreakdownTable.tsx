import React from "react";
import { Box, Text } from "ink";
import type { EloRating, ModelSpeed } from "../types.js";

const STAGE_COLS = [
  { key: "initial", label: "Write" },
  { key: "initialJudging", label: "Judge" },
  { key: "feedback", label: "Feedback" },
  { key: "revised", label: "Revise" },
  { key: "revisedJudging", label: "Re-Judge" },
] as const;

interface CostBreakdownTableProps {
  costByModelByStage: Record<string, Record<string, number>>;
  costByModel: Record<string, number>;
  speedByModel: Record<string, ModelSpeed>;
  eloInitial: EloRating[];
  eloRevised: EloRating[];
}

function fmtCost(n: number): string {
  if (n === 0) return "-";
  return `$${n.toFixed(4)}`;
}

function fmtTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function computeAvgElo(
  model: string,
  initial: EloRating[],
  revised: EloRating[]
): number | null {
  const vals: number[] = [];
  const ini = initial.find((r) => r.model === model);
  if (ini) vals.push(ini.rating);
  const rev = revised.find((r) => r.model === model);
  if (rev) vals.push(rev.rating);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

export function CostBreakdownTable({
  costByModelByStage,
  costByModel,
  speedByModel,
  eloInitial,
  eloRevised,
}: CostBreakdownTableProps) {
  const models = Object.keys(costByModel);
  if (models.length === 0) return null;

  // Determine which stages have any data
  const activeStages = STAGE_COLS.filter((s) =>
    models.some((m) => (costByModelByStage[m]?.[s.key] ?? 0) > 0)
  );

  if (activeStages.length === 0) return null;

  const hasElo = eloInitial.length > 0 || eloRevised.length > 0;

  const modelW = Math.max(5, ...models.map((m) => m.length));
  const colW = 9;
  const totalW = 9;
  const timeW = 9;
  const eloW = 7;

  const sep = "  ";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="yellow">
        Cost Breakdown
      </Text>

      {/* Header */}
      <Box>
        <Text color="gray">
          {"Model".padEnd(modelW)}
          {activeStages.map((s) => sep + s.label.padStart(colW)).join("")}
          {sep}{"Total".padStart(totalW)}
          {sep}{"Avg Time".padStart(timeW)}
          {hasElo ? sep + "Avg ELO".padStart(eloW) : ""}
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {"─".repeat(
            modelW +
              activeStages.length * (colW + sep.length) +
              sep.length + totalW +
              sep.length + timeW +
              (hasElo ? sep.length + eloW : 0)
          )}
        </Text>
      </Box>

      {/* Rows */}
      {models.map((model) => {
        const stages = costByModelByStage[model] ?? {};
        const total = costByModel[model] ?? 0;
        const speed = speedByModel[model];
        const avgTime = speed ? fmtTime(speed.avgLatencyMs) : "-";
        const avgElo = computeAvgElo(model, eloInitial, eloRevised);

        return (
          <Box key={model}>
            <Text>{model.padEnd(modelW)}</Text>
            {activeStages.map((s) => {
              const cost = stages[s.key] ?? 0;
              return (
                <Text key={s.key} color="gray">
                  {sep}{fmtCost(cost).padStart(colW)}
                </Text>
              );
            })}
            <Text color="green">
              {sep}{fmtCost(total).padStart(totalW)}
            </Text>
            <Text color="cyan">
              {sep}{avgTime.padStart(timeW)}
            </Text>
            {hasElo && (
              <Text color={avgElo != null ? "white" : "gray"}>
                {sep}{(avgElo != null ? String(avgElo) : "-").padStart(eloW)}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
