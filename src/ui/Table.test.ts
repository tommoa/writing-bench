import { describe, expect, it } from "bun:test";
import { computeTableLayout, type Column } from "./Table.js";

interface Row {
  name: string;
  preview: string;
  count: string;
}

describe("computeTableLayout", () => {
  it("keeps widths unchanged when already within max width", () => {
    const columns: Column<Row>[] = [
      { header: "Name", width: 8, value: (row) => row.name },
      { header: "Count", width: 5, align: "right", value: (row) => row.count },
    ];

    const layout = computeTableLayout(columns, [{ name: "alpha", preview: "", count: "3" }], "  ", 20);

    expect(layout.headerStr).toBe("Name      Count");
    expect(layout.sepLen).toBe(15);
  });

  it("shrinks truncate-enabled columns to fit max width", () => {
    const columns: Column<Row>[] = [
      { header: "Model", width: 20, minWidth: 8, truncate: true, value: (row) => row.name },
      { header: "Preview", width: 24, minWidth: 10, truncate: true, value: (row) => row.preview },
      { header: "Cnt", width: 3, value: (row) => row.count, align: "right" },
    ];

    const data = [{
      name: "google-vertex-anthropic:claude-sonnet-4-6@default",
      preview: "very long output preview that should be truncated",
      count: "12",
    }];
    const layout = computeTableLayout(columns, data, "  ", 30);
    const rowText = layout.formatRow(data[0], 0).map((cell) => cell.text).join(layout.gap);

    expect(layout.sepLen).toBeLessThanOrEqual(30);
    expect(layout.headerStr.length).toBeLessThanOrEqual(30);
    expect(rowText.length).toBeLessThanOrEqual(30);
    expect(rowText).toContain("...");
  });

  it("preserves fixed columns while shrinking flexible ones", () => {
    const columns: Column<Row>[] = [
      { header: "Type", width: 8, value: () => "writes" },
      { header: "Preview", width: 20, minWidth: 8, truncate: true, value: (row) => row.preview },
      { header: "Cnt", width: 4, align: "right", value: (row) => row.count },
    ];

    const data = [{ name: "", preview: "preview text that should collapse first", count: "42" }];
    const layout = computeTableLayout(columns, data, "  ", 20);
    const row = layout.formatRow(data[0], 0);

    expect(row[0].text).toBe("writes  ");
    expect(row[2].text).toBe("  42");
    expect(layout.sepLen).toBeLessThanOrEqual(20);
  });
});
