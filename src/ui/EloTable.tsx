import React from "react";
import { Box, Text } from "ink";
import type { EloRating, ModelSpeed } from "../types.js";

interface EloTableProps {
  title: string;
  ratings: EloRating[];
  /** Stage-specific cost per model (not total) */
  costByModel?: Record<string, number>;
  /** Stage-specific avg time per model */
  avgTimeByModel?: Record<string, number>;
  /** Raw tok/s — only shown when --speed flag is set */
  speedByModel?: Record<string, ModelSpeed>;
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtSpeed(tps: number): string {
  if (tps >= 100) return `${Math.round(tps)} tok/s`;
  if (tps >= 10) return `${tps.toFixed(1)} tok/s`;
  return `${tps.toFixed(2)} tok/s`;
}

export function EloTable({
  title,
  ratings,
  costByModel,
  avgTimeByModel,
  speedByModel,
}: EloTableProps) {
  if (ratings.length === 0) return null;

  const showCost = costByModel && Object.keys(costByModel).length > 0;
  const showTime = avgTimeByModel && Object.keys(avgTimeByModel).length > 0;
  const showSpeed = speedByModel && Object.keys(speedByModel).length > 0;

  // Column widths
  const rankW = 4;
  const modelW = Math.max(5, ...ratings.map((r) => r.model.length));
  const ratingW = 6;
  const wltW = 11;
  const costW = 8;
  const timeW = 9;
  const speedW = 12;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="yellow">
        {title}
      </Text>
      <Box>
        <Text color="gray">
          {"#".padEnd(rankW)}
          {"Model".padEnd(modelW + 2)}
          {"ELO".padStart(ratingW)}
          {"  "}
          {"W/L/T".padStart(wltW)}
          {showCost ? `  ${"Cost".padStart(costW)}` : ""}
          {showTime ? `  ${"Avg Time".padStart(timeW)}` : ""}
          {showSpeed ? `  ${"Speed".padStart(speedW)}` : ""}
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {"─".repeat(
            rankW + modelW + 2 + ratingW + 2 + wltW
            + (showCost ? 2 + costW : 0)
            + (showTime ? 2 + timeW : 0)
            + (showSpeed ? 2 + speedW : 0)
          )}
        </Text>
      </Box>
      {ratings.map((r, i) => {
        const wlt = `${r.wins}/${r.losses}/${r.ties}`;
        const cost = costByModel?.[r.model] ?? 0;
        const time = avgTimeByModel?.[r.model];
        const speed = speedByModel?.[r.model];
        const ratingColor =
          i === 0 ? "green" : i === ratings.length - 1 ? "red" : "white";

        return (
          <Box key={r.model}>
            <Text color="gray">{String(i + 1).padEnd(rankW)}</Text>
            <Text>{r.model.padEnd(modelW + 2)}</Text>
            <Text color={ratingColor}>
              {String(r.rating).padStart(ratingW)}
            </Text>
            <Text color="gray">{"  "}{wlt.padStart(wltW)}</Text>
            {showCost && (
              <Text color="gray">
                {"  "}{fmtCost(cost).padStart(costW)}
              </Text>
            )}
            {showTime && (
              <Text color="cyan">
                {"  "}{(time != null ? fmtTime(time) : "-").padStart(timeW)}
              </Text>
            )}
            {showSpeed && (
              <Text color="cyan">
                {"  "}{speed ? fmtSpeed(speed.tokensPerSecond).padStart(speedW) : "-".padStart(speedW)}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
