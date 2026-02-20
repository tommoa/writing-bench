import { describe, it, expect } from "bun:test";
import { loadPrompts, parseModelConfigs, mergeModelEndpoints, createRunConfig, filterPrompts } from "./config.js";
import type { ModelConfig, PromptConfig } from "./types.js";

describe("loadPrompts", () => {
  it("loads all TOML prompt files", async () => {
    const prompts = await loadPrompts("prompts/*.toml");
    expect(prompts.length).toBeGreaterThanOrEqual(5);

    for (const p of prompts) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.tags.length).toBeGreaterThan(0);
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
    expect(configs[0].label).toBe("gpt-4o");
    expect(configs[0].registryId).toBe("openai:gpt-4o");
  });

  it("parses provider:model=label format", () => {
    const configs = parseModelConfigs(["anthropic:claude-sonnet-4-20250514=sonnet4"]);
    expect(configs).toHaveLength(1);
    expect(configs[0].provider).toBe("anthropic");
    expect(configs[0].model).toBe("claude-sonnet-4-20250514");
    expect(configs[0].label).toBe("sonnet4");
    expect(configs[0].registryId).toBe("anthropic:claude-sonnet-4-20250514");
  });

  it("handles ollama model:variant format", () => {
    const configs = parseModelConfigs(["ollama:llama3.1:8b"]);
    expect(configs).toHaveLength(1);
    expect(configs[0].provider).toBe("ollama");
    expect(configs[0].model).toBe("llama3.1:8b");
    expect(configs[0].label).toBe("llama3.1:8b");
    expect(configs[0].registryId).toBe("ollama:llama3.1:8b");
  });

  it("handles ollama model:variant=label format", () => {
    const configs = parseModelConfigs(["ollama:llama3.1:8b=my-llama"]);
    expect(configs).toHaveLength(1);
    expect(configs[0].provider).toBe("ollama");
    expect(configs[0].model).toBe("llama3.1:8b");
    expect(configs[0].label).toBe("my-llama");
    expect(configs[0].registryId).toBe("ollama:llama3.1:8b");
  });

  it("handles multiple models", () => {
    const configs = parseModelConfigs([
      "openai:gpt-4o",
      "anthropic:claude-sonnet-4-20250514=sonnet",
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

  it("passes through explicit outputsPerModel", () => {
    const config = createRunConfig({
      models: parseModelConfigs(["openai:gpt-4o"]),
      prompts: [],
      outputsPerModel: 10,
    });
    expect(config.outputsPerModel).toBe(10);
  });

  it("defaults outputsPerModel to Infinity when omitted", () => {
    const config = createRunConfig({
      models: parseModelConfigs(["openai:gpt-4o"]),
      prompts: [],
    });
    expect(config.outputsPerModel).toBe(Infinity);
  });
});

describe("filterPrompts", () => {
  const prompts: PromptConfig[] = [
    {
      id: "sermon",
      name: "Sunday Sermon",
      tags: ["speech", "theological"],
      description: "test",
      prompt: "test",
      judgingCriteria: ["quality"],
    },
    {
      id: "short-story",
      name: "Short Story",
      tags: ["creative", "fiction"],
      description: "test",
      prompt: "test",
      judgingCriteria: ["quality"],
    },
    {
      id: "essay",
      name: "Essay",
      tags: ["essay", "analytical"],
      description: "test",
      prompt: "test",
      judgingCriteria: ["quality"],
    },
    {
      id: "youth-talk",
      name: "Youth Talk",
      tags: ["speech", "youth"],
      description: "test",
      prompt: "test",
      judgingCriteria: ["quality"],
    },
  ];

  it("filters by prompt id", () => {
    const result = filterPrompts(prompts, ["sermon"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("sermon");
  });

  it("filters by tag", () => {
    const result = filterPrompts(prompts, ["fiction"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("short-story");
  });

  it("matches case-insensitively", () => {
    const result = filterPrompts(prompts, ["SERMON", "Fiction"]);
    // "SERMON" matches sermon by id, "Fiction" matches short-story by tag
    expect(result).toHaveLength(2);
  });

  it("matches multiple filters (union)", () => {
    const result = filterPrompts(prompts, ["sermon", "essay"]);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id).sort()).toEqual(["essay", "sermon"]);
  });

  it("matches by id even when tags differ", () => {
    // "short-story" has tags ["creative", "fiction"] -- filter by id should still work
    const result = filterPrompts(prompts, ["short-story"]);
    expect(result).toHaveLength(1);
    expect(result[0].tags).toContain("fiction");
  });

  it("returns empty array when nothing matches", () => {
    const result = filterPrompts(prompts, ["nonexistent"]);
    expect(result).toHaveLength(0);
  });

  it("returns all prompts sharing a tag", () => {
    // sermon and youth-talk both have the "speech" tag
    const result = filterPrompts(prompts, ["speech"]);
    // Matches both "sermon" and "youth-talk" by tag
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id).sort()).toEqual(["sermon", "youth-talk"]);
  });
});

describe("mergeModelEndpoints", () => {
  function makeConfig(overrides: Partial<ModelConfig> & { provider: string; model: string }): ModelConfig {
    return {
      label: overrides.model,
      registryId: `${overrides.provider}:${overrides.model}`,
      ...overrides,
    } as ModelConfig;
  }

  it("passes through models with no shared registryId", () => {
    const models = [
      makeConfig({ provider: "openai", model: "gpt-4o" }),
      makeConfig({ provider: "anthropic", model: "claude-sonnet-4" }),
    ];
    const result = mergeModelEndpoints(models);
    expect(result).toHaveLength(2);
    expect(result[0].registryId).toBe("openai:gpt-4o");
    expect(result[1].registryId).toBe("anthropic:claude-sonnet-4");
  });

  it("merges a single alias into one config", () => {
    const models = parseModelConfigs([
      "opencode:minimax-m2.5-free~opencode:minimax-m2.5",
    ]);
    const result = mergeModelEndpoints(models);
    expect(result).toHaveLength(1);
    expect(result[0].registryId).toBe("opencode:minimax-m2.5");
    expect(result[0].apiModelIds).toEqual(["opencode:minimax-m2.5-free"]);
  });

  it("merges multiple aliases to the same canonical", () => {
    const models = parseModelConfigs([
      "gv-anthropic:claude-sonnet-4~anthropic:claude-sonnet-4",
      "bedrock:anthropic.claude-sonnet-4~anthropic:claude-sonnet-4",
    ]);
    const result = mergeModelEndpoints(models);
    expect(result).toHaveLength(1);
    expect(result[0].registryId).toBe("anthropic:claude-sonnet-4");
    expect(result[0].apiModelIds).toEqual([
      "gv-anthropic:claude-sonnet-4",
      "bedrock:anthropic.claude-sonnet-4",
    ]);
  });

  it("includes canonical endpoint when specified directly alongside aliases", () => {
    const models = parseModelConfigs([
      "opencode:minimax-m2.5-free~opencode:minimax-m2.5",
      "opencode:minimax-m2.5",
    ]);
    const result = mergeModelEndpoints(models);
    expect(result).toHaveLength(1);
    expect(result[0].registryId).toBe("opencode:minimax-m2.5");
    expect(result[0].apiModelIds).toContain("opencode:minimax-m2.5-free");
    expect(result[0].apiModelIds).toContain("opencode:minimax-m2.5");
  });

  it("uses the single explicit label from the merged group", () => {
    const models = parseModelConfigs([
      "opencode:minimax-m2.5-free~opencode:minimax-m2.5=MiniMax",
      "opencode:minimax-m2.5",
    ]);
    const result = mergeModelEndpoints(models);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("MiniMax");
  });

  it("allows same explicit label on multiple entries", () => {
    const models = parseModelConfigs([
      "opencode:minimax-m2.5-free~opencode:minimax-m2.5=MiniMax",
      "opencode:minimax-m2.5=MiniMax",
    ]);
    const result = mergeModelEndpoints(models);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("MiniMax");
  });

  it("throws on conflicting explicit labels", () => {
    const models = parseModelConfigs([
      "opencode:minimax-m2.5-free~opencode:minimax-m2.5=LabelA",
      "opencode:minimax-m2.5=LabelB",
    ]);
    expect(() => mergeModelEndpoints(models)).toThrow("Conflicting labels");
  });

  it("preserves non-aliased models alongside merged groups", () => {
    const models = parseModelConfigs([
      "opencode:minimax-m2.5-free~opencode:minimax-m2.5",
      "anthropic:claude-sonnet-4",
    ]);
    const result = mergeModelEndpoints(models);
    expect(result).toHaveLength(2);
    expect(result[0].registryId).toBe("opencode:minimax-m2.5");
    expect(result[1].registryId).toBe("anthropic:claude-sonnet-4");
    expect(result[1].apiModelIds).toBeUndefined();
  });
});
