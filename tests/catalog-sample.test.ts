import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import {
  catalogSampleLimit,
  keepBalancedCatalogSample,
} from "../src/delivery/catalog-sample.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { rieltorCategoryWindow } from "../src/sources/rieltor/rieltor.source.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

describe("catalog sample depth", () => {
  it("keeps the measured first response instead of a global prefix of 10", () => {
    const limit = catalogSampleLimit(2);
    expect(limit).toBeGreaterThanOrEqual(24 * 2);
    expect(Math.ceil(limit / 2)).toBeGreaterThanOrEqual(51);
    const apartments = Array.from({ length: 51 }, (_, index) => ({
      propertyType: "apartment",
      sourceId: `a${index + 1}`,
    }));
    const houses = Array.from({ length: 36 }, (_, index) => ({
      propertyType: "house",
      sourceId: `h${index + 1}`,
    }));
    const kept = keepBalancedCatalogSample([...apartments, ...houses], limit);
    expect(kept.some((item) => item.sourceId === "a28")).toBe(true);
    expect(kept.some((item) => item.sourceId === "a51")).toBe(true);
    expect(kept.filter((item) => item.propertyType === "house")).toHaveLength(36);
    expect(kept).toHaveLength(87);
  });

  it("keeps a same-day RIELTOR card from page 2 without opening a third page", () => {
    const window = rieltorCategoryWindow(catalogSampleLimit(2), 2);
    expect(window.pages).toBe(2);
    expect(window.keep).toBeGreaterThanOrEqual(35);
    expect(window.keep).toBeLessThanOrEqual(40);
  });
});

describe("poller requests the catalog sample", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-sample-"));

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  it("passes the catalog sample limit into inspectLatest", async () => {
    const seen: number[] = [];
    const now = new Date("2026-09-22T12:00:00.000Z");
    const adapter: ListingSourceAdapter = {
      source: "lun",
      fetchLatest: async () => [],
      inspectLatest: async (options): Promise<SourceFetchResult> => {
        if (options?.limit !== undefined) seen.push(options.limit);
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
      ENABLE_RIELTOR: "false",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
      TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
    });
    const store = new DurableDeliveryStore(getDb(join(dir, "sample.sqlite")));
    await runTelegramTestCycle(
      {
        adapters: [adapter],
        config,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
      },
      1,
    );
    expect(seen).toEqual([catalogSampleLimit()]);
  });
});
