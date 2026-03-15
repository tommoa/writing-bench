import type { ScrollBoxRenderable } from "@opentui/core";

const DEFAULT_TABLE_HEADER_ROWS = 2;
const DEFAULT_SCROLL_MARGIN = 2;

interface MinimalScrollBox {
  scrollTo: (row: number) => void;
  scrollTop: number;
}

/** Scroll a table row into view inside a scrollbox. */
export function scrollToTableCursor(
  scrollBox: Pick<ScrollBoxRenderable, "scrollTo"> | null,
  cursorIndex: number,
  headerRows: number = DEFAULT_TABLE_HEADER_ROWS,
): void {
  if (!scrollBox || cursorIndex < 0) {
    return;
  }
  scrollBox.scrollTo(headerRows + cursorIndex);
}

/** Keep a table cursor visible with minimal scroll movement. */
export function keepTableCursorVisible(
  scrollBox: MinimalScrollBox | null,
  cursorIndex: number,
  viewportRows: number,
  headerRows: number = DEFAULT_TABLE_HEADER_ROWS,
  marginRows: number = DEFAULT_SCROLL_MARGIN,
): void {
  if (!scrollBox || cursorIndex < 0 || viewportRows <= 0) {
    return;
  }

  const targetRow = headerRows + cursorIndex;
  const margin = Math.max(0, Math.min(marginRows, Math.floor(viewportRows / 2)));
  const top = scrollBox.scrollTop;
  const bottomExclusive = top + viewportRows;

  if (targetRow < top + margin) {
    scrollBox.scrollTo(Math.max(0, targetRow - margin));
    return;
  }

  if (targetRow >= bottomExclusive - margin) {
    scrollBox.scrollTo(Math.max(0, targetRow - viewportRows + margin + 1));
  }
}
