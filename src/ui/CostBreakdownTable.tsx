import type { EloRating, ModelSpeed, TerminalPalette } from "../types.js";

const STAGE_COLS = [
  { key: "initial", label: "Write" },
  { key: "initialJudging", label: "Judge" },
  { key: "feedback", label: "Feedback" },
  { key: "revised", label: "Revise" },
  { key: "revisedJudging", label: "Re-Judge" },
] as const;

interface CostBreakdownTableProps {
  costByModelByStage: Record<string, Record<string, number>>;
  costByModel: Record<string, number>;
  speedByModel: Record<string, ModelSpeed>;
  eloInitial: EloRating[];
  eloRevised: EloRating[];
  palette: TerminalPalette;
}

function fmtCost(n: number): string {
  if (n === 0) return "-";
  return `$${n.toFixed(4)}`;
}

function fmtTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function computeAvgElo(
  model: string,
  initial: EloRating[],
  revised: EloRating[]
): number | null {
  const vals: number[] = [];
  const ini = initial.find((r) => r.model === model);
  if (ini) vals.push(ini.rating);
  const rev = revised.find((r) => r.model === model);
  if (rev) vals.push(rev.rating);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

export function CostBreakdownTable({
  costByModelByStage,
  costByModel,
  speedByModel,
  eloInitial,
  eloRevised,
  palette,
}: CostBreakdownTableProps) {
  const models = Object.keys(costByModel);
  if (models.length === 0) return null;

  // Determine which stages have any data
  const activeStages = STAGE_COLS.filter((s) =>
    models.some((m) => (costByModelByStage[m]?.[s.key] ?? 0) > 0)
  );

  if (activeStages.length === 0) return null;

  const hasElo = eloInitial.length > 0 || eloRevised.length > 0;

  const modelW = Math.max(5, ...models.map((m) => m.length));
  const colW = 9;
  const totalW = 9;
  const timeW = 9;
  const eloW = 7;
  const sep = "  ";

  const headerStr =
    "Model".padEnd(modelW) +
    activeStages.map((s) => sep + s.label.padStart(colW)).join("") +
    sep + "Total".padStart(totalW) +
    sep + "Avg Time".padStart(timeW) +
    (hasElo ? sep + "Avg ELO".padStart(eloW) : "");

  const sepLen =
    modelW +
    activeStages.length * (colW + sep.length) +
    sep.length + totalW +
    sep.length + timeW +
    (hasElo ? sep.length + eloW : 0);

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={palette.yellow} attributes={1}>Cost Breakdown</text>
      <text fg={palette.gray}>{headerStr}</text>
      <text fg={palette.gray}>{"\u2500".repeat(sepLen)}</text>
      {models.map((model) => {
        const stages = costByModelByStage[model] ?? {};
        const total = costByModel[model] ?? 0;
        const speed = speedByModel[model];
        const avgTime = speed ? fmtTime(speed.avgLatencyMs) : "-";
        const avgElo = computeAvgElo(model, eloInitial, eloRevised);

        const stageStr = activeStages.map((s) => {
          const cost = stages[s.key] ?? 0;
          return sep + fmtCost(cost).padStart(colW);
        }).join("");

        return (
          <text key={model}>
            <span>{model.padEnd(modelW)}</span>
            <span fg={palette.gray}>{stageStr}</span>
            <span fg={palette.green}>{sep}{fmtCost(total).padStart(totalW)}</span>
            <span fg={palette.cyan}>{sep}{avgTime.padStart(timeW)}</span>
            {hasElo && (
              <span fg={avgElo != null ? palette.white : palette.gray}>
                {sep}{(avgElo != null ? String(avgElo) : "-").padStart(eloW)}
              </span>
            )}
          </text>
        );
      })}
    </box>
  );
}
