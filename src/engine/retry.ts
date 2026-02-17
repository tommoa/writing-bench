/**
 * Thrown when a streaming response completes with finishReason "length",
 * meaning the output was truncated at the token limit.
 */
export class OutputTruncatedError extends Error {
  constructor() {
    super("Output truncated (finishReason: length)");
    this.name = "OutputTruncatedError";
  }
}

/**
 * Whether an error is worth retrying (transient API errors, empty output,
 * or truncated output).
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Output truncated at token limit
  if (err instanceof OutputTruncatedError) return true;
  // Empty output from streamText / generateObject
  if (err.name === "AI_NoOutputGeneratedError") return true;
  if (err.name === "AI_NoObjectGeneratedError") return true;
  // APICallError with isRetryable flag (429, 5xx, etc.)
  if ("isRetryable" in err && (err as any).isRetryable === true) return true;
  return false;
}

/**
 * Retry an async operation with exponential backoff.
 * Only retries errors where isRetryable() returns true.
 * Default: 3 attempts (1 initial + 2 retries), 1s/2s backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
