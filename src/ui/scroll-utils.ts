import type { ScrollBoxRenderable } from "@opentui/core";

const DEFAULT_TABLE_HEADER_ROWS = 2;

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
