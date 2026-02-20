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

/** Patterns that indicate a provider-level issue (rate limit or server error). */
const PROVIDER_ERROR_PATTERNS = [
  /too.many.requests/i,
  /rate.limit/i,
  /(?:status|code|error|returned|received|response|http)\s*:?\s*429\b/i,
  /(?:status|code|error|returned|received|response|http)\s*:?\s*5\d\d\b/i,
  /\b5\d\d\s+(?:internal|bad|service|gateway|server|error)/i,
  /overloaded/i,
  /server.error/i,
];

/**
 * Whether the error indicates a provider-level issue (rate limit, server
 * error, overloaded). Used by the circuit breaker to suspend models.
 * Unlike isRetryable(), this excludes output-quality errors like
 * MalformedOutputError and OutputTruncatedError.
 */
export function isProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ("statusCode" in err) {
    const code = (err as any).statusCode;
    if (code === 429 || (code >= 500 && code < 600)) return true;
  }
  // The AI SDK's APICallError sets isRetryable for 429/5xx responses.
  // Check it as a fallback when statusCode is missing (e.g. wrapped errors).
  if ("isRetryable" in err && (err as any).isRetryable === true) return true;
  const text = err.message + (("responseBody" in err) ? String((err as any).responseBody) : "");
  return PROVIDER_ERROR_PATTERNS.some((p) => p.test(text));
}

/**
 * Whether an error is worth retrying at the request level. Only covers
 * output-quality issues (truncated, malformed, empty). Provider errors
 * (429, 5xx) are NOT retried here -- they bubble immediately to the
 * circuit breaker which suspends the model.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof OutputTruncatedError) return true;
  if (err instanceof MalformedOutputError) return true;
  if (err.name === "AI_NoOutputGeneratedError") return true;
  if (err.name === "AI_NoObjectGeneratedError") return true;
  return false;
}

/** Minimal shape of a streamText result needed by safeStreamText. */
interface StreamResult {
  text: PromiseLike<string>;
  usage: PromiseLike<unknown>;
  finishReason: PromiseLike<string>;
}

/**
 * Run a streamText call with proper error capture.
 *
 * The AI SDK's default onError dumps the full error to console.error.
 * When streamText encounters a 429/5xx, result.text rejects with a
 * generic NoOutputGeneratedError -- NOT the original APICallError with
 * statusCode. The original error is ONLY delivered via onError.
 *
 * This captures it so the caller gets the original error (preserving
 * statusCode, responseBody, etc.) for proper circuit breaker detection.
 * Returns { text, result } so callers can still access usage/finishReason.
 */
export async function safeStreamText<R extends StreamResult>(
  factory: (handler: { onError: (ctx: { error: unknown }) => void }) => R,
): Promise<{ text: string; result: R }> {
  let captured: unknown;
  const result = factory({ onError: ({ error }) => { captured = error; } });
  const text = await Promise.resolve(result.text).catch((fallback) => {
    throw captured ?? fallback;
  });
  return { text, result };
}

/** Add +/-25% jitter to a delay to prevent thundering herd. */
export function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
}

/**
 * Retry an async operation with exponential backoff.
 * Only retries output-quality errors (isRetryable). Provider errors
 * (429, 5xx) are thrown immediately -- the circuit breaker at the
 * runner level handles model suspension.
 *
 * MalformedOutputError gets extra patience (5 attempts, 2s base) because
 * models often produce valid output on re-prompt.
 *
 * Console warnings (e.g. AI SDK "feature not supported") are buffered
 * during each attempt. On success, buffered warnings are dropped.
 * On final failure, warnings from the last attempt are replayed.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  /** Base delay multiplier in ms. Default 1000. Tests can pass 0. */
  baseDelayMs = 1000,
): Promise<T> {
  const originalWarn = console.warn;
  let buffered: unknown[][] = [];
  let effectiveMaxAttempts = maxAttempts;

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

      // Provider errors (429/5xx) are not retried -- the circuit breaker
      // handles them at the model level. Throw immediately.
      if (isProviderError(err)) {
        throw err;
      }

      // On first malformed output, escalate to 5 attempts -- models
      // often recover on re-prompt.
      if (err instanceof MalformedOutputError && effectiveMaxAttempts === maxAttempts) {
        effectiveMaxAttempts = Math.max(maxAttempts, 5);
      }

      if (attempt >= effectiveMaxAttempts || !isRetryable(err)) {
        // Final failure -- replay warnings for debugging
        for (const args of buffered) originalWarn(...args);
        throw err;
      }

      let delay: number;
      if (err instanceof MalformedOutputError) {
        // Longer base delay for malformed output (2x base, 15s cap)
        delay = Math.min(baseDelayMs * 2 * 2 ** (attempt - 1), 15_000);
      } else {
        delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 10_000);
      }
      await new Promise((r) => setTimeout(r, jitter(delay)));
    }
  }
}
