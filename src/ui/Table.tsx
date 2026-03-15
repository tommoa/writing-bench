import type { ReactNode } from "react";
import { usePalette } from "./PaletteContext.js";

// ── Column / Layout Types ──────────────────────────

/** Column definition for a data table. */
export interface Column<T> {
  /** Header label displayed at the top of the column. */
  header: string;
  /** Text alignment within the column (default "left"). */
  align?: "left" | "right";
  /** Minimum column width (header length is also considered). */
  width?: number;
  /** Smallest width allowed when shrinking to fit a max table width. */
  minWidth?: number;
  /** Compute minimum width dynamically from the full data set. */
  computeWidth?: (data: T[]) => number;
  /** Return the cell content as a plain string. */
  value: (row: T, index: number) => string;
  /** Return a color string for the cell (undefined = inherit). */
  color?: (row: T, index: number) => string | undefined;
  /** Allow this column to shrink and truncate when maxWidth is set. */
  truncate?: boolean;
  /** When false, the column is hidden. Default true. */
  when?: boolean;
}

/** A single formatted cell ready for rendering. */
export interface CellData {
  /** Padded cell text. */
  text: string;
  /** Optional foreground color (hex string). */
  color?: string;
}

/** Pre-computed layout for a set of columns and data. */
export interface TableLayout<T> {
  /** Formatted header string. */
  headerStr: string;
  /** Total separator width in characters. */
  sepLen: number;
  /** Gap string between columns. */
  gap: string;
  /** Format a single data row into an array of cells. */
  formatRow: (row: T, index: number) => CellData[];
}

// ── Pure Layout Computation ────────────────────────

/** Resolve column definitions against data to produce a reusable layout. */
export function computeTableLayout<T>(
  columns: Column<T>[],
  data: T[],
  gap: string = "  ",
  maxWidth?: number,
): TableLayout<T> {
  const active = columns.filter((c) => c.when !== false);

  const desiredWidths = active.map((col) => {
    const headerW = col.header.length;
    const minW = col.width ?? 0;
    const dataW = col.computeWidth ? col.computeWidth(data) : 0;
    return Math.max(headerW, minW, dataW);
  });

  const shrinkable = active.map((col, i) => col.truncate ? i : -1).filter((i) => i >= 0);
  const gapOptions = [...new Set([gap, " ", ""])] ;

  let widths = [...desiredWidths];
  let resolvedGap = gap;

  for (const gapCandidate of gapOptions) {
    const candidateWidths = [...desiredWidths];
    shrinkWidthsToFit(active, candidateWidths, gapCandidate.length, maxWidth, shrinkable);
    const candidateSepLen = candidateWidths.reduce((sum, w) => sum + w, 0)
      + (active.length - 1) * gapCandidate.length;

    widths = candidateWidths;
    resolvedGap = gapCandidate;
    if (maxWidth == null || candidateSepLen <= maxWidth) {
      break;
    }
  }

  const headerStr = active
    .map((col, i) => {
      const w = widths[i];
      const header = formatCellText(col.header, w);
      return col.align === "right"
        ? header.padStart(w)
        : header.padEnd(w);
    })
    .join(resolvedGap);

  const sepLen =
    widths.reduce((sum, w) => sum + w, 0) +
    (active.length - 1) * resolvedGap.length;

  function formatRow(row: T, index: number): CellData[] {
    return active.map((col, i) => {
      const raw = formatCellText(col.value(row, index), widths[i]);
      const w = widths[i];
      const text =
        col.align === "right" ? raw.padStart(w) : raw.padEnd(w);
      const color = col.color?.(row, index);
      return { text, color };
    });
  }

  return { headerStr, sepLen, gap: resolvedGap, formatRow };
}

function shrinkWidthsToFit<T>(
  columns: Column<T>[],
  widths: number[],
  gapLength: number,
  maxWidth: number | undefined,
  shrinkable: number[],
): void {
  if (maxWidth == null || !Number.isFinite(maxWidth) || shrinkable.length === 0) {
    return;
  }

  const minWidths = columns.map((col, i) => {
    const headerFloor = col.truncate ? 1 : col.header.length;
    return Math.max(col.minWidth ?? 0, Math.min(widths[i], headerFloor));
  });

  while (true) {
    const total = widths.reduce((sum, w) => sum + w, 0) + (columns.length - 1) * gapLength;
    if (total <= maxWidth) {
      return;
    }

    let widestIndex = -1;
    let widestWidth = -1;
    for (const index of shrinkable) {
      if (widths[index] > minWidths[index] && widths[index] > widestWidth) {
        widestWidth = widths[index];
        widestIndex = index;
      }
    }

    if (widestIndex < 0) {
      return;
    }

    widths[widestIndex] -= 1;
  }
}

function formatCellText(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return value.slice(0, width - 3) + "...";
}

// ── React Component ────────────────────────────────

interface TableProps<T> {
  /** Bold title rendered above the header row. */
  title?: string;
  /** Title color (defaults to palette.yellow). */
  titleColor?: string;
  /** Data rows. */
  data: T[];
  /** Column definitions. */
  columns: Column<T>[];
  /** Gap string between columns (default "  "). */
  gap?: string;
  /** Maximum rendered table width in columns. */
  maxWidth?: number;
  /** Produce a unique React key for each data row. */
  keyFn: (row: T, index: number) => string;
  /** Optional default foreground color for a row. */
  rowFg?: (row: T, index: number) => string | undefined;
  /** Bottom margin (default 1). */
  marginBottom?: number;
  /** Extra content rendered after data rows (e.g. footer). */
  children?: ReactNode;
}

/** Declarative data table for the terminal UI. */
export function Table<T>({
  title,
  titleColor,
  data,
  columns,
  gap = "  ",
  maxWidth,
  keyFn,
  rowFg,
  marginBottom = 1,
  children,
}: TableProps<T>) {
  const palette = usePalette();
  const layout = computeTableLayout(columns, data, gap, maxWidth);

  return (
    <box flexDirection="column" marginBottom={marginBottom}>
      {title && (
        <box>
          <text fg={titleColor ?? palette.yellow} attributes={1}>
            {title}
          </text>
        </box>
      )}
      <box>
        <text fg={palette.gray}>{layout.headerStr}</text>
      </box>
      <box>
        <text fg={palette.gray}>{"\u2500".repeat(layout.sepLen)}</text>
      </box>
      {data.map((row, i) => {
        const cells = layout.formatRow(row, i);
        return (
          <box key={keyFn(row, i)}>
            <text fg={rowFg?.(row, i)}>
              {cells.map((cell, ci) => (
                <span key={ci} fg={cell.color}>
                  {ci > 0 ? layout.gap : ""}
                  {cell.text}
                </span>
              ))}
            </text>
          </box>
        );
      })}
      {children && (
        <box flexDirection="column">
          {children}
        </box>
      )}
    </box>
  );
}
