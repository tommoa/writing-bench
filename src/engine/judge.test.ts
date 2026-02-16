import { describe, it, expect } from "bun:test";
import { extractJson } from "./judge.js";

describe("extractJson", () => {
  it("parses plain JSON", () => {
    const result = extractJson('{"winner": "A", "reasoning": "better"}');
    expect(result).toEqual({ winner: "A", reasoning: "better" });
  });

  it("extracts from markdown code fence", () => {
    const text = 'Here is my judgment:\n```json\n{"winner": "B"}\n```\nDone.';
    expect(extractJson(text)).toEqual({ winner: "B" });
  });

  it("extracts from code fence without language tag", () => {
    const text = '```\n{"winner": "tie"}\n```';
    expect(extractJson(text)).toEqual({ winner: "tie" });
  });

  it("extracts JSON object from surrounding text", () => {
    const text = 'After careful analysis, {"winner": "A", "reasoning": "sample A is better"} is my verdict.';
    expect(extractJson(text)).toEqual({
      winner: "A",
      reasoning: "sample A is better",
    });
  });

  it("handles whitespace and newlines in JSON", () => {
    const text = `{
  "winner": "B",
  "reasoning": "more compelling"
}`;
    expect(extractJson(text)).toEqual({
      winner: "B",
      reasoning: "more compelling",
    });
  });

  it("returns null for non-JSON text", () => {
    expect(extractJson("Sample A is clearly better.")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJson("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractJson("{winner: A}")).toBeNull();
  });

  it("prefers code fence over embedded JSON", () => {
    // If there's a code fence, it should use that even if there's
    // other JSON-like text outside
    const text = 'Not this: {"winner": "A"}\n```json\n{"winner": "B"}\n```';
    // Plain parse fails (leading text), fence match returns B
    expect(extractJson(text)).toEqual({ winner: "B" });
  });
});
