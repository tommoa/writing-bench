import type { EloRating, JudgeQualityMode, BenchmarkProgress, TerminalPalette } from "../types.js";
import { isWhrRating } from "../engine/whr.js";
import { DEFAULT_CONVERGENCE } from "../types.js";
import type { Column } from "./Table.js";
import { Table } from "./Table.js";
import { usePalette } from "./PaletteContext.js";

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

export function JudgeQualityTable({ ratings, weights, pruneThreshold, mode, judgeBias }: JudgeQualityTableProps) {
  const palette = usePalette();
  if (ratings.length === 0) return null;

  const hasCi = ratings.some(isWhrRating);
  const hasBias = judgeBias != null;
  const total = ratings.length;
  const threshold = pruneThreshold ?? DEFAULT_CONVERGENCE.judgePruneThreshold;

  const rankColor = (i: number) =>
    i === 0 ? palette.green : i === total - 1 ? palette.red : palette.white;

  const columns: Column<EloRating>[] = [
    {
      header: "#",
      width: 4,
      value: (_r, i) => String(i + 1),
      color: () => palette.gray,
    },
    {
      header: "Judge",
      computeWidth: (data) => Math.max(5, ...data.map((r) => r.model.length)),
      value: (r) => r.model,
    },
    {
      header: "Rating",
      width: 6,
      align: "right",
      value: (r) => String(r.rating),
      color: (_r, i) => rankColor(i),
    },
    {
      header: "\u00b1CI",
      width: 6,
      align: "right",
      when: hasCi,
      value: (r) => {
        const ci95 = isWhrRating(r) ? r.ci95 : undefined;
        return ci95 != null && ci95 !== Infinity ? `\u00b1${ci95}` : "-";
      },
      color: () => palette.gray,
    },
    {
      header: "W/L/T",
      computeWidth: (data) => Math.max(7, ...data.map((r) => `${r.wins}/${r.losses}/${r.ties}`.length)),
      align: "right",
      value: (r) => `${r.wins}/${r.losses}/${r.ties}`,
    },
    {
      header: "Weight",
      width: 7,
      align: "right",
      value: (r) => `${(weights?.[r.model] ?? 1.0).toFixed(2)}x`,
      color: () => palette.gray,
    },
    {
      header: "Self%",
      width: 7,
      align: "right",
      when: hasBias,
      value: (r) => {
        const selfBias = judgeBias?.selfPreference?.[r.model];
        if (!selfBias) return "n/a";
        return formatBias(selfBias.biasDelta, selfBias.sufficient, selfBias.selfJudgmentCount > 0, palette).text;
      },
      color: (r) => {
        const selfBias = judgeBias?.selfPreference?.[r.model];
        if (!selfBias) return palette.gray;
        return formatBias(selfBias.biasDelta, selfBias.sufficient, selfBias.selfJudgmentCount > 0, palette).color;
      },
    },
    {
      header: "Pos%",
      width: 7,
      align: "right",
      when: hasBias,
      value: (r) => {
        const selfBias = judgeBias?.selfPreference?.[r.model];
        const posBias = judgeBias?.positionBias?.[r.model];
        const isWriter = selfBias != null;
        if (!posBias) return isWriter ? "..." : "n/a";
        return formatBias(posBias.positionBiasDelta, posBias.sufficient, isWriter, palette).text;
      },
      color: (r) => {
        const selfBias = judgeBias?.selfPreference?.[r.model];
        const posBias = judgeBias?.positionBias?.[r.model];
        const isWriter = selfBias != null;
        if (!posBias) return palette.gray;
        return formatBias(posBias.positionBiasDelta, posBias.sufficient, isWriter, palette).color;
      },
    },
    {
      header: "Status",
      width: 7,
      align: "right",
      value: (r) => {
        const weight = weights?.[r.model] ?? 1.0;
        return weight < threshold ? "pruned" : "active";
      },
      color: (r) => {
        const weight = weights?.[r.model] ?? 1.0;
        return weight < threshold ? palette.red : palette.green;
      },
    },
  ];

  const titleStr = `Judge Quality${mode && mode !== "consensus" ? ` (${mode} ELO)` : ""}`;

  return (
    <Table
      title={titleStr}
      data={ratings}
      columns={columns}
      keyFn={(r) => r.model}
    />
  );
}
