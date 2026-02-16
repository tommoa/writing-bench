import { describe, it, expect } from "bun:test";
import { loadPrompts, parseModelConfigs, createRunConfig, filterPrompts } from "./config.js";
import type { PromptConfig } from "./types.js";

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

describe("filterPrompts", () => {
  const prompts: PromptConfig[] = [
    {
      id: "sermon",
      name: "Sunday Sermon",
      category: "sermon",
      description: "test",
      prompt: "test",
      judgingCriteria: ["quality"],
    },
    {
      id: "short-story",
      name: "Short Story",
      category: "fiction",
      description: "test",
      prompt: "test",
      judgingCriteria: ["quality"],
    },
    {
      id: "essay",
      name: "Essay",
      category: "essay",
      description: "test",
      prompt: "test",
      judgingCriteria: ["quality"],
    },
    {
      id: "youth-talk",
      name: "Youth Talk",
      category: "youth-talk",
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

  it("filters by category", () => {
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

  it("matches by id even when category differs", () => {
    // "short-story" has category "fiction" — filter by id should still work
    const result = filterPrompts(prompts, ["short-story"]);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("fiction");
  });

  it("returns empty array when nothing matches", () => {
    const result = filterPrompts(prompts, ["nonexistent"]);
    expect(result).toHaveLength(0);
  });

  it("returns all when a category matches multiple prompts", () => {
    // Add a second sermon-category prompt
    const extended = [
      ...prompts,
      {
        id: "kids-talk",
        name: "Kids Talk",
        category: "sermon",
        description: "test",
        prompt: "test",
        judgingCriteria: ["quality"],
      },
    ];
    const result = filterPrompts(extended, ["sermon"]);
    // Matches both "sermon" (by id) and "kids-talk" (by category "sermon")
    expect(result).toHaveLength(2);
  });
});
