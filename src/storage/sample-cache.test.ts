import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { rm, readdir, readFile } from "fs/promises";
import { join } from "path";
import {
  SampleCache,
  hashPromptContent,
  randomSample,
  trimModelOutputs,
  combineModelCaches,
  judgmentPairHash,
  modelKey,
  type CachedWrite,
  type CachedFeedback,
  type CachedRevision,
  type CachedJudgment,
} from "./sample-cache.js";

const TEST_CACHE_DIR = join(process.cwd(), "data", "test-cache");

function makeCachedWrite(overrides: Partial<CachedWrite> = {}): CachedWrite {
  return {
    cacheId: "write-1",
    text: "A sample writing output",
    usage: { inputTokens: 100, outputTokens: 500 },
    cost: { input: 0.001, output: 0.005, total: 0.006, totalUncached: 0.006 },
    latencyMs: 2000,
    createdAt: "2026-02-15T10:00:00Z",
    ...overrides,
  };
}

function makeCachedFeedback(
  overrides: Partial<CachedFeedback> = {}
): CachedFeedback {
  return {
    cacheId: "fb-1",
    writeCacheId: "write-1",
    sourceModel: "openai:gpt-4o",
    text: "This is feedback on the writing",
    usage: { inputTokens: 200, outputTokens: 300 },
    cost: { input: 0.002, output: 0.003, total: 0.005, totalUncached: 0.005 },
    latencyMs: 1500,
    createdAt: "2026-02-15T10:01:00Z",
    ...overrides,
  };
}

function makeCachedRevision(
  overrides: Partial<CachedRevision> = {}
): CachedRevision {
  return {
    cacheId: "rev-1",
    feedbackCacheId: "fb-1",
    text: "A revised writing output incorporating feedback",
    usage: { inputTokens: 300, outputTokens: 600 },
    cost: { input: 0.003, output: 0.006, total: 0.009, totalUncached: 0.009 },
    latencyMs: 2500,
    createdAt: "2026-02-15T10:02:00Z",
    ...overrides,
  };
}

describe("hashPromptContent", () => {
  it("returns a 16-char hex string", () => {
    const hash = hashPromptContent("Write a sermon about hope.");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns same hash for identical content", () => {
    const a = hashPromptContent("Write a story.");
    const b = hashPromptContent("Write a story.");
    expect(a).toBe(b);
  });

  it("returns different hash for different content", () => {
    const a = hashPromptContent("Write a story about cats.");
    const b = hashPromptContent("Write a story about dogs.");
    expect(a).not.toBe(b);
  });

  it("normalizes trailing whitespace", () => {
    const a = hashPromptContent("Write a story.  \n\n");
    const b = hashPromptContent("Write a story.");
    expect(a).toBe(b);
  });

  it("normalizes CRLF to LF", () => {
    const a = hashPromptContent("line1\r\nline2");
    const b = hashPromptContent("line1\nline2");
    expect(a).toBe(b);
  });
});

describe("randomSample", () => {
  it("returns all items when count >= length", () => {
    const items = [1, 2, 3];
    const result = randomSample(items, 5);
    expect(result.sort()).toEqual([1, 2, 3]);
  });

  it("returns exact count when count < length", () => {
    const items = [1, 2, 3, 4, 5];
    const result = randomSample(items, 3);
    expect(result).toHaveLength(3);
  });

  it("returns unique items (no duplicates)", () => {
    const items = [1, 2, 3, 4, 5];
    const result = randomSample(items, 4);
    const unique = new Set(result);
    expect(unique.size).toBe(4);
  });

  it("only returns items from the original array", () => {
    const items = [10, 20, 30, 40];
    const result = randomSample(items, 2);
    for (const r of result) {
      expect(items).toContain(r);
    }
  });

  it("does not mutate the original array", () => {
    const items = [1, 2, 3, 4, 5];
    const copy = [...items];
    randomSample(items, 3);
    expect(items).toEqual(copy);
  });

  it("returns empty array for empty input", () => {
    expect(randomSample([], 3)).toEqual([]);
  });
});

