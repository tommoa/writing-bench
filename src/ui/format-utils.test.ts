import { describe, it, expect } from "bun:test";
import type { EloRating } from "../types.js";
import { fmtCost, fmtTime, computeAvgElo } from "./format-utils.js";
import { computeTableLayout } from "./Table.js";
import type { Column } from "./Table.js";

// ── Helpers ──────────────────────────────────────────

function makeRating(
  model: string,
  rating: number,
  wins = 3,
  losses = 2,
  ties = 1,
  ci95?: number,
): EloRating {
  const r: EloRating = { model, rating, wins, losses, ties, matchCount: wins + losses + ties };
  if (ci95 != null) (r as any).ci95 = ci95;
  return r;
}

// ── fmtCost ──────────────────────────────────────────

describe("fmtCost", () => {
  it("returns dash for zero", () => {
    expect(fmtCost(0)).toBe("-");
  });

  it("formats non-zero cost with 4 decimals", () => {
    expect(fmtCost(1.5)).toBe("$1.5000");
    expect(fmtCost(0.0001)).toBe("$0.0001");
  });
});

// ── fmtTime ──────────────────────────────────────────

describe("fmtTime", () => {
  it("formats sub-second as milliseconds", () => {
    expect(fmtTime(450)).toBe("450ms");
  });

  it("formats seconds with one decimal", () => {
    expect(fmtTime(2500)).toBe("2.5s");
  });
});

// ── computeAvgElo ────────────────────────────────────

describe("computeAvgElo", () => {
  it("returns null when model has no ratings", () => {
    expect(computeAvgElo("missing", [], [])).toBeNull();
  });

  it("returns the rating when only in one list", () => {
    const initial = [makeRating("a", 1200)];
    expect(computeAvgElo("a", initial, [])).toBe(1200);
  });

  it("averages initial and revised", () => {
    const initial = [makeRating("a", 1200)];
    const revised = [makeRating("a", 1400)];
    expect(computeAvgElo("a", initial, revised)).toBe(1300);
  });
});

// ── computeTableLayout ──────────────────────────────

describe("computeTableLayout", () => {
  it("computes header from column definitions", () => {
    const columns: Column<{ name: string; value: number }>[] = [
      { header: "Name", width: 10, value: (r) => r.name },
      { header: "Value", width: 8, align: "right", value: (r) => String(r.value) },
    ];
    const data = [
      { name: "alpha", value: 42 },
      { name: "beta", value: 7 },
    ];
    const layout = computeTableLayout(columns, data);

    // "Name" padEnd(10) + "  " gap + "Value" padStart(8) = 20 chars
    expect(layout.headerStr).toBe("Name        " + "   Value");
    expect(layout.sepLen).toBe(layout.headerStr.length);
  });

  it("filters columns with when=false", () => {
    const columns: Column<{ a: string; b: string }>[] = [
      { header: "A", width: 4, value: (r) => r.a },
      { header: "B", width: 4, value: (r) => r.b, when: false },
    ];
    const layout = computeTableLayout(columns, [{ a: "x", b: "y" }]);

    expect(layout.headerStr).toBe("A   ");
    expect(layout.sepLen).toBe(4);
  });

  it("uses computeWidth to adapt to data", () => {
    const columns: Column<string>[] = [
      {
        header: "Name",
        computeWidth: (data) => Math.max(...data.map((s) => s.length)),
        value: (s) => s,
      },
    ];
    const data = ["short", "a-very-long-name"];
    const layout = computeTableLayout(columns, data);

    // Width should be max(header=4, computeWidth=16) = 16
    const cells = layout.formatRow(data[0], 0);
    expect(cells[0].text).toBe("short           "); // padEnd(16)
  });

  it("right-aligns columns", () => {
    const columns: Column<number>[] = [
      { header: "Val", width: 6, align: "right", value: (n) => String(n) },
    ];
    const layout = computeTableLayout(columns, [42]);
    const cells = layout.formatRow(42, 0);

    expect(cells[0].text).toBe("    42"); // padStart(6)
  });

  it("passes color through to cells", () => {
    const columns: Column<string>[] = [
      { header: "X", width: 4, value: (s) => s, color: () => "#FF0000" },
    ];
    const layout = computeTableLayout(columns, ["hi"]);
    const cells = layout.formatRow("hi", 0);

    expect(cells[0].color).toBe("#FF0000");
  });

  it("separator length equals sum of widths plus gaps", () => {
    const columns: Column<string>[] = [
      { header: "A", width: 5, value: (s) => s },
      { header: "B", width: 5, value: (s) => s },
      { header: "C", width: 5, value: (s) => s },
    ];
    const layout = computeTableLayout(columns, ["x"], "  ");

    // 5 + 2 + 5 + 2 + 5 = 19
    expect(layout.sepLen).toBe(19);
    expect(layout.headerStr.length).toBe(19);
  });

  it("supports custom gap string", () => {
    const columns: Column<string>[] = [
      { header: "A", width: 3, value: (s) => s },
      { header: "B", width: 3, value: (s) => s },
    ];
    const layout = computeTableLayout(columns, ["x"], " | ");

    expect(layout.headerStr).toBe("A   | B  ");
    expect(layout.sepLen).toBe(9);
  });
});
