/** One extra attempt. A RIELTOR problem must not stall the global poll. */
export const RIELTOR_MAX_TRANSIENT_RETRIES = 1;
export const RIELTOR_RETRY_DELAY_CAP_MS = 3_000;
export const RIELTOR_DEFAULT_RETRY_DELAY_MS = 2_000;

export function parseRetryAfterMs(header: string | undefined, nowMs = Date.now()): number | undefined {
  if (!header) {
    return undefined;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return Math.max(0, parsed - nowMs);
}

export function decideRieltorTransientRetry(input: {
  status?: number | undefined;
  networkError: boolean;
  retryAfterHeader?: string | undefined;
  attempt: number;
  nowMs?: number | undefined;
  maxRetries?: number | undefined;
  capMs?: number | undefined;
  defaultDelayMs?: number | undefined;
}): { retry: boolean; delayMs: number; reason: string } {
  const maxRetries = input.maxRetries ?? RIELTOR_MAX_TRANSIENT_RETRIES;
  const capMs = input.capMs ?? RIELTOR_RETRY_DELAY_CAP_MS;
  const defaultDelayMs = input.defaultDelayMs ?? RIELTOR_DEFAULT_RETRY_DELAY_MS;
  if (input.attempt >= maxRetries) {
    return { retry: false, delayMs: 0, reason: "retry_budget_exhausted" };
  }
  const serverError = input.status !== undefined && input.status >= 500;
  const transient = input.networkError || input.status === 429 || input.status === 408 || serverError;
  if (!transient) {
    return { retry: false, delayMs: 0, reason: "not_transient" };
  }
  const retryAfterMs = parseRetryAfterMs(input.retryAfterHeader, input.nowMs);
  if (retryAfterMs !== undefined && retryAfterMs > capMs) {
    return { retry: false, delayMs: 0, reason: "retry_after_exceeds_cap" };
  }
  const delayMs = Math.min(capMs, retryAfterMs ?? defaultDelayMs);
  const reason = input.status === 429 ? "rate_limited" : input.networkError ? "network" : "server_error";
  return { retry: true, delayMs, reason };
}