describe("SampleCache - writes", () => {
  let cache: SampleCache;

  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new SampleCache(TEST_CACHE_DIR);
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("returns empty array for uncached model/prompt", async () => {
    const result = await cache.getCachedWrites("openai", "gpt-4o", "Write something.");
    expect(result).toEqual([]);
  });

  it("stores and retrieves a cached write", async () => {
    const entry = makeCachedWrite({ cacheId: "test-write-1" });
    await cache.addCachedWrite("openai", "gpt-4o", "Write a story.", entry, 0);

    const results = await cache.getCachedWrites("openai", "gpt-4o", "Write a story.");
    expect(results).toHaveLength(1);
    expect(results[0].cacheId).toBe("test-write-1");
    expect(results[0].text).toBe("A sample writing output");
  });

  it("accumulates multiple writes for same model/prompt", async () => {
    await cache.addCachedWrite(
      "openai", "gpt-4o", "Write a story.",
      makeCachedWrite({ cacheId: "w1", text: "Output 1" }), 0,
    );
    await cache.addCachedWrite(
      "openai", "gpt-4o", "Write a story.",
      makeCachedWrite({ cacheId: "w2", text: "Output 2" }), 1,
    );
    await cache.addCachedWrite(
      "openai", "gpt-4o", "Write a story.",
      makeCachedWrite({ cacheId: "w3", text: "Output 3" }), 2,
    );

    const results = await cache.getCachedWrites("openai", "gpt-4o", "Write a story.");
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.cacheId).sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("different prompts have independent caches", async () => {
    await cache.addCachedWrite(
      "openai", "gpt-4o", "Write a story.",
      makeCachedWrite({ cacheId: "story" }), 0,
    );
    await cache.addCachedWrite(
      "openai", "gpt-4o", "Write a poem.",
      makeCachedWrite({ cacheId: "poem" }), 0,
    );

    const stories = await cache.getCachedWrites("openai", "gpt-4o", "Write a story.");
    const poems = await cache.getCachedWrites("openai", "gpt-4o", "Write a poem.");
    expect(stories).toHaveLength(1);
    expect(poems).toHaveLength(1);
    expect(stories[0].cacheId).toBe("story");
    expect(poems[0].cacheId).toBe("poem");
  });

  it("different models have independent caches", async () => {
    await cache.addCachedWrite(
      "openai", "gpt-4o", "Write a story.",
      makeCachedWrite({ cacheId: "gpt" }), 0,
    );
    await cache.addCachedWrite(
      "anthropic", "claude-sonnet-4-20250514", "Write a story.",
      makeCachedWrite({ cacheId: "claude" }), 0,
    );

    const gpt = await cache.getCachedWrites("openai", "gpt-4o", "Write a story.");
    const claude = await cache.getCachedWrites("anthropic", "claude-sonnet-4-20250514", "Write a story.");
    expect(gpt).toHaveLength(1);
    expect(claude).toHaveLength(1);
  });

  it("prompt content change invalidates cache (different hash)", async () => {
    await cache.addCachedWrite(
      "openai", "gpt-4o", "Write a story about cats.",
      makeCachedWrite({ cacheId: "cats" }), 0,
    );

    // Same model, but different prompt text
    const results = await cache.getCachedWrites(
      "openai", "gpt-4o", "Write a story about dogs."
    );
    expect(results).toEqual([]);

    // Original still works
    const cats = await cache.getCachedWrites(
      "openai", "gpt-4o", "Write a story about cats."
    );
    expect(cats).toHaveLength(1);
  });

  it("persists to disk as JSON files", async () => {
    await cache.addCachedWrite(
      "openai", "gpt-4o", "Test prompt.",
      makeCachedWrite({ cacheId: "disk-test" }), 0,
    );

    // Create a fresh cache instance pointing at the same dir
    const cache2 = new SampleCache(TEST_CACHE_DIR);
    const results = await cache2.getCachedWrites("openai", "gpt-4o", "Test prompt.");
    expect(results).toHaveLength(1);
    expect(results[0].cacheId).toBe("disk-test");
  });

  it("concurrent writes at different indices do not collide", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeCachedWrite({ cacheId: `w${i}`, text: `Output ${i}` })
    );
    // Write all 5 in parallel at explicit indices
    await Promise.all(
      entries.map((e, i) =>
        cache.addCachedWrite("openai", "gpt-4o", "Write a story.", e, i)
      ),
    );
    const results = await cache.getCachedWrites("openai", "gpt-4o", "Write a story.");
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.cacheId).sort()).toEqual(["w0", "w1", "w2", "w3", "w4"]);
  });
});

describe("SampleCache - feedback", () => {
  let cache: SampleCache;

  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new SampleCache(TEST_CACHE_DIR);
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("returns null for uncached feedback", async () => {
    const result = await cache.getCachedFeedback("openai", "gpt-4o", "write-1");
    expect(result).toBeNull();
  });

  it("stores and retrieves cached feedback", async () => {
    const entry = makeCachedFeedback({ cacheId: "fb-test" });
    await cache.addCachedFeedback("openai", "gpt-4o", "write-1", entry);

    const result = await cache.getCachedFeedback("openai", "gpt-4o", "write-1");
    expect(result).not.toBeNull();
    expect(result!.cacheId).toBe("fb-test");
    expect(result!.text).toBe("This is feedback on the writing");
  });

  it("different feedback models are independent", async () => {
    await cache.addCachedFeedback(
      "openai", "gpt-4o", "write-1",
      makeCachedFeedback({ cacheId: "fb-gpt" })
    );
    await cache.addCachedFeedback(
      "anthropic", "claude-sonnet-4-20250514", "write-1",
      makeCachedFeedback({ cacheId: "fb-claude" })
    );

    const gpt = await cache.getCachedFeedback("openai", "gpt-4o", "write-1");
    const claude = await cache.getCachedFeedback("anthropic", "claude-sonnet-4-20250514", "write-1");
    expect(gpt!.cacheId).toBe("fb-gpt");
    expect(claude!.cacheId).toBe("fb-claude");
  });

  it("different write IDs are independent", async () => {
    await cache.addCachedFeedback(
      "openai", "gpt-4o", "write-1",
      makeCachedFeedback({ cacheId: "fb-w1" })
    );

    const miss = await cache.getCachedFeedback("openai", "gpt-4o", "write-2");
    expect(miss).toBeNull();
  });
});

