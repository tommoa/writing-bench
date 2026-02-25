import type { EloRating, RunResult, TerminalPalette } from "../types.js";
import { isWhrRating } from "../engine/whr.js";
import type { CellData, Column } from "./Table.js";
import { computeTableLayout } from "./Table.js";
import { fmtCost, fmtTime, computeAvgElo, STAGE_COLS } from "./format-utils.js";

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

/** Render a row of CellData as an ANSI-colored string. */
function formatAnsiRow(cells: CellData[], gap: string): string {
  return cells
    .map((cell, i) => {
      const gapStr = i > 0 ? gap : "";
      if (cell.color) return `${gapStr}${fg(cell.color)}${cell.text}${RESET}`;
      return `${gapStr}${cell.text}`;
    })
    .join("");
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

  const total = ratings.length;
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
      color: (_r, i) =>
        i === 0 ? palette.green : i === total - 1 ? palette.red : palette.white,
    },
    {
      header: "\u00b1CI",
      width: 6,
      align: "right",
      when: ratings.some(isWhrRating),
      value: (r) => (isWhrRating(r) ? `\u00b1${r.ci95}` : "-"),
      color: () => palette.gray,
    },
    {
      header: "W/L/T",
      width: 11,
      align: "right",
      value: (r) => `${r.wins}/${r.losses}/${r.ties}`,
      color: () => palette.gray,
    },
  ];

  const layout = computeTableLayout(columns, ratings);

  writeln(`${BOLD}${fg(palette.yellow)}${title}${RESET}`);
  writeln(`${fg(palette.gray)}${layout.headerStr}${RESET}`);
  writeln(`${fg(palette.gray)}${"\u2500".repeat(layout.sepLen)}${RESET}`);

  for (let i = 0; i < ratings.length; i++) {
    writeln(formatAnsiRow(layout.formatRow(ratings[i], i), layout.gap));
  }

  writeln("");
}

/** Print a plain (non-ANSI) ELO table for CLI commands. */
export function printEloTablePlain(title: string, ratings: EloRating[]): void {
  if (ratings.length === 0) {
    return;
  }

  const columns: Column<EloRating>[] = [
    {
      header: "#",
      width: 4,
      value: (_r, i) => String(i + 1),
    },
    {
      header: "Model",
      width: 25,
      value: (r) => r.model,
    },
    {
      header: "ELO",
      width: 6,
      align: "right",
      value: (r) => String(r.rating),
    },
    {
      header: "W/L/T",
      width: 11,
      align: "right",
      value: (r) => `${r.wins}/${r.losses}/${r.ties}`,
    },
  ];

  const layout = computeTableLayout(columns, ratings);
  writeln(`\n${title}`);
  writeln("-".repeat(layout.sepLen));
  writeln(layout.headerStr);
  writeln("-".repeat(layout.sepLen));
  for (let i = 0; i < ratings.length; i++) {
    writeln(layout.formatRow(ratings[i], i).map((cell, index) => `${index > 0 ? layout.gap : ""}${cell.text}`).join(""));
  }
}

// ── Cost Breakdown Table ─────────────────────────────

function printCostTable(
  result: RunResult,
  palette: TerminalPalette,
): void {
  const { costByModelByStage, costByModel, speedByModel } = result.meta;
  const { initial, revised } = result.elo;

  const modelSet = new Set([
    ...Object.keys(costByModel),
    ...Object.keys(speedByModel),
    ...initial.ratings.map((r) => r.model),
    ...revised.ratings.map((r) => r.model),
  ]);
  const models = [...modelSet].sort();
  if (models.length === 0) return;

  const activeStages = STAGE_COLS.filter((s) =>
    models.some((m) => (costByModelByStage[m]?.[s.key] ?? 0) > 0),
  );
  if (activeStages.length === 0) return;

  const hasElo = initial.ratings.length > 0 || revised.ratings.length > 0;

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
        const avg = computeAvgElo(m, initial.ratings, revised.ratings);
        return avg != null ? String(avg) : "-";
      },
      color: (m) => {
        const avg = computeAvgElo(m, initial.ratings, revised.ratings);
        return avg != null ? palette.white : palette.gray;
      },
    },
  ];

  const layout = computeTableLayout(columns, models);

  writeln(`${BOLD}${fg(palette.yellow)}Cost Breakdown${RESET}`);
  writeln(`${fg(palette.gray)}${layout.headerStr}${RESET}`);
  writeln(`${fg(palette.gray)}${"\u2500".repeat(layout.sepLen)}${RESET}`);

  for (const model of models) {
    writeln(formatAnsiRow(layout.formatRow(model, 0), layout.gap));
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
