import { describe, expect, it } from "bun:test";
import { scrollToTableCursor } from "./scroll-utils.js";

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
