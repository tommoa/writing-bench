import type { EloRating, ModelSpeed } from "../types.js";
import type { Column } from "./Table.js";
import { Table } from "./Table.js";
import { computeAvgElo, fmtCost, fmtTime, STAGE_COLS } from "./format-utils.js";
import { usePalette } from "./PaletteContext.js";

interface CostBreakdownTableProps {
  costByModelByStage: Record<string, Record<string, number>>;
  costByModel: Record<string, number>;
  speedByModel: Record<string, ModelSpeed>;
  eloInitial: EloRating[];
  eloRevised: EloRating[];
}

/** Full-width cost breakdown with per-stage columns. */
export function CostBreakdownTable({
  costByModelByStage,
  costByModel,
  speedByModel,
  eloInitial,
  eloRevised,
}: CostBreakdownTableProps) {
  const palette = usePalette();

  const modelSet = new Set([
    ...Object.keys(costByModel),
    ...Object.keys(speedByModel),
    ...eloInitial.map((r) => r.model),
    ...eloRevised.map((r) => r.model),
  ]);
  const models = [...modelSet].sort();
  if (models.length === 0) return null;

  const activeStages = STAGE_COLS.filter((s) =>
    models.some((m) => (costByModelByStage[m]?.[s.key] ?? 0) > 0),
  );
  if (activeStages.length === 0) return null;

  const hasElo = eloInitial.length > 0 || eloRevised.length > 0;

  const columns: Column<string>[] = [
    {
      header: "Model",
      computeWidth: (data) => Math.max(5, ...data.map((m) => m.length)),
      value: (m) => m,
    },
    ...activeStages.map(
      (s): Column<string> => ({
        header: s.label,
        width: 9,
        align: "right",
        value: (m) => fmtCost(costByModelByStage[m]?.[s.key] ?? 0),
        color: () => palette.gray,
      }),
    ),
    {
      header: "Total",
      width: 9,
      align: "right",
      value: (m) => fmtCost(costByModel[m] ?? 0),
      color: () => palette.green,
    },
    {
      header: "Avg Time",
      width: 9,
      align: "right",
      value: (m) => {
        const speed = speedByModel[m];
        return speed ? fmtTime(speed.avgLatencyMs) : "-";
      },
      color: () => palette.cyan,
    },
    {
      header: "Avg ELO",
      width: 7,
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
