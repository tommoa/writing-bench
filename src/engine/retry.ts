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
 * Thrown when model output doesn't match the expected data shape
 * (missing JSON, schema validation failure). Worth retrying because
 * models often produce valid output on a subsequent attempt.
 */
export class MalformedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedOutputError";
  }
}

/** Rate-limit and server error patterns in error messages or response bodies. */
const RETRYABLE_PATTERNS = [
  /too.many.requests/i,
  /rate.limit/i,
  /\b429\b/,
  /\b5\d\d\b/,
  /overloaded/i,
  /server.error/i,
];

/**
 * Whether an error is worth retrying (transient API errors, empty output,
 * truncated output, or malformed output).
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Output truncated at token limit
  if (err instanceof OutputTruncatedError) return true;
  // Model output didn't match expected schema
  if (err instanceof MalformedOutputError) return true;
  // Empty output from streamText / generateObject
  if (err.name === "AI_NoOutputGeneratedError") return true;
  if (err.name === "AI_NoObjectGeneratedError") return true;
  // APICallError with isRetryable flag (429, 5xx, etc.)
  if ("isRetryable" in err && (err as any).isRetryable === true) return true;
  // In-stream errors (e.g. SSE error events with type: "too_many_requests")
  // don't get the isRetryable flag -- match by message or response body.
  const text = err.message + (("responseBody" in err) ? String((err as any).responseBody) : "");
  if (RETRYABLE_PATTERNS.some((p) => p.test(text))) return true;
  return false;
}

/**
 * Retry an async operation with exponential backoff.
 * Only retries errors where isRetryable() returns true.
 * Default: 3 attempts (1 initial + 2 retries), 1s/2s backoff.
 *
 * Console warnings (e.g. AI SDK "feature not supported") are buffered
 * during each attempt. On success, buffered warnings are dropped.
 * On final failure, warnings from the last attempt are replayed.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  const originalWarn = console.warn;
  let buffered: unknown[][] = [];

  for (let attempt = 1; ; attempt++) {
    buffered = [];
    console.warn = (...args: unknown[]) => { buffered.push(args); };
    try {
      const result = await fn();
      // Success -- drop warnings (transient noise from retried attempts)
      console.warn = originalWarn;
      return result;
    } catch (err) {
      console.warn = originalWarn;
      if (attempt >= maxAttempts || !isRetryable(err)) {
        // Final failure -- replay warnings for debugging
        for (const args of buffered) originalWarn(...args);
        throw err;
      }
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