describe("SampleCache - revisions", () => {
  let cache: SampleCache;

  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new SampleCache(TEST_CACHE_DIR);
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("returns null for uncached revision", async () => {
    const result = await cache.getCachedRevision("openai", "gpt-4o", "fb-1");
    expect(result).toBeNull();
  });

  it("stores and retrieves cached revision", async () => {
    const entry = makeCachedRevision({ cacheId: "rev-test" });
    await cache.addCachedRevision("openai", "gpt-4o", "fb-1", entry);

    const result = await cache.getCachedRevision("openai", "gpt-4o", "fb-1");
    expect(result).not.toBeNull();
    expect(result!.cacheId).toBe("rev-test");
  });

  it("different writers are independent", async () => {
    await cache.addCachedRevision(
      "openai", "gpt-4o", "fb-1",
      makeCachedRevision({ cacheId: "rev-gpt" })
    );

    const miss = await cache.getCachedRevision("anthropic", "claude-sonnet-4-20250514", "fb-1");
    expect(miss).toBeNull();
  });
});

function makeCachedJudgment(
  overrides: Partial<CachedJudgment> = {}
): CachedJudgment {
  return {
    cacheId: "j-1",
    winner: "A",
    reasoning: "Sample A was more compelling.",
    stage: "initial",
    usage: { inputTokens: 400, outputTokens: 200 },
    cost: { input: 0.004, output: 0.002, total: 0.006, totalUncached: 0.006 },
    latencyMs: 1800,
    createdAt: "2026-02-15T10:03:00Z",
    ...overrides,
  };
}

describe("SampleCache - judgments", () => {
  let cache: SampleCache;

  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new SampleCache(TEST_CACHE_DIR);
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("returns null for uncached judgment", async () => {
    const result = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "sample-a", "sample-b"
    );
    expect(result).toBeNull();
  });

  it("stores and retrieves a cached judgment", async () => {
    const entry = makeCachedJudgment({ cacheId: "j-test", winner: "A" });
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "initial", "sample-a", "sample-b", entry
    );

    const result = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "sample-a", "sample-b"
    );
    expect(result).not.toBeNull();
    expect(result!.winner).toBe("A");
    expect(result!.reasoning).toBe("Sample A was more compelling.");
  });

  it("flips winner when A/B are swapped on retrieval", async () => {
    const entry = makeCachedJudgment({ winner: "A" });
    // Store with (a, b)
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "initial", "alpha", "beta", entry
    );

    // Retrieve with (b, a) -- swapped
    const result = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "beta", "alpha"
    );
    expect(result).not.toBeNull();
    expect(result!.winner).toBe("B");
  });

  it("flips winner B to A when swapped", async () => {
    const entry = makeCachedJudgment({ winner: "B" });
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "initial", "alpha", "beta", entry
    );

    const result = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "beta", "alpha"
    );
    expect(result!.winner).toBe("A");
  });

  it("tie stays tie regardless of order", async () => {
    const entry = makeCachedJudgment({ winner: "tie" });
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "initial", "alpha", "beta", entry
    );

    const forward = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "alpha", "beta"
    );
    const reversed = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "beta", "alpha"
    );
    expect(forward!.winner).toBe("tie");
    expect(reversed!.winner).toBe("tie");
  });

  it("same pair stored with swapped order hits same cache entry", async () => {
    const entry = makeCachedJudgment({ winner: "A" });
    // Store with (beta, alpha) -- reverse alphabetical
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "initial", "beta", "alpha", entry
    );

    // Retrieve with (alpha, beta) -- alphabetical
    const result = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "alpha", "beta"
    );
    expect(result).not.toBeNull();
    // beta was A (winner), alpha was B. Sorted: alpha first.
    // So stored winner should be flipped: B. Reading as (alpha, beta) = no flip.
    expect(result!.winner).toBe("B");
  });

  it("different stages are independent", async () => {
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "initial", "s-a", "s-b",
      makeCachedJudgment({ winner: "A" })
    );
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "improvement", "s-a", "s-b",
      makeCachedJudgment({ winner: "B" })
    );

    const initial = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "s-a", "s-b"
    );
    const improvement = await cache.getCachedJudgment(
      "openai", "gpt-4o", "improvement", "s-a", "s-b"
    );
    expect(initial!.winner).toBe("A");
    expect(improvement!.winner).toBe("B");
  });

  it("different judge models are independent", async () => {
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "initial", "s-a", "s-b",
      makeCachedJudgment({ winner: "A" })
    );
    await cache.addCachedJudgment(
      "anthropic", "claude-sonnet-4-20250514", "initial", "s-a", "s-b",
      makeCachedJudgment({ winner: "B" })
    );

    const gpt = await cache.getCachedJudgment(
      "openai", "gpt-4o", "initial", "s-a", "s-b"
    );
    const claude = await cache.getCachedJudgment(
      "anthropic", "claude-sonnet-4-20250514", "initial", "s-a", "s-b"
    );
    expect(gpt!.winner).toBe("A");
    expect(claude!.winner).toBe("B");
  });

  it("persists to disk across cache instances", async () => {
    await cache.addCachedJudgment(
      "openai", "gpt-4o", "initial", "s-a", "s-b",
      makeCachedJudgment({ cacheId: "persist-j" })
    );

    const cache2 = new SampleCache(TEST_CACHE_DIR);
    const result = await cache2.getCachedJudgment(
      "openai", "gpt-4o", "initial", "s-a", "s-b"
    );
    expect(result).not.toBeNull();
    expect(result!.cacheId).toBe("persist-j");
  });
});

