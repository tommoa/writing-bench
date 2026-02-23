import type { EloRating, ModelSpeed, RunResult, TerminalPalette } from "../types.js";

// ── ANSI Helpers ─────────────────────────────────────

/** Convert a hex color (#RRGGBB) to a truecolor ANSI foreground escape. */
function fg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/** Write a line directly to stdout, bypassing any console interception. */
function writeln(s: string): void {
  process.stdout.write(s + "\n");
}

// ── Formatters ───────────────────────────────────────

function fmtCost(n: number): string {
  if (n === 0) return "-";
  return `$${n.toFixed(4)}`;
}

function fmtTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── ELO Table ────────────────────────────────────────

/**
 * Print an ELO leaderboard table to stdout with palette colors.
 * Matches the format used by the TUI's EloTable component.
 */
function printEloTable(
  title: string,
  ratings: EloRating[],
  palette: TerminalPalette,
): void {
  if (ratings.length === 0) return;

  const hasCi = ratings.some((r) => "ci95" in r && typeof (r as any).ci95 === "number");

  // Column widths
  const rankW = 4;
  const modelW = Math.max(5, ...ratings.map((r) => r.model.length));
  const ratingW = 6;
  const ciW = 6;
  const wltW = 11;

  const headerStr =
    "#".padEnd(rankW) +
    "Model".padEnd(modelW + 2) +
    "ELO".padStart(ratingW) +
    (hasCi ? `  ${"\u00b1CI".padStart(ciW)}` : "") +
    "  " + "W/L/T".padStart(wltW);

  const sepLen =
    rankW + modelW + 2 + ratingW
    + (hasCi ? 2 + ciW : 0)
    + 2 + wltW;

  writeln(`${BOLD}${fg(palette.yellow)}${title}${RESET}`);
  writeln(`${fg(palette.gray)}${headerStr}${RESET}`);
  writeln(`${fg(palette.gray)}${"\u2500".repeat(sepLen)}${RESET}`);

  for (let i = 0; i < ratings.length; i++) {
    const r = ratings[i];
    const wlt = `${r.wins}/${r.losses}/${r.ties}`;
    const ci95 = "ci95" in r ? (r as any).ci95 as number : undefined;

    const ratingColor =
      i === 0 ? palette.green : i === ratings.length - 1 ? palette.red : palette.white;

    const line =
      String(i + 1).padEnd(rankW) +
      r.model.padEnd(modelW + 2);

    const ratingStr = String(r.rating).padStart(ratingW);
    const ciStr = hasCi ? "  " + (ci95 != null ? `\u00b1${ci95}` : "-").padStart(ciW) : "";
    const wltStr = "  " + wlt.padStart(wltW);

    writeln(
      `${fg(palette.gray)}${line}${RESET}` +
      `${fg(ratingColor)}${ratingStr}${RESET}` +
      `${fg(palette.gray)}${ciStr}${wltStr}${RESET}`
    );
  }

  writeln("");
}

// ── Cost Breakdown Table ─────────────────────────────

const STAGE_COLS = [
  { key: "initial", label: "Write" },
  { key: "initialJudging", label: "Judge" },
  { key: "feedback", label: "Feedback" },
  { key: "revised", label: "Revise" },
  { key: "revisedJudging", label: "Re-Judge" },
] as const;

function computeAvgElo(
  model: string,
  initial: EloRating[],
  revised: EloRating[],
): number | null {
  const vals: number[] = [];
  const ini = initial.find((r) => r.model === model);
  if (ini) vals.push(ini.rating);
  const rev = revised.find((r) => r.model === model);
  if (rev) vals.push(rev.rating);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function printCostTable(
  result: RunResult,
  palette: TerminalPalette,
): void {
  const models = Object.keys(result.meta.costByModel);
  if (models.length === 0) return;

  const costByModelByStage = result.meta.costByModelByStage;
  const activeStages = STAGE_COLS.filter((s) =>
    models.some((m) => (costByModelByStage[m]?.[s.key] ?? 0) > 0)
  );
  if (activeStages.length === 0) return;

  const hasElo = result.elo.initial.ratings.length > 0 || result.elo.revised.ratings.length > 0;

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

  writeln(`${BOLD}${fg(palette.yellow)}Cost Breakdown${RESET}`);
  writeln(`${fg(palette.gray)}${headerStr}${RESET}`);
  writeln(`${fg(palette.gray)}${"\u2500".repeat(sepLen)}${RESET}`);

  for (const model of models) {
    const stages = costByModelByStage[model] ?? {};
    const total = result.meta.costByModel[model] ?? 0;
    const speed = result.meta.speedByModel[model];
    const avgTime = speed ? fmtTime(speed.avgLatencyMs) : "-";
    const avgElo = computeAvgElo(model, result.elo.initial.ratings, result.elo.revised.ratings);

    const stageStr = activeStages.map((s) => {
      const cost = stages[s.key] ?? 0;
      return sep + fmtCost(cost).padStart(colW);
    }).join("");

    const eloStr = hasElo
      ? `${fg(avgElo != null ? palette.white : palette.gray)}${sep}${(avgElo != null ? String(avgElo) : "-").padStart(eloW)}${RESET}`
      : "";

    writeln(
      `${model.padEnd(modelW)}` +
      `${fg(palette.gray)}${stageStr}${RESET}` +
      `${fg(palette.green)}${sep}${fmtCost(total).padStart(totalW)}${RESET}` +
      `${fg(palette.cyan)}${sep}${avgTime.padStart(timeW)}${RESET}` +
      eloStr
    );
  }

  writeln("");
}

// ── Public API ───────────────────────────────────────

/**
 * Print the final tables from a completed run to stdout.
 * Called after the OpenTUI renderer exits alt screen, so these
 * persist in the user's terminal scrollback.
 */
export function printFinalTables(
  result: RunResult,
  palette: TerminalPalette,
): void {
  writeln("");

  if (result.elo.initial.ratings.length > 0) {
    printEloTable("Writer ELO (Initial)", result.elo.initial.ratings, palette);
  }

  if (result.elo.revised.ratings.length > 0) {
    printEloTable("Writer ELO (Revised)", result.elo.revised.ratings, palette);
  }

  if (result.elo.revised.feedbackRatings && result.elo.revised.feedbackRatings.length > 0) {
    printEloTable("Feedback Provider ELO", result.elo.revised.feedbackRatings, palette);
  }

  printCostTable(result, palette);
}
