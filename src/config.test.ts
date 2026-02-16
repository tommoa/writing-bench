import { describe, it, expect } from "bun:test";
import { loadPrompts, parseModelConfigs, createRunConfig } from "./config.js";

describe("loadPrompts", () => {
  it("loads all TOML prompt files", async () => {
    const prompts = await loadPrompts("prompts/*.toml");
    expect(prompts.length).toBeGreaterThanOrEqual(5);

    for (const p of prompts) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.category).toBeTruthy();
      expect(p.prompt).toBeTruthy();
      expect(p.judgingCriteria.length).toBeGreaterThan(0);
    }
  });

  it("throws on non-existent pattern", async () => {
    await expect(loadPrompts("nonexistent/*.toml")).rejects.toThrow(
      "No prompt files found"
    );
  });
});

describe("parseModelConfigs", () => {
  it("parses provider:model format", () => {
    const configs = parseModelConfigs(["openai:gpt-4o"]);
    expect(configs).toHaveLength(1);
    expect(configs[0].provider).toBe("openai");
    expect(configs[0].model).toBe("gpt-4o");
    expect(configs[0].label).toBe("openai:gpt-4o");
  });

  it("parses provider:model:label format", () => {
    const configs = parseModelConfigs(["anthropic:claude-sonnet-4-20250514:sonnet4"]);
    expect(configs).toHaveLength(1);
    expect(configs[0].provider).toBe("anthropic");
    expect(configs[0].model).toBe("claude-sonnet-4-20250514");
    expect(configs[0].label).toBe("sonnet4");
  });

  it("handles multiple models", () => {
    const configs = parseModelConfigs([
      "openai:gpt-4o",
      "anthropic:claude-sonnet-4-20250514:sonnet",
    ]);
    expect(configs).toHaveLength(2);
  });
});

describe("createRunConfig", () => {
  it("creates a valid run config", async () => {
    const prompts = await loadPrompts("prompts/*.toml");
    const models = parseModelConfigs(["openai:gpt-4o"]);

    const config = createRunConfig({
      models,
      prompts,
      outputsPerModel: 2,
    });

    expect(config.id).toBeTruthy();
    expect(config.timestamp).toBeTruthy();
    expect(config.models).toHaveLength(1);
    expect(config.prompts.length).toBeGreaterThan(0);
    expect(config.outputsPerModel).toBe(2);
  });

  it("clamps outputs to 1-3 range", () => {
    const config = createRunConfig({
      models: parseModelConfigs(["openai:gpt-4o"]),
      prompts: [],
      outputsPerModel: 10,
    });
    expect(config.outputsPerModel).toBe(3);

    const config2 = createRunConfig({
      models: parseModelConfigs(["openai:gpt-4o"]),
      prompts: [],
      outputsPerModel: 0,
    });
    expect(config2.outputsPerModel).toBe(1);
  });
});
