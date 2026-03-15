import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { buildModelLabelMap, resetModelsDbCache } from "./models.js";

const CACHE_DIR = join(process.cwd(), "data");
const CACHE_FILE = join(CACHE_DIR, "models-cache.json");

let originalCache: string | null = null;
let hadOriginalCache = false;

describe("buildModelLabelMap", () => {
  beforeEach(async () => {
    resetModelsDbCache();
    hadOriginalCache = existsSync(CACHE_FILE);
    originalCache = hadOriginalCache ? await readFile(CACHE_FILE, "utf-8") : null;

    if (!existsSync(CACHE_DIR)) {
      await mkdir(CACHE_DIR, { recursive: true });
    }

    await writeFile(CACHE_FILE, JSON.stringify(makeModelsCacheFixture(), null, 2));
    resetModelsDbCache();
  });

  afterEach(async () => {
    if (hadOriginalCache && originalCache !== null) {
      await writeFile(CACHE_FILE, originalCache);
    } else if (existsSync(CACHE_FILE)) {
      await rm(CACHE_FILE);
    }
    resetModelsDbCache();
  });

  it("resolves vertex anthropic model names with @ suffix", async () => {
    const spec = "google-vertex-anthropic:claude-sonnet-4-6@default";
    const labels = await buildModelLabelMap([spec]);

    expect(labels[spec]).toBe("Claude Sonnet 4.6");
  });

  it("uses canonical side for aliased specs", async () => {
    const spec = "google-vertex-anthropic:claude-sonnet-4-6@default~anthropic:claude-sonnet-4-6@20260101";
    const labels = await buildModelLabelMap([spec]);

    expect(labels[spec]).toBe("Claude Sonnet 4.6 Canonical");
  });

  it("uses explicit labels when provided", async () => {
    const spec = "google-vertex-anthropic:claude-sonnet-4-6@default~anthropic:claude-sonnet-4-6@20260101=Fast Claude";
    const labels = await buildModelLabelMap([spec]);

    expect(labels[spec]).toBe("Fast Claude");
  });

  it("leaves unknown models unmapped", async () => {
    const spec = "google-vertex-anthropic:not-real@default";
    const labels = await buildModelLabelMap([spec]);

    expect(labels[spec]).toBeUndefined();
  });

  it("keeps existing non-vertex model name lookup", async () => {
    const spec = "openai:gpt-4o";
    const labels = await buildModelLabelMap([spec]);

    expect(labels[spec]).toBe("GPT-4o");
  });

  it("falls back to unsuffixed model key when exact @ key is missing", async () => {
    const spec = "google-vertex-anthropic:claude-opus-4-6@20260101";
    const labels = await buildModelLabelMap([spec]);

    expect(labels[spec]).toBe("Claude Opus 4.6");
  });
});

function makeModelsCacheFixture() {
  return {
    timestamp: Date.now(),
    data: {
      "google-vertex-anthropic": {
        id: "google-vertex-anthropic",
        name: "Google Vertex AI Anthropic",
        models: {
          "claude-sonnet-4-6@default": {
            id: "claude-sonnet-4-6@default",
            name: "Claude Sonnet 4.6",
            family: "claude",
          },
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            family: "claude",
          },
        },
      },
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        models: {
          "claude-sonnet-4-6@20260101": {
            id: "claude-sonnet-4-6@20260101",
            name: "Claude Sonnet 4.6 Canonical",
            family: "claude",
          },
        },
      },
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            name: "GPT-4o",
            family: "gpt",
          },
        },
      },
    },
  };
}
