import { describe, expect, it } from "vitest";
import { resolveRieltorInspectKind } from "../src/sources/rieltor/rieltor-classify.ts";
import { decideRieltorTransientRetry, parseRetryAfterMs } from "../src/sources/rieltor/rieltor-retry.ts";

describe("RIELTOR bounded retry", () => {
  it("retries one 429 when Retry-After fits the cap", () => {
    const decision = decideRieltorTransientRetry({
      status: 429,
      networkError: false,
      retryAfterHeader: "2",
      attempt: 0,
    });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(2_000);
    expect(decision.reason).toBe("rate_limited");
  });

  it("does not wait when Retry-After would stall the poll", () => {
    const decision = decideRieltorTransientRetry({
      status: 429,
      networkError: false,
      retryAfterHeader: "120",
      attempt: 0,
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe("retry_after_exceeds_cap");
  });

  it("stops after the maximum retry", () => {
    const decision = decideRieltorTransientRetry({
      status: 503,
      networkError: false,
      attempt: 1,
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe("retry_budget_exhausted");
  });

  it("does not retry 403", () => {
    expect(
      decideRieltorTransientRetry({ status: 403, networkError: false, attempt: 0 }).retry,
    ).toBe(false);
  });

  it("retries a network failure once with the default spacing", () => {
    const decision = decideRieltorTransientRetry({ networkError: true, attempt: 0 });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(2_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("classifies an exhausted 429 as rate_limited even if earlier pages had cards", () => {
    expect(
      resolveRieltorInspectKind({
        parserFailure: false,
        httpError: true,
        blocked: false,
        rateLimited: true,
        uniqueCount: 4,
        sawStructure: true,
      }),
    ).toBe("rate_limited");
  });
});
