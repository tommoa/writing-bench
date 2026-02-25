import type { EloRating, ModelSpeed } from "../types.js";
import { estimateRemainingJudgments, isWhrRating, overlapFreeThreshold } from "../engine/whr.js";
import type { WhrRating } from "../engine/whr.js";
import type { Column } from "./Table.js";
import { Table } from "./Table.js";
import { fmtCost, fmtTime } from "./format-utils.js";
import { usePalette } from "./PaletteContext.js";

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
  const palette = usePalette();
  if (ratings.length === 0) return null;

  const hasCi = ratings.some(isWhrRating);
  const showCost = !!costByModel;
  const showTime = !!avgTimeByModel;
  const showSpeed = speedByModel && Object.keys(speedByModel).length > 0;
  const showEst = hasCi && ciThreshold != null;
  const whrRatings = hasCi ? ratings as WhrRating[] : undefined;
  const total = ratings.length;

  const rankColor = (i: number) =>
    i === 0 ? palette.green : i === total - 1 ? palette.red : palette.white;

  const estimates = new Map(
    showEst
      ? ratings.map((r) => {
          const ci95 = isWhrRating(r) ? r.ci95 : undefined;
          const est = estimateRemainingJudgments(
            ci95 ?? Infinity,
            r.matchCount,
            ciThreshold!,
            whrRatings ? overlapFreeThreshold(r as WhrRating, whrRatings) : undefined,
          );
          return [r.model, est] as const;
        })
      : [],
  );

  const columns: Column<EloRating>[] = [
    {
      header: "#",
      width: 4,
      value: (_r, i) => String(i + 1),
      color: () => palette.gray,
    },
    {
      header: "Model",
      computeWidth: (data) => Math.max(5, ...data.map((r) => r.model.length)),
      value: (r) => r.model,
      color: () => palette.gray,
    },
    {
      header: "ELO",
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
      value: (r) => isWhrRating(r) ? `\u00b1${r.ci95}` : "-",
      color: () => palette.gray,
    },
    {
      header: "W/L/T",
      width: 11,
      align: "right",
      value: (r) => `${r.wins}/${r.losses}/${r.ties}`,
      color: () => palette.gray,
    },
    {
      header: "Cost",
      width: 8,
      align: "right",
      when: showCost,
      value: (r) => fmtCost(costByModel?.[r.model] ?? 0),
      color: () => palette.gray,
    },
    {
      header: "Avg Time",
      width: 9,
      align: "right",
      when: showTime,
      value: (r) => {
        const time = avgTimeByModel?.[r.model];
        return time != null ? fmtTime(time) : "-";
      },
      color: () => palette.cyan,
    },
    {
      header: "Speed",
      width: 12,
      align: "right",
      when: !!showSpeed,
      value: (r) => {
        const speed = speedByModel?.[r.model];
        return speed ? fmtSpeed(speed.tokensPerSecond) : "-";
      },
      color: () => palette.cyan,
    },
    {
      header: "Est.",
      width: 5,
      align: "right",
      when: showEst,
      value: (r) => {
        const est = estimates.get(r.model);
        if (est === 0) return "\u2713";
        if (est != null && est <= 9999) return String(est);
        return "?";
      },
      color: (r) => {
        const est = estimates.get(r.model);
        return est === 0 ? palette.green
          : est != null && est <= 5 ? palette.yellow
          : palette.gray;
      },
    },
  ];

  return (
    <Table
      title={title}
      data={ratings}
      columns={columns}
      keyFn={(r) => r.model}
    />
  );
}
