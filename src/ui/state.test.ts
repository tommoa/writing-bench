import { describe, it, expect } from "bun:test";
import type { BenchmarkProgress } from "../types.js";
import { INITIAL_STATE, appReducer, benchmarkEventToAction } from "./state.js";

describe("benchmarkEventToAction", () => {
  it("maps progress events", () => {
    const progress = makeProgress();
    const action = benchmarkEventToAction({ type: "progress", data: progress });
    expect(action).toEqual({ type: "BENCHMARK_PROGRESS", progress });
  });

  it("maps complete events", () => {
    const action = benchmarkEventToAction({
      type: "complete",
      data: makeRunResult(),
    });
    expect(action).toEqual({ type: "BENCHMARK_COMPLETE" });
  });

  it("maps error events", () => {
    const action = benchmarkEventToAction({
      type: "error",
      data: { message: "boom" },
    });
    expect(action).toEqual({ type: "BENCHMARK_ERROR", message: "boom" });
  });
});

describe("appReducer", () => {
  it("returns to configure on early benchmark error", () => {
    const runningState = appReducer(INITIAL_STATE, { type: "BENCHMARK_START" });
    const next = appReducer(runningState, {
      type: "BENCHMARK_ERROR",
      message: "bad config",
    });
    expect(next.benchmark.mode).toBe("configure");
    expect(next.benchmark.error).toBe("bad config");
  });

  it("keeps complete mode on benchmark error after progress", () => {
    const runningState = appReducer(INITIAL_STATE, { type: "BENCHMARK_START" });
    const progressedState = appReducer(runningState, {
      type: "BENCHMARK_PROGRESS",
      progress: makeProgress({ stageDone: 1 }),
    });
    const next = appReducer(progressedState, {
      type: "BENCHMARK_ERROR",
      message: "partial failure",
    });
    expect(next.benchmark.mode).toBe("complete");
    expect(next.benchmark.error).toBe("partial failure");
  });

  it("clears pending confirm prompts when switching tabs", () => {
    const withPrompts = {
      ...INITIAL_STATE,
      cache: {
        ...INITIAL_STATE.cache,
        confirmAction: { type: "trim" as const, model: "foo" },
      },
      runs: {
        ...INITIAL_STATE.runs,
        confirmDelete: "run-1",
      },
    };
    const next = appReducer(withPrompts, { type: "SET_TAB", tab: "runs" });
    expect(next.cache.confirmAction).toBeNull();
    expect(next.runs.confirmDelete).toBeNull();
  });

  it("stores merge cache confirmation payload", () => {
    const next = appReducer(INITIAL_STATE, {
      type: "CACHE_CONFIRM",
      action: {
        type: "merge",
        sourceModel: "openai__gpt-4o-mini",
        targetModel: "openai__gpt-4o",
        targetSpec: "openai:gpt-4o",
      },
    });

    expect(next.cache.confirmAction).toEqual({
      type: "merge",
      sourceModel: "openai__gpt-4o-mini",
      targetModel: "openai__gpt-4o",
      targetSpec: "openai:gpt-4o",
    });
  });
});

function makeProgress(overrides: Partial<BenchmarkProgress> = {}): BenchmarkProgress {
  return {
    stage: "initialWriting",
    activeStages: [],
    stageProgress: 0,
    stageDone: 0,
    currentOp: "Starting...",
    elo: { initial: [], revised: [], feedback: [] },
    totalCost: 0,
    totalCostUncached: 0,
    costByModel: {},
    costByStage: {},
    costByModelByStage: {},
    speedByModel: {},
    speedByModelByStage: {},
    cacheSavings: {
      writes: { cached: 0, fresh: 0, savedCost: 0 },
      feedback: { cached: 0, fresh: 0, savedCost: 0 },
      revisions: { cached: 0, fresh: 0, savedCost: 0 },
      judgments: { cached: 0, fresh: 0, savedCost: 0 },
    },
    ...overrides,
  };
}

function makeRunResult() {
  return {
    config: {
      id: "run-1",
      models: [],
      prompts: [],
      outputsPerModel: 0,
      reasoning: true,
      noCache: false,
      cacheOnly: false,
      skipSeeding: false,
      timestamp: new Date().toISOString(),
      concurrency: 1,
      convergence: {
        ciThreshold: 0,
        maxRounds: 1,
        minPairsPerModel: 2,
        writingWeight: 1,
        feedbackWeight: 0.25,
        revisedWeight: 0.4,
        judgeQuality: true,
        judgeQualityMode: "consensus" as const,
        judgeDecay: 0.03,
        judgePruneThreshold: 0.5,
      },
    },
    samples: [],
    feedback: [],
    judgments: [],
    elo: {
      initial: { stage: "initial" as const, ratings: [] },
      revised: { stage: "revised" as const, ratings: [] },
    },
    meta: {
      totalTokens: 0,
      totalCost: 0,
      totalCostUncached: 0,
      costByModel: {},
      costByStage: {},
      costByModelByStage: {},
      speedByModel: {},
      durationMs: 0,
      terminationReason: "converged" as const,
      converged: true,
      roundsCompleted: 0,
    },
    modelInfo: {},
  };
}