describe("SampleCache - full provenance chain", () => {
  let cache: SampleCache;

  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new SampleCache(TEST_CACHE_DIR);
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("write -> feedback -> revision chain", async () => {
    // 1. Cache a write
    const write = makeCachedWrite({ cacheId: "chain-w1" });
    await cache.addCachedWrite("openai", "gpt-4o", "Test prompt", write, 0);

    // 2. Cache feedback on that write
    const feedback = makeCachedFeedback({
      cacheId: "chain-fb1",
      writeCacheId: "chain-w1",
    });
    await cache.addCachedFeedback("anthropic", "claude-sonnet-4-20250514", "chain-w1", feedback);

    // 3. Cache revision using that feedback
    const revision = makeCachedRevision({
      cacheId: "chain-rev1",
      feedbackCacheId: "chain-fb1",
    });
    await cache.addCachedRevision("openai", "gpt-4o", "chain-fb1", revision);

    // Verify the full chain can be retrieved
    const writes = await cache.getCachedWrites("openai", "gpt-4o", "Test prompt");
    expect(writes).toHaveLength(1);

    const fb = await cache.getCachedFeedback(
      "anthropic", "claude-sonnet-4-20250514", writes[0].cacheId
    );
    expect(fb).not.toBeNull();

    const rev = await cache.getCachedRevision("openai", "gpt-4o", fb!.cacheId);
    expect(rev).not.toBeNull();
    expect(rev!.feedbackCacheId).toBe("chain-fb1");
  });
});

// ── trimModelOutputs ────────────────────────────────

