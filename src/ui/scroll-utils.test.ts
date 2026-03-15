import { describe, expect, it } from "bun:test";
import { scrollToTableCursor, keepTableCursorVisible } from "./scroll-utils.js";

describe("scrollToTableCursor", () => {
  it("scrolls to cursor row offset by header rows", () => {
    const calls: number[] = [];
    const scrollBox = {
      scrollTo: (row: number) => {
        calls.push(row);
      },
    };

    scrollToTableCursor(scrollBox, 5);

    expect(calls).toEqual([7]);
  });

  it("uses custom header row count", () => {
    const calls: number[] = [];
    const scrollBox = {
      scrollTo: (row: number) => {
        calls.push(row);
      },
    };

    scrollToTableCursor(scrollBox, 3, 1);

    expect(calls).toEqual([4]);
  });

  it("does nothing for negative cursor", () => {
    const calls: number[] = [];
    const scrollBox = {
      scrollTo: (row: number) => {
        calls.push(row);
      },
    };

    scrollToTableCursor(scrollBox, -1);

    expect(calls).toEqual([]);
  });
});

describe("keepTableCursorVisible", () => {
  it("does not scroll when cursor is already visible", () => {
    const calls: number[] = [];
    const scrollBox = {
      scrollTop: 0,
      scrollTo: (row: number) => {
        calls.push(row);
      },
    };

    keepTableCursorVisible(scrollBox, 3, 12);

    expect(calls).toEqual([]);
  });

  it("scrolls up when cursor is above visible margin", () => {
    const calls: number[] = [];
    const scrollBox = {
      scrollTop: 10,
      scrollTo: (row: number) => {
        calls.push(row);
      },
    };

    keepTableCursorVisible(scrollBox, 0, 8);

    expect(calls).toEqual([0]);
  });

  it("scrolls down only when cursor nears bottom margin", () => {
    const calls: number[] = [];
    const scrollBox = {
      scrollTop: 0,
      scrollTo: (row: number) => {
        calls.push(row);
      },
    };

    keepTableCursorVisible(scrollBox, 10, 8);

    expect(calls).toEqual([7]);
  });
});
