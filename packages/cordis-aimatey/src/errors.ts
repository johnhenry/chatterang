/**
 * aimatey's error taxonomy, translated into DSH's.
 *
 * This table is load-bearing rather than cosmetic. `LlmRuntime` normalizes a
 * value thrown by an adapter through `normalizeLlmFailure`, and that function
 * trusts only `HarnessError`-derived codes: a plain `Error` carrying
 * `.code = 'RATE_LIMIT'` arrives downstream as `UNKNOWN`
 * (dsh-llm/lib/types/adapter-failure.js, `harnessErrorCode`). So an aimatey
 * `AdapterError` has to be re-thrown as an `LlmError` whose code is one DSH
 * already routes on, or the failure class is lost between the provider and the
 * retry policy that decides whether to try again.
 *
 * Unmapped codes pass through as their literal aimatey string rather than
 * collapsing to `UNKNOWN`. A real-but-unrecognised code is diagnostic;
 * `UNKNOWN` is not. `tests/cordis-aimatey.test.ts` asserts that every member of
 * aimatey's `ErrorCode` object is either mapped here or named in
 * {@link PASS_THROUGH_CODES}, so a new aimatey code cannot slip in unnoticed.
 */

/**
 * aimatey `ErrorCode` -> DSH failure code.
 *
 * The DSH side of each row is a code the harness already routes on: the
 * canonical ones are exported by dsh-llm (`CONTEXT_WINDOW_EXCEEDED`, `QUOTA`,
 * `EMPTY_RESPONSE`, `INVALID_CREDENTIAL`), and the rest — `RATE_LIMIT`,
 * `SERVER`, `TIMEOUT`, `TRANSPORT` — are the members of the default retryable
 * set that `resolveRetryPolicy()` produces.
 */
export const AIMATEY_TO_DSH_CODE: Readonly<Record<string, string>> = Object.freeze({
  CONTEXT_LENGTH_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  QUOTA_EXCEEDED: 'QUOTA',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT',
  INVALID_API_KEY: 'INVALID_CREDENTIAL',
  EXPIRED_API_KEY: 'INVALID_CREDENTIAL',
  MISSING_API_KEY: 'MISSING_CREDENTIAL',
  STREAM_CANCELLED: 'ABORTED',
  PROVIDER_TIMEOUT: 'TIMEOUT',
  CONNECTION_TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'TRANSPORT',
  DNS_RESOLUTION_FAILED: 'TRANSPORT',
  PROVIDER_ERROR: 'SERVER',
  PROVIDER_UNAVAILABLE: 'SERVER',
  PROVIDER_OVERLOADED: 'SERVER',
});

/**
 * aimatey codes deliberately left to pass through unchanged.
 *
 * Each of these is already a clear description of what went wrong, and DSH has
 * no closer equivalent. Translating `INVALID_MESSAGE_FORMAT` into a generic
 * `INVALID_ARGS`, say, would trade a precise code for a vague one — the retry
 * policy treats both as non-retryable either way, so the only thing the
 * translation would change is how much a reader learns from the log line.
 *
 * Listing them explicitly (rather than letting the default branch cover them
 * silently) is what lets the coverage test tell "we decided this passes
 * through" apart from "nobody has looked at this code yet".
 */
export const PASS_THROUGH_CODES: readonly string[] = Object.freeze([
  'INSUFFICIENT_PERMISSIONS',
  'INVALID_REQUEST',
  'INVALID_MESSAGE_FORMAT',
  'INVALID_PARAMETERS',
  'UNSUPPORTED_MODEL',
  'UNSUPPORTED_FEATURE',
  'MAX_TOOL_ITERATIONS_EXCEEDED',
  'ADAPTER_CONVERSION_ERROR',
  'ADAPTER_VALIDATION_ERROR',
  'UNSUPPORTED_CONVERSION',
  'SEMANTIC_DRIFT_ERROR',
  'STREAM_ERROR',
  'STREAM_INTERRUPTED',
  'STREAM_PARSE_ERROR',
  'NO_BACKEND_AVAILABLE',
  'ROUTING_FAILED',
  'ALL_BACKENDS_FAILED',
  'MIDDLEWARE_ERROR',
  'UNKNOWN_ERROR',
  'INTERNAL_ERROR',
]);

/**
 * Translate one aimatey error code into the DSH code to throw it under.
 *
 * @param code - the aimatey `ErrorCode` member, or any provider string.
 * @returns the DSH code, or `code` itself when no translation applies.
 */
export function mapCode(code: string): string {
  if (code.length === 0) return 'UNKNOWN';
  return AIMATEY_TO_DSH_CODE[code] ?? code;
}
