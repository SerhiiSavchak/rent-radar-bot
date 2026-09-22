import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import {
  ACQUIRED_RESPONSE_CAP_PER_CATEGORY,
  keepAcquiredByCategory,
} from "../src/delivery/catalog-sample.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import {
  assessRieltorWalk,
  formatRieltorCoverage,
} from "../src/sources/rieltor/rieltor-incremental.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

describe("acquired catalog cards", () => {
  it("keeps a card below the old top-10 when it was already in the response", () => {
    const listings = Array.from({ length: 15 }, (_, index) => ({
      propertyType: "apartment",
      sourceId: `a${index + 1}`,
    }));
    const kept = keepAcquiredByCategory(listings).kept;
    expect(kept.some((item) => item.sourceId === "a11")).toBe(true);
    expect(kept).toHaveLength(15);
  });

  it("keeps an OLX card past position 10 and does not let apartments hide houses", () => {
    const apartments = Array.from({ length: 51 }, (_, index) => ({
      propertyType: "apartment",
      sourceId: `a${index + 1}`,
    }));
    const houses = Array.from({ length: 36 }, (_, index) => ({
      propertyType: "house",
      sourceId: `h${index + 1}`,
    }));
    const kept = keepAcquiredByCategory([...apartments, ...houses]).kept;
    expect(kept.some((item) => item.sourceId === "a15")).toBe(true);
    expect(kept.some((item) => item.sourceId === "a28")).toBe(true);
    expect(kept.filter((item) => item.propertyType === "house")).toHaveLength(36);
    expect(kept).toHaveLength(87);
  });

  it("caps a runaway category without dropping the other category", () => {
    const apartments = Array.from({ length: ACQUIRED_RESPONSE_CAP_PER_CATEGORY + 1 }, (_, index) => ({
      propertyType: "apartment",
      sourceId: `a${index + 1}`,
    }));
    const houses = Array.from({ length: 4 }, (_, index) => ({
      propertyType: "house",
      sourceId: `h${index + 1}`,
    }));
    const acquired = keepAcquiredByCategory([...apartments, ...houses]);
    expect(acquired.truncated).toBe(true);
    expect(acquired.kept.filter((item) => item.propertyType === "apartment")).toHaveLength(
      ACQUIRED_RESPONSE_CAP_PER_CATEGORY,
    );
    expect(acquired.kept.filter((item) => item.propertyType === "house")).toHaveLength(4);
  });

  it("does not claim RIELTOR coverage when the page budget is reached first", () => {
    const coverage = assessRieltorWalk({
      mode: "catchup",
      plannedPages: [1, 2, 3],
      fetchedPages: [1, 2, 3],
      crossed: false,
      failed: false,
      catalogEnded: false,
      catchupTarget: "2026-09-22T10:00:00.000Z",
    });
    expect(coverage.boundaryReached).toBe(false);
    expect(coverage.coverageTruncated).toBe(true);
    expect(coverage.committed).toBeUndefined();
    expect(coverage.catchup).toEqual({
      target: "2026-09-22T10:00:00.000Z",
      resumePage: 4,
    });
    expect(
      formatRieltorCoverage({
        pagesFetched: 3,
        cardsFetched: 60,
        boundaryReached: false,
        coverageTruncated: true,
      }),
    ).toContain("coverageTruncated=true");
  });
});

describe("poller does not pass a tight catalog prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-sample-"));

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  it("leaves inspectLatest limit unset and records a truncated RIELTOR scan", async () => {
    const seen: Array<number | undefined> = [];
    const now = new Date("2026-09-22T12:00:00.000Z");
    const lun: ListingSourceAdapter = {
      source: "lun",
      fetchLatest: async () => [],
      inspectLatest: async (options): Promise<SourceFetchResult> => {
        seen.push(options?.limit);
        return {
          listings: [],
          transport: "test",
          dataKind: "MOCK DATA",
          resultKind: "valid_empty",
          httpStatus: 200,
          health: { source: "lun", healthy: true, checkedAt: now, message: "ok" },
        };
      },
      healthCheck: async () => ({ source: "lun", healthy: true, checkedAt: now }),
    };
    const rieltor: ListingSourceAdapter = {
      source: "rieltor",
      fetchLatest: async () => [],
      inspectLatest: async (): Promise<SourceFetchResult> => ({
        listings: [],
        transport: "test",
        dataKind: "MOCK DATA",
        resultKind: "valid_empty",
        httpStatus: 200,
        coverage: {
          pagesFetched: 3,
          cardsFetched: 60,
          boundaryReached: false,
          coverageTruncated: true,
        },
        health: { source: "rieltor", healthy: true, checkedAt: now, message: "ok" },
      }),
      healthCheck: async () => ({ source: "rieltor", healthy: true, checkedAt: now }),
    };
    const sink = {
      chatId: "1",
      dryRun: true,
      sendListing: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }),
      sendText: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }),
    } as unknown as TelegramTestSink;
    resetConfigCache();
    const config = loadConfig({
      OWNER_ONLY: "true",
      SELLER_POLICY: "reject_intermediaries",
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "true",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: "false",
      ENABLE_RIELTOR: "true",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
      TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
    });
    const path = join(dir, "sample.sqlite");
    const store = new DurableDeliveryStore(getDb(path));
    await runTelegramTestCycle(
      {
        adapters: [lun, rieltor],
        config,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
      },
      1,
    );
    expect(seen).toEqual([undefined]);
    const health = getDb().prepare(
      "SELECT status, last_error_safe AS errorSafe FROM source_health WHERE source = 'rieltor'",
    ).get() as { status: string; errorSafe: string | null };
    expect(health.status).toBe("coverage_degraded");
    expect(health.errorSafe).toContain("coverageTruncated=true");
    expect(health.errorSafe).toContain("boundaryReached=false");
  });
});
