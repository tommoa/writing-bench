import { describe, it, expect } from "bun:test";
import type { Need } from "./need-identifier.js";
import type { ModelConfig } from "../types.js";
import { settledPool, tagModel, needModels } from "./runner.js";

// ── Helper factories ────────────────────────────────

function makeModelConfig(label: string): ModelConfig {
  return {
    provider: "openai",
    model: label,
    label,
    registryId: `openai:${label}`,
  };
}

function makeInitialNeed(modelA: string, modelB: string, judge: string): Need {
  return {
    type: "initial_judgment",
    modelA,
    modelB,
    outputIdxA: 0,
    outputIdxB: 0,
    promptId: "p1",
    judgeModel: makeModelConfig(judge),
    score: 1,
  };
}

function makeImprovementNeed(writer: string, fb: string, judge: string): Need {
  return {
    type: "improvement_judgment",
    writer,
    outputIdx: 0,
    feedbackModel: fb,
    againstFeedbackModel: "other-fb",
    promptId: "p1",
    judgeModel: makeModelConfig(judge),
    score: 1,
  };
}

function makeRevisedNeed(modelA: string, modelB: string, fb: string, judge: string): Need {
  return {
    type: "revised_judgment",
    modelA,
    modelB,
    outputIdxA: 0,
    outputIdxB: 0,
    feedbackModel: fb,
    promptId: "p1",
    judgeModel: makeModelConfig(judge),
    score: 1,
  };
}

// ── settledPool ─────────────────────────────────────

describe("settledPool", () => {
  it("processes all items", async () => {
    const results: number[] = [];
    await settledPool(3, [1, 2, 3, 4, 5], async (n) => {
      results.push(n);
    });
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("limits concurrency to the specified limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    await settledPool(2, [1, 2, 3, 4], async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    });
    expect(maxConcurrent).toBe(2);
  });

  it("continues after errors", async () => {
    const results: number[] = [];
    await settledPool(2, [1, 2, 3], async (n) => {
      if (n === 2) throw new Error("fail");
      results.push(n);
    });
    expect(results.sort()).toEqual([1, 3]);
  });

  it("handles empty array", async () => {
    await settledPool(5, [], async () => {
      throw new Error("should not be called");
    });
  });

  it("handles limit larger than items", async () => {
    const results: number[] = [];
    await settledPool(100, [1, 2, 3], async (n) => {
      results.push(n);
    });
    expect(results.sort()).toEqual([1, 2, 3]);
  });

  it("processes items in order when limit is 1", async () => {
    const results: number[] = [];
    await settledPool(1, [1, 2, 3, 4], async (n) => {
      results.push(n);
    });
    expect(results).toEqual([1, 2, 3, 4]);
  });

});

// ── tagModel ────────────────────────────────────────

describe("tagModel", () => {
  it("passes through successful results", async () => {
    const result = await tagModel("model-a", Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("tags errors with failedModel", async () => {
    const err = new Error("api error");
    try {
      await tagModel("model-a", Promise.reject(err));
    } catch (e: any) {
      expect(e.failedModel).toBe("model-a");
      expect(e.message).toBe("api error");
      return;
    }
    throw new Error("should have thrown");
  });

  it("preserves existing failedModel from inner wrapper", async () => {
    const err = Object.assign(new Error("api error"), { failedModel: "model-b" });
    try {
      await tagModel("model-a", Promise.reject(err));
    } catch (e: any) {
      // Inner (closer to the API call) attribution is preserved;
      // the outermost wrapper does not overwrite it
      expect(e.failedModel).toBe("model-b");
      return;
    }
    throw new Error("should have thrown");
  });

  it("does not tag non-Error rejections", async () => {
    try {
      await tagModel("model-a", Promise.reject("string error"));
    } catch (e) {
      expect(e).toBe("string error");
      expect((e as any).failedModel).toBeUndefined();
      return;
    }
    throw new Error("should have thrown");
  });
});

// ── needModels ──────────────────────────────────────

describe("needModels", () => {
  it("returns modelA, modelB, judge for initial_judgment", () => {
    const need = makeInitialNeed("a", "b", "judge");
    expect(needModels(need).sort()).toEqual(["a", "b", "judge"].sort());
  });

  it("returns writer, feedbackModel, judge for improvement_judgment", () => {
    const need = makeImprovementNeed("writer", "fb", "judge");
    expect(needModels(need).sort()).toEqual(["fb", "judge", "writer"].sort());
  });

  it("returns modelA, modelB, feedbackModel, judge for revised_judgment", () => {
    const need = makeRevisedNeed("a", "b", "fb", "judge");
    expect(needModels(need).sort()).toEqual(["a", "b", "fb", "judge"].sort());
  });
});

// ── dedup pattern ───────────────────────────────────

describe("dedup cleanup pattern", () => {
  it("cleans up map on fulfillment with .then(cleanup, cleanup)", async () => {
    const map = new Map<string, Promise<string>>();
    const promise = Promise.resolve("ok");
    map.set("key", promise);
    const cleanup = () => { map.delete("key"); };
    promise.then(cleanup, cleanup);
    await promise;
    // Allow microtask to run
    await new Promise((r) => setTimeout(r, 0));
    expect(map.has("key")).toBe(false);
  });

  it("cleans up map on rejection with .then(cleanup, cleanup)", async () => {
    const map = new Map<string, Promise<string>>();
    const promise = Promise.reject(new Error("fail"));
    map.set("key", promise);
    const cleanup = () => { map.delete("key"); };
    promise.then(cleanup, cleanup);
    // Handle the rejection from the caller side
    await promise.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(map.has("key")).toBe(false);
  });

  it("does not create unhandled rejection with .then(cleanup, cleanup)", async () => {
    // This test verifies the fix for the dedup crash.
    // With .finally(), a rejected promise creates a floating derived
    // promise that re-rejects with no handler, crashing Bun.
    // With .then(cleanup, cleanup), both handlers return undefined,
    // so the derived promise always fulfills.
    const map = new Map<string, Promise<string>>();
    const promise = Promise.reject(new Error("test rejection"));
    map.set("key", promise);
    const cleanup = () => { map.delete("key"); };
    // This should NOT create an unhandled rejection
    promise.then(cleanup, cleanup);
    // Handle the original rejection
    await promise.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(map.has("key")).toBe(false);
    // If we reach here without process crash, the fix works
  });

  it("coalesces concurrent callers", async () => {
    const map = new Map<string, Promise<string>>();
    let callCount = 0;

    function dedup(key: string, fn: () => Promise<string>): Promise<string> {
      const inflight = map.get(key);
      if (inflight) return inflight;
      const promise = fn();
      map.set(key, promise);
      const cleanup = () => { map.delete(key); };
      promise.then(cleanup, cleanup);
      return promise;
    }

    const fn = async () => {
      callCount++;
      return "result";
    };

    // Two concurrent calls for the same key
    const [r1, r2] = await Promise.all([
      dedup("k", fn),
      dedup("k", fn),
    ]);

    expect(r1).toBe("result");
    expect(r2).toBe("result");
    expect(callCount).toBe(1); // Only one actual call
  });
});
