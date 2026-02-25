import type { CacheSavings } from "../types.js";
import { STAGE_COLS, truncate } from "./format-utils.js";
import { usePalette } from "./PaletteContext.js";

// ── Constants ────────────────────────────────────────

const STAGE_COST_LABELS: Record<string, string> = Object.fromEntries(
  STAGE_COLS.map(({ key, label }) => [key, label]),
);

// ── Component ────────────────────────────────────────

interface CostSummaryProps {
  totalCost: number;
  totalCostUncached: number;
  costByStage: Record<string, number>;
  cacheSavings: CacheSavings;
  maxWidth: number;
}

export function CostSummary({
  totalCost,
  totalCostUncached,
  costByStage,
  cacheSavings,
  maxWidth,
}: CostSummaryProps) {
  const palette = usePalette();
  const cacheSaved = totalCostUncached - totalCost;
  const showUncached = cacheSaved > 0.00005;

  const totalCached =
    cacheSavings.writes.cached +
    cacheSavings.feedback.cached +
    cacheSavings.revisions.cached +
    cacheSavings.judgments.cached;
  const totalFresh =
    cacheSavings.writes.fresh +
    cacheSavings.feedback.fresh +
    cacheSavings.revisions.fresh +
    cacheSavings.judgments.fresh;
  const totalSavedCost =
    cacheSavings.writes.savedCost +
    cacheSavings.feedback.savedCost +
    cacheSavings.revisions.savedCost +
    cacheSavings.judgments.savedCost;
  const hasCacheActivity = totalCached > 0 || totalFresh > 0;

  const stageEntries = Object.entries(costByStage)
    .filter(([, cost]) => cost > 0)
    .map(([key, cost]) => ({
      label: STAGE_COST_LABELS[key] ?? key,
      cost,
    }));

  // Nothing to show yet
  if (totalCost === 0 && !hasCacheActivity) return null;

  const lines: Array<{ text: string; color: string }> = [];

  // Total cost line
  let costLine = `Total: $${totalCost.toFixed(4)}`;
  if (showUncached) costLine += `  (uncached: $${totalCostUncached.toFixed(4)})`;
  lines.push({ text: truncate(costLine, maxWidth), color: palette.green });

  // Stage cost breakdown
  if (stageEntries.length > 0) {
    const parts = stageEntries.map(({ label, cost }) => `${label}: $${cost.toFixed(4)}`);
    lines.push({ text: truncate(parts.join("  "), maxWidth), color: palette.gray });
  }

  // Fresh counts
  if (totalFresh > 0 && hasCacheActivity) {
    const { writes, feedback, revisions, judgments } = cacheSavings;
    lines.push({
      text: `Fresh: ${writes.fresh}w ${feedback.fresh}fb ${revisions.fresh}rev ${judgments.fresh}j`,
      color: palette.gray,
    });
  }

  // Cached counts + saved cost
  if (totalCached > 0) {
    const { writes, feedback, revisions, judgments } = cacheSavings;
    lines.push({
      text: truncate(
        `Cached: ${writes.cached}w ${feedback.cached}fb ${revisions.cached}rev ${judgments.cached}j (saved ~$${totalSavedCost.toFixed(4)})`,
        maxWidth,
      ),
      color: palette.cyan,
    });
  }

  return (
    <box flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => (
        <box key={i}>
          <text fg={line.color}>{line.text}</text>
        </box>
      ))}
    </box>
  );
}
