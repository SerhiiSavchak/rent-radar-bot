/**
 * The poll loop must not overlap cycles.
 * When a cycle finishes early, wait only the remainder of the interval
 * measured from that cycle's start. A cycle longer than the interval
 * starts the next one immediately.
 */
export function waitMsUntilNextPollStart(elapsedMs: number, intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return 0;
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return intervalMs;
  }
  return Math.max(0, intervalMs - elapsedMs);
}
