import { describe, it, expect } from "bun:test";
import { parseModelSpec } from "./registry.js";

describe("parseModelSpec", () => {
  // ── Backward-compatible cases ─────────────────────

  it("parses basic provider:model", () => {
    const result = parseModelSpec("openai:gpt-4o");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    expect(result.label).toBe("gpt-4o");
    expect(result.registryId).toBe("openai:gpt-4o");
    expect(result.apiModelIds).toBeUndefined();
  });

  it("parses model with colons (ollama)", () => {
    const result = parseModelSpec("ollama:llama3.1:8b");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("llama3.1:8b");
    expect(result.registryId).toBe("ollama:llama3.1:8b");
    expect(result.apiModelIds).toBeUndefined();
  });

  it("parses model with explicit label", () => {
    const result = parseModelSpec("openai:gpt-4o=fast");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    expect(result.label).toBe("fast");
    expect(result.registryId).toBe("openai:gpt-4o");
    expect(result.apiModelIds).toBeUndefined();
  });

  it("parses ollama model with explicit label", () => {
    const result = parseModelSpec("ollama:llama3.1:8b=my-llama");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("llama3.1:8b");
    expect(result.label).toBe("my-llama");
    expect(result.apiModelIds).toBeUndefined();
  });

  it("parses model with @ in name (vertex anthropic)", () => {
    const result = parseModelSpec("google-vertex-anthropic:claude-opus-4-6@default");
    expect(result.provider).toBe("google-vertex-anthropic");
    expect(result.model).toBe("claude-opus-4-6@default");
    expect(result.registryId).toBe("google-vertex-anthropic:claude-opus-4-6@default");
    expect(result.apiModelIds).toBeUndefined();
  });

  it("throws on missing colon", () => {
    expect(() => parseModelSpec("invalid")).toThrow("Expected format");
  });

  // ── Alias (~) cases ───────────────────────────────

  it("parses basic alias with ~", () => {
    const result = parseModelSpec("opencode:minimax-m2.5-free~opencode:minimax-m2.5");
    expect(result.provider).toBe("opencode");
    expect(result.model).toBe("minimax-m2.5");
    expect(result.label).toBe("minimax-m2.5");
    expect(result.registryId).toBe("opencode:minimax-m2.5");
    expect(result.apiModelIds).toEqual(["opencode:minimax-m2.5-free"]);
  });

  it("parses alias with explicit label on canonical", () => {
    const result = parseModelSpec("opencode:minimax-m2.5-free~opencode:minimax-m2.5=MiniMax");
    expect(result.provider).toBe("opencode");
    expect(result.model).toBe("minimax-m2.5");
    expect(result.label).toBe("MiniMax");
    expect(result.registryId).toBe("opencode:minimax-m2.5");
    expect(result.apiModelIds).toEqual(["opencode:minimax-m2.5-free"]);
  });

  it("parses cross-provider alias", () => {
    const result = parseModelSpec(
      "google-vertex-anthropic:claude-sonnet-4-20250514~anthropic:claude-sonnet-4-20250514"
    );
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.registryId).toBe("anthropic:claude-sonnet-4-20250514");
    expect(result.apiModelIds).toEqual([
      "google-vertex-anthropic:claude-sonnet-4-20250514",
    ]);
  });

  it("does not treat ~ in label as alias", () => {
    // ~ after = with no colon following it -- not a valid alias
    const result = parseModelSpec("openai:gpt-4o=my~label");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    expect(result.label).toBe("my~label");
    expect(result.apiModelIds).toBeUndefined();
  });

  it("throws on invalid API endpoint spec (no colon before ~)", () => {
    expect(() => parseModelSpec("invalid~openai:gpt-4o")).toThrow(
      "Invalid API endpoint spec"
    );
  });

  it("handles alias where canonical has colons in model name", () => {
    const result = parseModelSpec("opencode:llama3.1:8b-free~ollama:llama3.1:8b");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("llama3.1:8b");
    expect(result.registryId).toBe("ollama:llama3.1:8b");
    expect(result.apiModelIds).toEqual(["opencode:llama3.1:8b-free"]);
  });

  it("throws when label is on the API side of ~", () => {
    expect(() =>
      parseModelSpec("opencode:model-free=BadLabel~opencode:model")
    ).toThrow("Labels (=) are not allowed on the API endpoint side");
  });
});
