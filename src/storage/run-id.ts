const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** Return whether a value is safe to use as a single run path segment. */
export function isValidRunId(runId: string): boolean {
  if (!RUN_ID_PATTERN.test(runId)) return false;
  const basename = runId.split(".", 1)[0];
  return !WINDOWS_DEVICE_NAME_PATTERN.test(basename);
}

/** Reject a run ID that cannot be used as a single run path segment. */
export function assertValidRunId(runId: string): void {
  if (!isValidRunId(runId)) {
    throw new Error(
      "Invalid run ID: expected 1-128 lowercase portable filename characters, starting and ending with a letter or digit",
    );
  }
}
