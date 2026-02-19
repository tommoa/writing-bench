import React from "react";
import { Box, Text } from "ink";
import type { EloRating, JudgeQualityMode, BenchmarkProgress } from "../types.js";
import type { WhrRating } from "../engine/whr.js";
import { DEFAULT_CONVERGENCE } from "../types.js";

interface JudgeQualityTableProps {
  ratings: EloRating[];
  weights?: Record<string, number>;
  pruneThreshold?: number;
  mode?: JudgeQualityMode;
  judgeBias?: BenchmarkProgress["judgeBias"];
}

/**
 * Format a bias delta as a signed percentage with color coding.
 * Distinguishes three states:
 *   isWriter === false:       → "n/a" (judge is not a writer, self-bias N/A)
 *   !sufficient:              → "..." (accumulating data)
 *   sufficient:               → "+12%" (confident, color-coded)
 */
function formatBias(delta: number, sufficient: boolean, isWriter: boolean): { text: string; color: string } {
  if (!isWriter) return { text: "n/a", color: "gray" };
  if (!sufficient || isNaN(delta)) return { text: "...", color: "gray" };
  const pct = Math.round(delta * 100);
  const text = pct >= 0 ? `+${pct}%` : `${pct}%`;
  const absDelta = Math.abs(delta);
  const color = absDelta < 0.05 ? "green" : absDelta < 0.15 ? "yellow" : "red";
  return { text, color };
}

export function JudgeQualityTable({ ratings, weights, pruneThreshold, mode, judgeBias }: JudgeQualityTableProps) {
  if (ratings.length === 0) return null;

  const hasCi = ratings.some((r) => "ci95" in r && typeof (r as any).ci95 === "number");
  const hasBias = judgeBias != null;

  // Column widths
  const rankW = 4;
  const modelW = Math.max(5, ...ratings.map((r) => r.model.length));
  const ratingW = 6;
  const ciW = 6;
  const wltW = Math.max(7, ...ratings.map((r) => `${r.wins}/${r.losses}/${r.ties}`.length));
  const weightW = 7;
  const selfW = 7;
  const posW = 7;
  const statusW = 7;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="yellow">
        Judge Quality{mode && mode !== "consensus" ? ` (${mode} ELO)` : ""}
      </Text>
      <Box>
        <Text color="gray">
          {"#".padEnd(rankW)}
          {"Judge".padEnd(modelW + 2)}
          {"Rating".padStart(ratingW)}
          {hasCi ? `  ${"\u00b1CI".padStart(ciW)}` : ""}
          {"  "}{"W/L/T".padStart(wltW)}
          {"  "}{"Weight".padStart(weightW)}
          {hasBias ? `  ${"Self%".padStart(selfW)}` : ""}
          {hasBias ? `  ${"Pos%".padStart(posW)}` : ""}
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
            + (hasBias ? 2 + selfW + 2 + posW : 0)
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

        const selfBias = judgeBias?.selfPreference?.[r.model];
        const posBias = judgeBias?.positionBias?.[r.model];
        // Self-bias: "n/a" only when the judge has no self-preference data (not a writer)
        const selfFmt = selfBias
          ? formatBias(selfBias.biasDelta, selfBias.sufficient, selfBias.selfJudgmentCount > 0)
          : { text: "n/a", color: "gray" };
        // Position bias: always "..." (accumulating) rather than "n/a" when the judge
        // is a writer — count=0 just means no position-known judgments yet (legacy cache)
        const isWriter = selfBias != null;
        const posFmt = posBias
          ? formatBias(posBias.positionBiasDelta, posBias.sufficient, isWriter)
          : { text: isWriter ? "..." : "n/a", color: "gray" };

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
            {hasBias && (
              <Text color={selfFmt.color}>
                {"  "}{selfFmt.text.padStart(selfW)}
              </Text>
            )}
            {hasBias && (
              <Text color={posFmt.color}>
                {"  "}{posFmt.text.padStart(posW)}
              </Text>
            )}
            <Text color={isPruned ? "red" : "green"}>
              {"  "}{(isPruned ? "pruned" : "active").padStart(statusW)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
