import { describe, expect, it } from "vitest";
import {
  CANONICAL_PRODUCTION_ENTRYPOINT,
  refuseUnsafeOneshot,
} from "../src/entry/production-entrypoint.ts";
import { ListingMonitorService } from "../src/services/listing-monitor.service.ts";

describe("production entrypoint", () => {
  it("refuses the phase0 oneshot so it cannot mark a listing seen before Telegram delivery", () => {
    const refusal = refuseUnsafeOneshot();
    expect(refusal.exitCode).toBe(2);
    expect(refusal.canonicalEntrypoint).toBe(CANONICAL_PRODUCTION_ENTRYPOINT);
    expect(refusal.canonicalEntrypoint).toBe("src/scripts/test-telegram-poll.ts");
    expect(refusal.message).toContain("SQLite outbox");
    expect(refusal.message).toContain("marked sent after Telegram");
  });

  it("does not persist a discovered listing from the old oneshot collector", async () => {
    const monitor = new ListingMonitorService([]);
    await expect(monitor.collectNewListings()).rejects.toThrow(/test-telegram-poll/);
  });
});
