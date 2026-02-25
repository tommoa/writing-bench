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
  /** Compute minimum width dynamically from the full data set. */
  computeWidth?: (data: T[]) => number;
  /** Return the cell content as a plain string. */
  value: (row: T, index: number) => string;
  /** Return a color string for the cell (undefined = inherit). */
  color?: (row: T, index: number) => string | undefined;
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
): TableLayout<T> {
  const active = columns.filter((c) => c.when !== false);

  const widths = active.map((col) => {
    const headerW = col.header.length;
    const minW = col.width ?? 0;
    const dataW = col.computeWidth ? col.computeWidth(data) : 0;
    return Math.max(headerW, minW, dataW);
  });

  const headerStr = active
    .map((col, i) => {
      const w = widths[i];
      return col.align === "right"
        ? col.header.padStart(w)
        : col.header.padEnd(w);
    })
    .join(gap);

  const sepLen =
    widths.reduce((sum, w) => sum + w, 0) +
    (active.length - 1) * gap.length;

  function formatRow(row: T, index: number): CellData[] {
    return active.map((col, i) => {
      const raw = col.value(row, index);
      const w = widths[i];
      const text =
        col.align === "right" ? raw.padStart(w) : raw.padEnd(w);
      const color = col.color?.(row, index);
      return { text, color };
    });
  }

  return { headerStr, sepLen, gap, formatRow };
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
  keyFn,
  rowFg,
  marginBottom = 1,
  children,
}: TableProps<T>) {
  const palette = usePalette();
  const layout = computeTableLayout(columns, data, gap);

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
