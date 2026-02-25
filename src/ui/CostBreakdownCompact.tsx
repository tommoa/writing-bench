import type { EloRating, ModelSpeed } from "../types.js";
import type { Column } from "./Table.js";
import { Table } from "./Table.js";
import { computeAvgElo, fmtCost, fmtTime, truncate } from "./format-utils.js";
import { usePalette } from "./PaletteContext.js";

interface CostBreakdownCompactProps {
  costByModel: Record<string, number>;
  speedByModel: Record<string, ModelSpeed>;
  eloInitial: EloRating[];
  eloRevised: EloRating[];
  /** Maximum available width in columns. */
  maxWidth: number;
}

/** Compact cost breakdown for narrow containers (sidebar). */
export function CostBreakdownCompact({
  costByModel,
  speedByModel,
  eloInitial,
  eloRevised,
  maxWidth,
}: CostBreakdownCompactProps) {
  const palette = usePalette();

  const modelSet = new Set([
    ...Object.keys(costByModel),
    ...Object.keys(speedByModel),
    ...eloInitial.map((r) => r.model),
    ...eloRevised.map((r) => r.model),
  ]);
  const models = [...modelSet].sort();
  if (models.length === 0) return null;

  const hasElo = eloInitial.length > 0 || eloRevised.length > 0;
  const totalW = 9;
  const timeW = 8;
  const eloW = hasElo ? 7 : 0;
  const fixedCols = totalW + 2 + timeW + (hasElo ? 2 + eloW : 0);
  const modelW = Math.max(6, maxWidth - fixedCols - 2);

  const columns: Column<string>[] = [
    {
      header: "Model",
      width: modelW,
      value: (m) => truncate(m, modelW),
    },
    {
      header: "Total",
      width: totalW,
      align: "right",
      value: (m) => fmtCost(costByModel[m] ?? 0),
      color: () => palette.green,
    },
    {
      header: "Avg Time",
      width: timeW,
      align: "right",
      value: (m) => {
        const speed = speedByModel[m];
        return speed ? fmtTime(speed.avgLatencyMs) : "-";
      },
      color: () => palette.cyan,
    },
    {
      header: "Avg ELO",
      width: eloW,
      align: "right",
      when: hasElo,
      value: (m) => {
        const avg = computeAvgElo(m, eloInitial, eloRevised);
        return avg != null ? String(avg) : "-";
      },
      color: (m) => {
        const avg = computeAvgElo(m, eloInitial, eloRevised);
        return avg != null ? palette.white : palette.gray;
      },
    },
  ];

  return (
    <Table
      title="Cost Breakdown"
      data={models}
      columns={columns}
      keyFn={(m) => m}
    />
  );
}
