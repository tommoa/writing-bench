import { describe, expect, it } from "bun:test";
import { assertValidRunId, isValidRunId } from "./run-id.js";

describe("run IDs", () => {
  it("accepts generated and simple manual IDs", () => {
    expect(isValidRunId("2026-07-31t12-34-56-789z")).toBe(true);
    expect(isValidRunId("manual_run.2")).toBe(true);
    expect(() => assertValidRunId("run-1")).not.toThrow();
  });

  it("rejects path traversal and nested paths", () => {
    for (const runId of [
      "../outside",
      "nested/run",
      "nested\\run",
      ".",
      "..",
      "run.",
      "run-",
    ]) {
      expect(isValidRunId(runId)).toBe(false);
      expect(() => assertValidRunId(runId)).toThrow("Invalid run ID");
    }
  });

  it("rejects Windows device filenames", () => {
    for (const runId of ["CON", "nul.json", "Com1.log", "LPT9"]) {
      expect(isValidRunId(runId)).toBe(false);
      expect(() => assertValidRunId(runId)).toThrow("Invalid run ID");
    }
  });

  it("rejects case aliases on case-insensitive filesystems", () => {
    for (const runId of ["RUN", "Run", "2026-07-31T12-34-56-789Z"]) {
      expect(isValidRunId(runId)).toBe(false);
      expect(() => assertValidRunId(runId)).toThrow("Invalid run ID");
    }
  });

  it("rejects empty, hidden, non-ASCII, and oversized IDs", () => {
    for (const runId of ["", ".hidden", "has space", "r\u{FA}n", "a".repeat(129)]) {
      expect(isValidRunId(runId)).toBe(false);
    }
  });
});
