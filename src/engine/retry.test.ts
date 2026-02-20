import { describe, it, expect } from "bun:test";
import {
  isProviderError,
  isRetryable,
  jitter,
  withRetry,
  MalformedOutputError,
  OutputTruncatedError,
} from "./retry.js";

// ── isProviderError ─────────────────────────────────

describe("isProviderError", () => {
  it("returns true for statusCode 429", () => {
    const err = Object.assign(new Error("too many requests"), { statusCode: 429 });
    expect(isProviderError(err)).toBe(true);
  });

  it("returns true for statusCode 500", () => {
    const err = Object.assign(new Error("internal server error"), { statusCode: 500 });
    expect(isProviderError(err)).toBe(true);
  });

  it("returns true for statusCode 503", () => {
    const err = Object.assign(new Error("service unavailable"), { statusCode: 503 });
    expect(isProviderError(err)).toBe(true);
  });

  it("returns true for 'rate limit' in message", () => {
    const err = new Error("rate limit exceeded");
    expect(isProviderError(err)).toBe(true);
  });

  it("returns true for 'overloaded' in message", () => {
    const err = new Error("model is overloaded");
    expect(isProviderError(err)).toBe(true);
  });

  it("returns true for '429' in message", () => {
    const err = new Error("received 429 from API");
    expect(isProviderError(err)).toBe(true);
  });

  it("returns true for '502' in message", () => {
    const err = new Error("upstream returned 502");
    expect(isProviderError(err)).toBe(true);
  });

  it("returns true for '500 Internal Server Error' in message", () => {
    const err = new Error("500 Internal Server Error");
    expect(isProviderError(err)).toBe(true);
  });

  it("returns false for incidental 5xx-like numbers in message", () => {
    const err = new Error("processed 512 tokens successfully");
    expect(isProviderError(err)).toBe(false);
  });

  it("returns true for AI SDK isRetryable flag", () => {
    const err = Object.assign(new Error("request failed"), { isRetryable: true });
    expect(isProviderError(err)).toBe(true);
  });

  it("returns false for MalformedOutputError", () => {
    const err = new MalformedOutputError("bad json");
    expect(isProviderError(err)).toBe(false);
  });

  it("returns false for OutputTruncatedError", () => {
    const err = new OutputTruncatedError();
    expect(isProviderError(err)).toBe(false);
  });

  it("returns false for generic error", () => {
    const err = new Error("something went wrong");
    expect(isProviderError(err)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isProviderError("string error")).toBe(false);
    expect(isProviderError(null)).toBe(false);
    expect(isProviderError(undefined)).toBe(false);
  });

  it("detects provider error in responseBody", () => {
    const err = Object.assign(new Error("API error"), {
      responseBody: '{"error": "too many requests"}',
    });
    expect(isProviderError(err)).toBe(true);
  });
});

// ── jitter ──────────────────────────────────────────

describe("jitter", () => {
  it("returns a value within +/-25% of input", () => {
    // Run many times to check bounds probabilistically
    for (let i = 0; i < 100; i++) {
      const result = jitter(1000);
      expect(result).toBeGreaterThanOrEqual(750);
      expect(result).toBeLessThanOrEqual(1250);
    }
  });

  it("returns 0 for 0 input", () => {
    // 0 * anything = 0
    expect(jitter(0)).toBe(0);
  });
});

// ── withRetry ───────────────────────────────────────

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(async () => "ok");
    expect(result).toBe("ok");
  });

  it("retries retryable errors up to maxAttempts", async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new OutputTruncatedError();
    }, 3, 0)).rejects.toThrow(OutputTruncatedError);
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new Error("not retryable");
    }, 3, 0)).rejects.toThrow("not retryable");
    expect(attempts).toBe(1);
  });

  it("succeeds after transient failures", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new OutputTruncatedError();
      return "recovered";
    }, 3, 0);
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("escalates to 5 attempts for MalformedOutputError", async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new MalformedOutputError("bad json");
    }, 3, 0)).rejects.toThrow(MalformedOutputError);
    expect(attempts).toBe(5);
  });

  it("succeeds on attempt 4 with MalformedOutputError escalation", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 4) throw new MalformedOutputError("bad json");
      return "recovered";
    }, 3, 0);
    expect(result).toBe("recovered");
    expect(attempts).toBe(4);
  });

  it("does not escalate non-MalformedOutputError beyond maxAttempts", async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new OutputTruncatedError();
    }, 3, 0)).rejects.toThrow(OutputTruncatedError);
    expect(attempts).toBe(3);
  });

  it("does not retry provider errors", async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw Object.assign(new Error("rate limit exceeded"), { statusCode: 429 });
    }, 3, 0)).rejects.toThrow("rate limit exceeded");
    // Provider errors bypass retry -- only 1 attempt
    expect(attempts).toBe(1);
  });

  it("does not retry 5xx provider errors", async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw Object.assign(new Error("internal server error"), { statusCode: 500 });
    }, 3, 0)).rejects.toThrow("internal server error");
    expect(attempts).toBe(1);
  });

  it("replays warnings for non-provider errors", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await withRetry(async () => {
        console.warn("some SDK warning");
        throw new MalformedOutputError("bad json");
      }, 2, 0).catch(() => {});
      // Non-provider error -- warnings SHOULD be replayed
      // MalformedOutputError escalates to 5 attempts, so we get warnings
      // from the final attempt replayed
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});
