import React from "react";
import { Box, Text } from "ink";
import type { EloRating, ModelSpeed } from "../types.js";
import { estimateRemainingJudgments, overlapFreeThreshold } from "../engine/whr.js";
import type { WhrRating } from "../engine/whr.js";

interface EloTableProps {
  title: string;
  ratings: EloRating[];
  /** Stage-specific cost per model (not total) */
  costByModel?: Record<string, number>;
  /** Stage-specific avg time per model */
  avgTimeByModel?: Record<string, number>;
  /** Raw tok/s — only shown when --speed flag is set */
  speedByModel?: Record<string, ModelSpeed>;
  /** When provided, show estimated remaining judgments column. */
  ciThreshold?: number;
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
  ciThreshold,
}: EloTableProps) {
  if (ratings.length === 0) return null;

  const showCost = !!costByModel;
  const showTime = !!avgTimeByModel;
  const showSpeed = speedByModel && Object.keys(speedByModel).length > 0;

  // Check if CI data is present (WhrRating extends EloRating with ci95)
  const hasCi = ratings.some((r) => "ci95" in r && typeof (r as any).ci95 === "number");
  const showEst = hasCi && ciThreshold != null && ciThreshold > 0;

  // Column widths
  const rankW = 4;
  const modelW = Math.max(5, ...ratings.map((r) => r.model.length));
  const ratingW = 6;
  const ciW = 6;
  const wltW = 11;
  const costW = 8;
  const timeW = 9;
  const speedW = 12;
  const estW = 5;
  const whrRatings = hasCi ? ratings as WhrRating[] : undefined;

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
          {hasCi ? `  ${"\u00b1CI".padStart(ciW)}` : ""}
          {"  "}
          {"W/L/T".padStart(wltW)}
          {showCost ? `  ${"Cost".padStart(costW)}` : ""}
          {showTime ? `  ${"Avg Time".padStart(timeW)}` : ""}
          {showSpeed ? `  ${"Speed".padStart(speedW)}` : ""}
          {showEst ? `  ${"Est.".padStart(estW)}` : ""}
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {"─".repeat(
            rankW + modelW + 2 + ratingW
            + (hasCi ? 2 + ciW : 0)
            + 2 + wltW
            + (showCost ? 2 + costW : 0)
            + (showTime ? 2 + timeW : 0)
            + (showSpeed ? 2 + speedW : 0)
            + (showEst ? 2 + estW : 0)
          )}
        </Text>
      </Box>
      {ratings.map((r, i) => {
        const wlt = `${r.wins}/${r.losses}/${r.ties}`;
        const cost = costByModel?.[r.model] ?? 0;
        const time = avgTimeByModel?.[r.model];
        const speed = speedByModel?.[r.model];
        const ci95 = "ci95" in r ? (r as any).ci95 as number : undefined;
        const estRemaining = showEst
          ? estimateRemainingJudgments(
              ci95 ?? Infinity,
              r.matchCount,
              ciThreshold!,
              whrRatings ? overlapFreeThreshold(r as WhrRating, whrRatings) : undefined,
            )
          : undefined;
        const ratingColor =
          i === 0 ? "green" : i === ratings.length - 1 ? "red" : "white";

        return (
          <Box key={r.model}>
            <Text color="gray">{String(i + 1).padEnd(rankW)}</Text>
            <Text>{r.model.padEnd(modelW + 2)}</Text>
            <Text color={ratingColor}>
              {String(r.rating).padStart(ratingW)}
            </Text>
            {hasCi && (
              <Text color="gray">
                {"  "}{(ci95 != null ? `\u00b1${ci95}` : "-").padStart(ciW)}
              </Text>
            )}
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
            {showEst && (
              <Text
                color={
                  estRemaining === 0 ? "green"
                    : estRemaining != null && estRemaining <= 5 ? "yellow"
                    : "gray"
                }
              >
                {"  "}
                {(estRemaining === 0
                  ? "\u2713"
                  : estRemaining != null
                    ? String(estRemaining)
                    : "?"
                ).padStart(estW)}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
