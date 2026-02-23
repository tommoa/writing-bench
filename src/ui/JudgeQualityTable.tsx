import type { EloRating, JudgeQualityMode, BenchmarkProgress, TerminalPalette } from "../types.js";
import type { WhrRating } from "../engine/whr.js";
import { DEFAULT_CONVERGENCE } from "../types.js";

interface JudgeQualityTableProps {
  ratings: EloRating[];
  weights?: Record<string, number>;
  pruneThreshold?: number;
  mode?: JudgeQualityMode;
  judgeBias?: BenchmarkProgress["judgeBias"];
  palette: TerminalPalette;
}

/**
 * Format a bias delta as a signed percentage with color coding.
 * Distinguishes three states:
 *   isWriter === false:       -> "n/a" (judge is not a writer, self-bias N/A)
 *   !sufficient:              -> "..." (accumulating data)
 *   sufficient:               -> "+12%" (confident, color-coded)
 */
function formatBias(
  delta: number,
  sufficient: boolean,
  isWriter: boolean,
  palette: TerminalPalette,
): { text: string; color: string } {
  if (!isWriter) return { text: "n/a", color: palette.gray };
  if (!sufficient || isNaN(delta)) return { text: "...", color: palette.gray };
  const pct = Math.round(delta * 100);
  const text = pct >= 0 ? `+${pct}%` : `${pct}%`;
  const absDelta = Math.abs(delta);
  const color = absDelta < 0.05 ? palette.green : absDelta < 0.15 ? palette.yellow : palette.red;
  return { text, color };
}

export function JudgeQualityTable({ ratings, weights, pruneThreshold, mode, judgeBias, palette }: JudgeQualityTableProps) {
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

  const headerStr =
    "#".padEnd(rankW) +
    "Judge".padEnd(modelW + 2) +
    "Rating".padStart(ratingW) +
    (hasCi ? `  ${"\u00b1CI".padStart(ciW)}` : "") +
    "  " + "W/L/T".padStart(wltW) +
    "  " + "Weight".padStart(weightW) +
    (hasBias ? `  ${"Self%".padStart(selfW)}` : "") +
    (hasBias ? `  ${"Pos%".padStart(posW)}` : "") +
    "  " + "Status".padStart(statusW);

  const sepLen =
    rankW + modelW + 2 + ratingW
    + (hasCi ? 2 + ciW : 0)
    + 2 + wltW
    + 2 + weightW
    + (hasBias ? 2 + selfW + 2 + posW : 0)
    + 2 + statusW;

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={palette.yellow} attributes={1}>
        Judge Quality{mode && mode !== "consensus" ? ` (${mode} ELO)` : ""}
      </text>
      <text fg={palette.gray}>{headerStr}</text>
      <text fg={palette.gray}>{"\u2500".repeat(sepLen)}</text>
      {ratings.map((r, i) => {
        const ci95 = "ci95" in r ? (r as WhrRating).ci95 : undefined;
        const wlt = `${r.wins}/${r.losses}/${r.ties}`;
        const weight = weights?.[r.model] ?? 1.0;
        const isPruned = weight < (pruneThreshold ?? DEFAULT_CONVERGENCE.judgePruneThreshold);
        const ratingColor =
          i === 0 ? palette.green : i === ratings.length - 1 ? palette.red : palette.white;

        const selfBias = judgeBias?.selfPreference?.[r.model];
        const posBias = judgeBias?.positionBias?.[r.model];
        const selfFmt = selfBias
          ? formatBias(selfBias.biasDelta, selfBias.sufficient, selfBias.selfJudgmentCount > 0, palette)
          : { text: "n/a", color: palette.gray };
        const isWriter = selfBias != null;
        const posFmt = posBias
          ? formatBias(posBias.positionBiasDelta, posBias.sufficient, isWriter, palette)
          : { text: isWriter ? "..." : "n/a", color: palette.gray };

        return (
          <text key={r.model}>
            <span fg={palette.gray}>{String(i + 1).padEnd(rankW)}</span>
            <span>{r.model.padEnd(modelW + 2)}</span>
            <span fg={ratingColor}>{String(r.rating).padStart(ratingW)}</span>
            {hasCi && (
              <span fg={palette.gray}>{"  "}{(ci95 != null && ci95 !== Infinity ? `\u00b1${ci95}` : "-").padStart(ciW)}</span>
            )}
            <span>{"  "}{wlt.padStart(wltW)}</span>
            <span fg={palette.gray}>{"  "}{`${weight.toFixed(2)}x`.padStart(weightW)}</span>
            {hasBias && (
              <span fg={selfFmt.color}>{"  "}{selfFmt.text.padStart(selfW)}</span>
            )}
            {hasBias && (
              <span fg={posFmt.color}>{"  "}{posFmt.text.padStart(posW)}</span>
            )}
            <span fg={isPruned ? palette.red : palette.green}>{"  "}{(isPruned ? "pruned" : "active").padStart(statusW)}</span>
          </text>
        );
      })}
    </box>
  );
}
