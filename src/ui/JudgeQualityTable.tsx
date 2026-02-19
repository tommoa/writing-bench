import React from "react";
import { Box, Text } from "ink";
import type { EloRating } from "../types.js";
import type { WhrRating } from "../engine/whr.js";
import { DEFAULT_CONVERGENCE } from "../types.js";

interface JudgeQualityTableProps {
  ratings: EloRating[];
  weights?: Record<string, number>;
  pruneThreshold?: number;
}

export function JudgeQualityTable({ ratings, weights, pruneThreshold }: JudgeQualityTableProps) {
  if (ratings.length === 0) return null;

  const hasCi = ratings.some((r) => "ci95" in r && typeof (r as any).ci95 === "number");

  // Column widths
  const rankW = 4;
  const modelW = Math.max(5, ...ratings.map((r) => r.model.length));
  const ratingW = 6;
  const ciW = 6;
  const wltW = Math.max(7, ...ratings.map((r) => `${r.wins}/${r.losses}/${r.ties}`.length));
  const weightW = 7;
  const statusW = 7;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="yellow">
        Judge Quality
      </Text>
      <Box>
        <Text color="gray">
          {"#".padEnd(rankW)}
          {"Judge".padEnd(modelW + 2)}
          {"Rating".padStart(ratingW)}
          {hasCi ? `  ${"\u00b1CI".padStart(ciW)}` : ""}
          {"  "}{"W/L/T".padStart(wltW)}
          {"  "}{"Weight".padStart(weightW)}
          {"  "}{"Status".padStart(statusW)}
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {"─".repeat(
            rankW + modelW + 2 + ratingW
            + (hasCi ? 2 + ciW : 0)
            + 2 + wltW
            + 2 + weightW
            + 2 + statusW
          )}
        </Text>
      </Box>
      {ratings.map((r, i) => {
        const ci95 = "ci95" in r ? (r as WhrRating).ci95 : undefined;
        const wlt = `${r.wins}/${r.losses}/${r.ties}`;
        const weight = weights?.[r.model] ?? 1.0;
        const isPruned = weight < (pruneThreshold ?? DEFAULT_CONVERGENCE.judgePruneThreshold);
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
                {"  "}{(ci95 != null && ci95 !== Infinity ? `\u00b1${ci95}` : "-").padStart(ciW)}
              </Text>
            )}
            <Text>
              {"  "}{wlt.padStart(wltW)}
            </Text>
            <Text color="gray">
              {"  "}{`${weight.toFixed(2)}x`.padStart(weightW)}
            </Text>
            <Text color={isPruned ? "red" : "green"}>
              {"  "}{(isPruned ? "pruned" : "active").padStart(statusW)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
