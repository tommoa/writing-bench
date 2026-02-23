import type { EloRating, ModelSpeed, TerminalPalette } from "../types.js";
import { estimateRemainingJudgments, overlapFreeThreshold } from "../engine/whr.js";
import type { WhrRating } from "../engine/whr.js";

interface EloTableProps {
  title: string;
  ratings: EloRating[];
  /** Stage-specific cost per model (not total) */
  costByModel?: Record<string, number>;
  /** Stage-specific avg time per model */
  avgTimeByModel?: Record<string, number>;
  /** Raw tok/s -- only shown when --speed flag is set */
  speedByModel?: Record<string, ModelSpeed>;
  /** When provided, show estimated remaining judgments column. */
  ciThreshold?: number;
  palette: TerminalPalette;
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
  palette,
}: EloTableProps) {
  if (ratings.length === 0) return null;

  const showCost = !!costByModel;
  const showTime = !!avgTimeByModel;
  const showSpeed = speedByModel && Object.keys(speedByModel).length > 0;

  // Check if CI data is present (WhrRating extends EloRating with ci95)
  const hasCi = ratings.some((r) => "ci95" in r && typeof (r as any).ci95 === "number");
  const showEst = hasCi && ciThreshold != null;

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

  const headerStr =
    "#".padEnd(rankW) +
    "Model".padEnd(modelW + 2) +
    "ELO".padStart(ratingW) +
    (hasCi ? `  ${"\u00b1CI".padStart(ciW)}` : "") +
    "  " + "W/L/T".padStart(wltW) +
    (showCost ? `  ${"Cost".padStart(costW)}` : "") +
    (showTime ? `  ${"Avg Time".padStart(timeW)}` : "") +
    (showSpeed ? `  ${"Speed".padStart(speedW)}` : "") +
    (showEst ? `  ${"Est.".padStart(estW)}` : "");

  const sepLen =
    rankW + modelW + 2 + ratingW
    + (hasCi ? 2 + ciW : 0)
    + 2 + wltW
    + (showCost ? 2 + costW : 0)
    + (showTime ? 2 + timeW : 0)
    + (showSpeed ? 2 + speedW : 0)
    + (showEst ? 2 + estW : 0);

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={palette.yellow} attributes={1}>{title}</text>
      <text fg={palette.gray}>{headerStr}</text>
      <text fg={palette.gray}>{"\u2500".repeat(sepLen)}</text>
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
          i === 0 ? palette.green : i === ratings.length - 1 ? palette.red : palette.white;
        const estColor =
          estRemaining === 0 ? palette.green
            : estRemaining != null && estRemaining <= 5 ? palette.yellow
            : palette.gray;

        const line =
          String(i + 1).padEnd(rankW) +
          r.model.padEnd(modelW + 2);

        const ratingStr = String(r.rating).padStart(ratingW);
        const ciStr = hasCi ? "  " + (ci95 != null ? `\u00b1${ci95}` : "-").padStart(ciW) : "";
        const wltStr = "  " + wlt.padStart(wltW);
        const costStr = showCost ? "  " + fmtCost(cost).padStart(costW) : "";
        const timeStr = showTime ? "  " + (time != null ? fmtTime(time) : "-").padStart(timeW) : "";
        const speedStr = showSpeed ? "  " + (speed ? fmtSpeed(speed.tokensPerSecond).padStart(speedW) : "-".padStart(speedW)) : "";
        const estStr = showEst
          ? "  " + (estRemaining === 0
              ? "\u2713"
              : estRemaining != null && estRemaining <= 9999
                ? String(estRemaining)
                : "?"
            ).padStart(estW)
          : "";

        return (
          <text key={r.model}>
            <span fg={palette.gray}>{line}</span>
            <span fg={ratingColor}>{ratingStr}</span>
            <span fg={palette.gray}>{ciStr}</span>
            <span fg={palette.gray}>{wltStr}</span>
            {showCost && <span fg={palette.gray}>{costStr}</span>}
            {showTime && <span fg={palette.cyan}>{timeStr}</span>}
            {showSpeed && <span fg={palette.cyan}>{speedStr}</span>}
            {showEst && <span fg={estColor}>{estStr}</span>}
          </text>
        );
      })}
    </box>
  );
}