describe("trimModelOutputs", () => {
  let cache: SampleCache;
  const WRITER = { provider: "openai", model: "gpt-4o" };
  const WRITER2 = { provider: "anthropic", model: "claude-sonnet-4-20250514" };
  const FB_MODEL = { provider: "google", model: "gemini-2" };
  const JUDGE = { provider: "openai", model: "gpt-4o" };
  const PROMPT = "Write a story.";
  const MK = modelKey(WRITER.provider, WRITER.model);

  beforeEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new SampleCache(TEST_CACHE_DIR);
  });

  afterEach(async () => {
    if (existsSync(TEST_CACHE_DIR)) {
      await rm(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("trims outputs above N, keeping indices 0 through N-1", async () => {
    // Create 5 writes
    for (let i = 0; i < 5; i++) {
      await cache.addCachedWrite(
        WRITER.provider, WRITER.model, PROMPT,
        makeCachedWrite({ cacheId: `w${i}`, text: `Output ${i}` }), i,
      );
    }

    const result = await trimModelOutputs(TEST_CACHE_DIR, MK, 3);

    expect(result.writesDeleted).toBe(2);
    expect(result.promptsAffected).toBe(1);
    expect(result.totalPrompts).toBe(1);

    // Verify surviving writes
    const remaining = await cache.getCachedWrites(WRITER.provider, WRITER.model, PROMPT);
    expect(remaining).toHaveLength(3);
    expect(remaining.map((r) => r.cacheId)).toEqual(["w0", "w1", "w2"]);
  });

  it("no-ops when N >= existing outputs", async () => {
    for (let i = 0; i < 3; i++) {
      await cache.addCachedWrite(
        WRITER.provider, WRITER.model, PROMPT,
        makeCachedWrite({ cacheId: `w${i}` }), i,
      );
    }

    const result = await trimModelOutputs(TEST_CACHE_DIR, MK, 5);

    expect(result.writesDeleted).toBe(0);
    expect(result.promptsAffected).toBe(0);
    expect(result.totalPrompts).toBe(1);

    const remaining = await cache.getCachedWrites(WRITER.provider, WRITER.model, PROMPT);
    expect(remaining).toHaveLength(3);
  });

  it("handles N=0 by deleting all outputs", async () => {
    for (let i = 0; i < 3; i++) {
      await cache.addCachedWrite(
        WRITER.provider, WRITER.model, PROMPT,
        makeCachedWrite({ cacheId: `w${i}` }), i,
      );
    }

    const result = await trimModelOutputs(TEST_CACHE_DIR, MK, 0);

    expect(result.writesDeleted).toBe(3);
    expect(result.promptsAffected).toBe(1);
  });

  it("returns zeros when no cache exists for the model", async () => {
    const result = await trimModelOutputs(TEST_CACHE_DIR, "nonexistent_model", 3);

    expect(result.writesDeleted).toBe(0);
    expect(result.totalPrompts).toBe(0);
    expect(result.promptsAffected).toBe(0);
  });

  it("cascades deletion to linked feedback and revisions", async () => {
    // Create 4 writes
    for (let i = 0; i < 4; i++) {
      await cache.addCachedWrite(
        WRITER.provider, WRITER.model, PROMPT,
        makeCachedWrite({ cacheId: `w${i}` }), i,
      );
    }

    // Add feedback on writes w2 and w3 (will be deleted)
    await cache.addCachedFeedback(
      FB_MODEL.provider, FB_MODEL.model, "w2",
      makeCachedFeedback({ cacheId: "fb-w2", writeCacheId: "w2" }),
    );
    await cache.addCachedFeedback(
      FB_MODEL.provider, FB_MODEL.model, "w3",
      makeCachedFeedback({ cacheId: "fb-w3", writeCacheId: "w3" }),
    );

    // Also add feedback on w0 (should survive)
    await cache.addCachedFeedback(
      FB_MODEL.provider, FB_MODEL.model, "w0",
      makeCachedFeedback({ cacheId: "fb-w0", writeCacheId: "w0" }),
    );

    // Add revisions linked to the feedback
    await cache.addCachedRevision(
      WRITER.provider, WRITER.model, "fb-w2",
      makeCachedRevision({ cacheId: "rev-w2", feedbackCacheId: "fb-w2" }),
    );
    await cache.addCachedRevision(
      WRITER.provider, WRITER.model, "fb-w3",
      makeCachedRevision({ cacheId: "rev-w3", feedbackCacheId: "fb-w3" }),
    );
    await cache.addCachedRevision(
      WRITER.provider, WRITER.model, "fb-w0",
      makeCachedRevision({ cacheId: "rev-w0", feedbackCacheId: "fb-w0" }),
    );

    const result = await trimModelOutputs(TEST_CACHE_DIR, MK, 2);

    expect(result.writesDeleted).toBe(2);
    expect(result.feedbackDeleted).toBe(2);
    expect(result.revisionsDeleted).toBe(2);

    // Surviving feedback for w0 should still be there
    const fbSurvived = await cache.getCachedFeedback(
      FB_MODEL.provider, FB_MODEL.model, "w0",
    );
    expect(fbSurvived).not.toBeNull();
    expect(fbSurvived!.cacheId).toBe("fb-w0");

    // Deleted feedback should be gone
    const fbDeleted = await cache.getCachedFeedback(
      FB_MODEL.provider, FB_MODEL.model, "w2",
    );
    expect(fbDeleted).toBeNull();

    // Surviving revision should still be there
    const revSurvived = await cache.getCachedRevision(
      WRITER.provider, WRITER.model, "fb-w0",
    );
    expect(revSurvived).not.toBeNull();

    // Deleted revision should be gone
    const revDeleted = await cache.getCachedRevision(
      WRITER.provider, WRITER.model, "fb-w2",
    );
    expect(revDeleted).toBeNull();
  });

  it("deletes only stale judgments, keeps unrelated ones", async () => {
    // Writer 1: 4 writes
    for (let i = 0; i < 4; i++) {
      await cache.addCachedWrite(
        WRITER.provider, WRITER.model, PROMPT,
        makeCachedWrite({ cacheId: `w1-${i}` }), i,
      );
    }

    // Writer 2: 2 writes (won't be trimmed, different model)
    const mk2 = modelKey(WRITER2.provider, WRITER2.model);
    for (let i = 0; i < 2; i++) {
      await cache.addCachedWrite(
        WRITER2.provider, WRITER2.model, PROMPT,
        makeCachedWrite({ cacheId: `w2-${i}` }), i,
      );
    }

    // Judgment: w1-0 vs w2-0 (initial) -- both survive trimming, should remain
    await cache.addCachedJudgment(
      JUDGE.provider, JUDGE.model, "initial", "w1-0", "w2-0",
      makeCachedJudgment({ cacheId: "j-survive" }),
    );

    // Judgment: w1-2 vs w2-0 (initial) -- w1-2 will be deleted, judgment is stale
    await cache.addCachedJudgment(
      JUDGE.provider, JUDGE.model, "initial", "w1-2", "w2-0",
      makeCachedJudgment({ cacheId: "j-stale" }),
    );

    // Judgment: w2-0 vs w2-1 (initial) -- unrelated to trimmed model, should survive
    await cache.addCachedJudgment(
      JUDGE.provider, JUDGE.model, "initial", "w2-0", "w2-1",
      makeCachedJudgment({ cacheId: "j-unrelated" }),
    );

    const result = await trimModelOutputs(TEST_CACHE_DIR, MK, 2);

    expect(result.writesDeleted).toBe(2);
    expect(result.judgmentsDeleted).toBe(1);

    // Surviving judgment should still be retrievable
    const jSurvive = await cache.getCachedJudgment(
      JUDGE.provider, JUDGE.model, "initial", "w1-0", "w2-0",
    );
    expect(jSurvive).not.toBeNull();
    expect(jSurvive!.cacheId).toBe("j-survive");

    // Stale judgment should be gone
    const jStale = await cache.getCachedJudgment(
      JUDGE.provider, JUDGE.model, "initial", "w1-2", "w2-0",
    );
    expect(jStale).toBeNull();

    // Unrelated judgment should survive
    const jUnrelated = await cache.getCachedJudgment(
      JUDGE.provider, JUDGE.model, "initial", "w2-0", "w2-1",
    );
    expect(jUnrelated).not.toBeNull();
    expect(jUnrelated!.cacheId).toBe("j-unrelated");
  });

  it("handles multiple feedback models per write", async () => {
    // Create 2 writes
    for (let i = 0; i < 2; i++) {
      await cache.addCachedWrite(
        WRITER.provider, WRITER.model, PROMPT,
        makeCachedWrite({ cacheId: `w${i}` }), i,
      );
    }

    // Two different feedback models on w1 (will be deleted)
    await cache.addCachedFeedback(
      FB_MODEL.provider, FB_MODEL.model, "w1",
      makeCachedFeedback({ cacheId: "fb-g-w1", writeCacheId: "w1" }),
    );
    await cache.addCachedFeedback(
      WRITER2.provider, WRITER2.model, "w1",
      makeCachedFeedback({ cacheId: "fb-c-w1", writeCacheId: "w1" }),
    );

    const result = await trimModelOutputs(TEST_CACHE_DIR, MK, 1);

    expect(result.writesDeleted).toBe(1);
    expect(result.feedbackDeleted).toBe(2);

    // Both feedback files should be gone
    const fb1 = await cache.getCachedFeedback(
      FB_MODEL.provider, FB_MODEL.model, "w1",
    );
    const fb2 = await cache.getCachedFeedback(
      WRITER2.provider, WRITER2.model, "w1",
    );
    expect(fb1).toBeNull();
    expect(fb2).toBeNull();
  });

  it("handles multiple prompts, only trims where needed", async () => {
    const PROMPT2 = "Write a poem.";

    // 5 writes for prompt 1, 2 writes for prompt 2
    for (let i = 0; i < 5; i++) {
      await cache.addCachedWrite(
        WRITER.provider, WRITER.model, PROMPT,
        makeCachedWrite({ cacheId: `s-w${i}` }), i,
      );
    }
    for (let i = 0; i < 2; i++) {
      await cache.addCachedWrite(
        WRITER.provider, WRITER.model, PROMPT2,
        makeCachedWrite({ cacheId: `p-w${i}` }), i,
      );
    }

    const result = await trimModelOutputs(TEST_CACHE_DIR, MK, 3);

    // Only prompt 1 should be trimmed (5 > 3), prompt 2 (2 <= 3) untouched
    expect(result.promptsAffected).toBe(1);
    expect(result.totalPrompts).toBe(2);
    expect(result.writesDeleted).toBe(2);

    const remaining1 = await cache.getCachedWrites(WRITER.provider, WRITER.model, PROMPT);
    expect(remaining1).toHaveLength(3);

    const remaining2 = await cache.getCachedWrites(WRITER.provider, WRITER.model, PROMPT2);
    expect(remaining2).toHaveLength(2);
  });
});

// ── combineModelCaches ─────────────────────────────

describe("combineModelCaches", () => {
  const COMBINE_CACHE_DIR = join(process.cwd(), "data", "test-combine-cache");
  const SOURCE_KEY = "opencode_minimax-m2.5-free";
  const TARGET_KEY = "opencode_minimax-m2.5";
  const PROMPT_HASH = "abc123deadbeef00";

  beforeEach(async () => {
    if (existsSync(COMBINE_CACHE_DIR)) {
      await rm(COMBINE_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    if (existsSync(COMBINE_CACHE_DIR)) {
      await rm(COMBINE_CACHE_DIR, { recursive: true });
    }
  });

  async function writeJsonFile(dir: string, filename: string, data: unknown): Promise<void> {
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), JSON.stringify(data, null, 2));
  }

  it("merges writes with renumbered indices", async () => {
    // Target has 2 samples
    const tgtDir = join(COMBINE_CACHE_DIR, "writes", TARGET_KEY, PROMPT_HASH);
    await writeJsonFile(tgtDir, "sample_0.json", makeCachedWrite({ cacheId: "tgt-0" }));
    await writeJsonFile(tgtDir, "sample_1.json", makeCachedWrite({ cacheId: "tgt-1" }));

    // Source has 3 samples
    const srcDir = join(COMBINE_CACHE_DIR, "writes", SOURCE_KEY, PROMPT_HASH);
    await writeJsonFile(srcDir, "sample_0.json", makeCachedWrite({ cacheId: "src-0" }));
    await writeJsonFile(srcDir, "sample_1.json", makeCachedWrite({ cacheId: "src-1" }));
    await writeJsonFile(srcDir, "sample_2.json", makeCachedWrite({ cacheId: "src-2" }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    expect(result.writesMoved).toBe(3);

    // Target should have 5 files: sample_0, sample_1 (original), sample_2, sample_3, sample_4 (moved)
    const files = (await readdir(tgtDir)).filter((f) => f.endsWith(".json")).sort();
    expect(files).toHaveLength(5);

    // Verify the moved samples have correct cacheIds (preserved from source)
    const movedSample = JSON.parse(await readFile(join(tgtDir, "sample_2.json"), "utf-8"));
    expect(movedSample.cacheId).toBe("src-0");

    // Source directory should be removed
    expect(existsSync(join(COMBINE_CACHE_DIR, "writes", SOURCE_KEY))).toBe(false);
  });

  it("copies feedback files, skipping existing and tracking deduped count", async () => {
    const srcFbDir = join(COMBINE_CACHE_DIR, "feedback", SOURCE_KEY);
    const tgtFbDir = join(COMBINE_CACHE_DIR, "feedback", TARGET_KEY);

    // Source has 2 feedback files
    await writeJsonFile(srcFbDir, "write-1.json", makeCachedFeedback({ cacheId: "fb-src-1" }));
    await writeJsonFile(srcFbDir, "write-2.json", makeCachedFeedback({ cacheId: "fb-src-2" }));

    // Target already has one of them
    await writeJsonFile(tgtFbDir, "write-1.json", makeCachedFeedback({ cacheId: "fb-tgt-1" }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    expect(result.feedbackMoved).toBe(1); // Only write-2.json moved
    expect(result.feedbackDeduped).toBe(1); // write-1.json was deduped

    // Target should have 2 files
    const files = (await readdir(tgtFbDir)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);

    // The existing file should NOT have been overwritten
    const existing = JSON.parse(await readFile(join(tgtFbDir, "write-1.json"), "utf-8"));
    expect(existing.cacheId).toBe("fb-tgt-1");

    // Source directory should be removed
    expect(existsSync(srcFbDir)).toBe(false);
  });

  it("copies judgments and revisions", async () => {
    const srcJudgDir = join(COMBINE_CACHE_DIR, "judgments", SOURCE_KEY);
    const srcRevDir = join(COMBINE_CACHE_DIR, "revisions", SOURCE_KEY);

    await writeJsonFile(srcJudgDir, "hash1.json", { winner: "A" });
    await writeJsonFile(srcRevDir, "fb-1.json", makeCachedRevision({ cacheId: "rev-src-1" }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    expect(result.judgmentsMoved).toBe(1);
    expect(result.revisionsMoved).toBe(1);

    // Target dirs should exist with the files
    expect(existsSync(join(COMBINE_CACHE_DIR, "judgments", TARGET_KEY, "hash1.json"))).toBe(true);
    expect(existsSync(join(COMBINE_CACHE_DIR, "revisions", TARGET_KEY, "fb-1.json"))).toBe(true);

    // Source dirs should be removed
    expect(existsSync(srcJudgDir)).toBe(false);
    expect(existsSync(srcRevDir)).toBe(false);
  });

  it("returns zeros when source has no data", async () => {
    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    expect(result.writesMoved).toBe(0);
    expect(result.feedbackMoved).toBe(0);
    expect(result.revisionsMoved).toBe(0);
    expect(result.judgmentsMoved).toBe(0);
  });

  it("creates target directory when only source exists", async () => {
    const srcDir = join(COMBINE_CACHE_DIR, "writes", SOURCE_KEY, PROMPT_HASH);
    await writeJsonFile(srcDir, "sample_0.json", makeCachedWrite({ cacheId: "src-0" }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    expect(result.writesMoved).toBe(1);

    // Target should have the file
    const tgtDir = join(COMBINE_CACHE_DIR, "writes", TARGET_KEY, PROMPT_HASH);
    expect(existsSync(join(tgtDir, "sample_0.json"))).toBe(true);
  });

  it("skips source writes whose cacheId already exists in target", async () => {
    const tgtDir = join(COMBINE_CACHE_DIR, "writes", TARGET_KEY, PROMPT_HASH);
    const srcDir = join(COMBINE_CACHE_DIR, "writes", SOURCE_KEY, PROMPT_HASH);

    // Target has writes A and D
    await writeJsonFile(tgtDir, "sample_0.json", makeCachedWrite({ cacheId: "shared-A" }));
    await writeJsonFile(tgtDir, "sample_1.json", makeCachedWrite({ cacheId: "unique-D" }));

    // Source has writes A, B, C -- A overlaps with target
    await writeJsonFile(srcDir, "sample_0.json", makeCachedWrite({ cacheId: "shared-A" }));
    await writeJsonFile(srcDir, "sample_1.json", makeCachedWrite({ cacheId: "unique-B" }));
    await writeJsonFile(srcDir, "sample_2.json", makeCachedWrite({ cacheId: "unique-C" }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    // Only B and C should be moved (A is a duplicate)
    expect(result.writesMoved).toBe(2);

    // Target should have 4 files total: A, D (original) + B, C (moved)
    const files = (await readdir(tgtDir)).filter((f) => f.endsWith(".json")).sort();
    expect(files).toHaveLength(4);

    // Verify no duplicate cacheIds
    const cacheIds: string[] = [];
    for (const f of files) {
      const entry = JSON.parse(await readFile(join(tgtDir, f), "utf-8"));
      cacheIds.push(entry.cacheId);
    }
    expect(new Set(cacheIds).size).toBe(4);
    expect(cacheIds).toContain("shared-A");
    expect(cacheIds).toContain("unique-D");
    expect(cacheIds).toContain("unique-B");
    expect(cacheIds).toContain("unique-C");
  });

  it("skips duplicate cacheIds within source files themselves", async () => {
    const srcDir = join(COMBINE_CACHE_DIR, "writes", SOURCE_KEY, PROMPT_HASH);

    // Source has a duplicate cacheId within itself
    await writeJsonFile(srcDir, "sample_0.json", makeCachedWrite({ cacheId: "dup-X" }));
    await writeJsonFile(srcDir, "sample_1.json", makeCachedWrite({ cacheId: "dup-X" }));
    await writeJsonFile(srcDir, "sample_2.json", makeCachedWrite({ cacheId: "unique-Y" }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    // Only first dup-X and unique-Y should be moved
    expect(result.writesMoved).toBe(2);

    const tgtDir = join(COMBINE_CACHE_DIR, "writes", TARGET_KEY, PROMPT_HASH);
    const files = (await readdir(tgtDir)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);
  });

  it("re-keys orphaned revisions when feedback is deduplicated", async () => {
    const OTHER_WRITER = "opencode_kimi-k2";

    // Both source and target gave feedback on the same write (write-X)
    const srcFbDir = join(COMBINE_CACHE_DIR, "feedback", SOURCE_KEY);
    const tgtFbDir = join(COMBINE_CACHE_DIR, "feedback", TARGET_KEY);
    await writeJsonFile(srcFbDir, "write-X.json", makeCachedFeedback({ cacheId: "fb-free" }));
    await writeJsonFile(tgtFbDir, "write-X.json", makeCachedFeedback({ cacheId: "fb-paid" }));

    // Another writer model has a revision keyed by the source feedback's cacheId
    const otherRevDir = join(COMBINE_CACHE_DIR, "revisions", OTHER_WRITER);
    await writeJsonFile(otherRevDir, "fb-free.json", makeCachedRevision({
      cacheId: "rev-1",
      feedbackCacheId: "fb-free",
    }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    expect(result.feedbackDeduped).toBe(1);
    expect(result.revisionsRekeyed).toBe(1);

    // The orphaned revision should be re-keyed to the kept feedback's cacheId
    expect(existsSync(join(otherRevDir, "fb-free.json"))).toBe(false);
    expect(existsSync(join(otherRevDir, "fb-paid.json"))).toBe(true);

    // The revision's feedbackCacheId should be updated
    const rekeyed = JSON.parse(await readFile(join(otherRevDir, "fb-paid.json"), "utf-8"));
    expect(rekeyed.feedbackCacheId).toBe("fb-paid");
    expect(rekeyed.cacheId).toBe("rev-1"); // own cacheId preserved
  });

  it("deletes orphaned revision when kept feedback already has one", async () => {
    const OTHER_WRITER = "opencode_kimi-k2";

    // Both endpoints gave feedback on the same write
    const srcFbDir = join(COMBINE_CACHE_DIR, "feedback", SOURCE_KEY);
    const tgtFbDir = join(COMBINE_CACHE_DIR, "feedback", TARGET_KEY);
    await writeJsonFile(srcFbDir, "write-X.json", makeCachedFeedback({ cacheId: "fb-free" }));
    await writeJsonFile(tgtFbDir, "write-X.json", makeCachedFeedback({ cacheId: "fb-paid" }));

    // Writer has revisions for BOTH feedbacks
    const otherRevDir = join(COMBINE_CACHE_DIR, "revisions", OTHER_WRITER);
    await writeJsonFile(otherRevDir, "fb-free.json", makeCachedRevision({
      cacheId: "rev-from-free",
      feedbackCacheId: "fb-free",
    }));
    await writeJsonFile(otherRevDir, "fb-paid.json", makeCachedRevision({
      cacheId: "rev-from-paid",
      feedbackCacheId: "fb-paid",
    }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    expect(result.feedbackDeduped).toBe(1);
    expect(result.revisionsRekeyed).toBe(1);

    // The orphan should be deleted, the kept one preserved
    expect(existsSync(join(otherRevDir, "fb-free.json"))).toBe(false);
    expect(existsSync(join(otherRevDir, "fb-paid.json"))).toBe(true);

    const kept = JSON.parse(await readFile(join(otherRevDir, "fb-paid.json"), "utf-8"));
    expect(kept.cacheId).toBe("rev-from-paid"); // kept revision unchanged
  });

  it("re-keys revisions across multiple writer models", async () => {
    const WRITER_A = "opencode_kimi-k2";
    const WRITER_B = "opencode_gpt-5-nano";

    // Duplicate feedback
    const srcFbDir = join(COMBINE_CACHE_DIR, "feedback", SOURCE_KEY);
    const tgtFbDir = join(COMBINE_CACHE_DIR, "feedback", TARGET_KEY);
    await writeJsonFile(srcFbDir, "write-X.json", makeCachedFeedback({ cacheId: "fb-free" }));
    await writeJsonFile(tgtFbDir, "write-X.json", makeCachedFeedback({ cacheId: "fb-paid" }));

    // Both writers have revisions referencing the source feedback
    const revDirA = join(COMBINE_CACHE_DIR, "revisions", WRITER_A);
    const revDirB = join(COMBINE_CACHE_DIR, "revisions", WRITER_B);
    await writeJsonFile(revDirA, "fb-free.json", makeCachedRevision({
      cacheId: "rev-A",
      feedbackCacheId: "fb-free",
    }));
    await writeJsonFile(revDirB, "fb-free.json", makeCachedRevision({
      cacheId: "rev-B",
      feedbackCacheId: "fb-free",
    }));

    const result = await combineModelCaches(COMBINE_CACHE_DIR, SOURCE_KEY, TARGET_KEY);

    expect(result.revisionsRekeyed).toBe(2);

    // Both should be re-keyed
    const revA = JSON.parse(await readFile(join(revDirA, "fb-paid.json"), "utf-8"));
    expect(revA.feedbackCacheId).toBe("fb-paid");
    expect(revA.cacheId).toBe("rev-A");

    const revB = JSON.parse(await readFile(join(revDirB, "fb-paid.json"), "utf-8"));
    expect(revB.feedbackCacheId).toBe("fb-paid");
    expect(revB.cacheId).toBe("rev-B");
  });
});
