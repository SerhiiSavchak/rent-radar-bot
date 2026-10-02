import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { upsertSellerHold, hasSellerHold } from "../src/delivery/seller-verification-hold.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

const ESTABLISHED = new Date("2026-09-19T21:15:02.156Z");
const PREVIOUS_SUCCESS = new Date("2026-10-01T10:00:00.000Z");
const PUBLISHED_STALE = new Date("2026-09-29T14:41:20.000Z");
const PUBLISHED_NEW = new Date("2026-10-01T12:00:00.000Z");
const DISCOVERED = new Date("2026-10-01T18:22:09.748Z");
const RELEASED = new Date("2026-10-01T18:24:09.748Z");
const RIELTOR_URL = "https://rieltor.ua/lvov/flats-rent/view/777/";
const OWNER_HTML = `<div class="offer-view-rieltor-position">Власник</div>`;

function sampleListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "domria",
    sourceId: "4727172963",
    url: "https://dom.ria.com/uk/realty-4727172963.html",
    title: "Квартира біля центру",
    price: { amount: 12_000, currency: "UAH", period: "month" },
    location: {
      raw: "Львів, Галицький",
      city: "Львів",
      district: "Галицький",
      latitude: 49.84,
      longitude: 24.03,
    },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: DISCOVERED,
    publishedAt: PUBLISHED_STALE,
    metadata: { ownerEvidenceLevel: "platform_confirmed" },
    ...overrides,
  };
}

function linkedListing(publishedAt: Date): Listing {
  return sampleListing({
    source: "lun",
    sourceId: "4727172963",
    url: "https://lun.ua/uk/realty/4727172963",
    publishedAt,
    sellerType: "unknown",
    metadata: {
      originalUrl: RIELTOR_URL,
      aggregatedSite: "rieltor.ua",
      ownerEvidenceLevel: "private_unknown",
    },
  });
}

function adapter(source: Listing["source"], listings: Listing[]): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => listings,
    inspectLatest: async (): Promise<SourceFetchResult> => ({
      listings,
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: listings.length > 0 ? "ok" : "valid_empty",
      httpStatus: 200,
      health: {
        source,
        healthy: true,
        checkedAt: DISCOVERED,
        resultKind: "ok",
        httpStatus: 200,
        transport: "test",
      },
    }),
    healthCheck: async () => ({ source, healthy: true, checkedAt: DISCOVERED }),
  };
}

function config(extra: Record<string, string> = {}) {
  resetConfigCache();
  return loadConfig({
    OWNER_ONLY: "true",
    SELLER_POLICY: "reject_intermediaries",
    ENABLE_DOMRIA: "true",
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
    MAX_LISTING_AGE_MINUTES: String(7 * 24 * 60),
    ...extra,
  });
}

function sink() {
  return new TelegramTestSink({
    botToken: "1:token",
    chatId: "1",
    testMode: true,
    dryRun: false,
    timeoutMs: 1000,
    maxRetries: 0,
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
  });
}

function pinSellerPolicy(): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('seller_policy', 'reject_intermediaries')",
    )
    .run();
}

function holdJson(sourceId: string): Record<string, unknown> {
  const row = getDb()
    .prepare(
      "SELECT listing_json AS listingJson FROM seller_verification_holds WHERE source_id = ?",
    )
    .get(sourceId) as { listingJson: string };
  return JSON.parse(row.listingJson) as Record<string, unknown>;
}

describe("legacy seller holds and freshness provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-legacy-hold-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  function readyStore(path: string) {
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy();
    store.establishSilent("domria", [], store, ESTABLISHED);
    store.establishSilent("lun", [], store, ESTABLISHED);
    store.recordSuccess("domria", PREVIOUS_SUCCESS);
    store.recordSuccess("lun", PREVIOUS_SUCCESS);
    return store;
  }

  it("suppresses a legacy unmarked hold published before the previous complete poll", async () => {
    const path = dbPath();
    const store = readyStore(path);
    const stale = sampleListing();
    upsertSellerHold(getDb(path), stale, "legacy-stale", PREVIOUS_SUCCESS, "olx");

    const report = await runTelegramTestCycle({
      adapters: [adapter("domria", [])],
      config: config({ ENABLE_LUN: "false" }),
      sink: sink(),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => DISCOVERED,
    });

    expect(report.sentOk).toBe(0);
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(hasSellerHold(getDb(path), "domria", stale.sourceId)).toBe(false);
    expect(store.hasSeen(stale)).toBe(true);

    const again = await runTelegramTestCycle({
      adapters: [adapter("domria", [stale])],
      config: config({ ENABLE_LUN: "false" }),
      sink: sink(),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => new Date(DISCOVERED.getTime() + 60_000),
    });
    expect(again.sentOk).toBe(0);
    expect(again.suppressedLateDiscovered).toBe(0);
  });

  it("marks a hold created after the new freshness gate and still delivers it later", async () => {
    const path = dbPath();
    const store = readyStore(path);
    const fresh = linkedListing(PUBLISHED_NEW);
    let detailMode: "fail" | "owner" = "fail";
    const cycle = (at: Date, listings: Listing[]) =>
      runTelegramTestCycle({
        adapters: [adapter("lun", listings)],
        config: config({ ENABLE_DOMRIA: "false" }),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => at,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url) =>
          detailMode === "fail"
            ? { status: 503, finalUrl: url, bodyText: "" }
            : { status: 200, finalUrl: url, bodyText: OWNER_HTML },
      });

    const held = await cycle(DISCOVERED, [fresh]);
    expect(held.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "lun", fresh.sourceId)).toBe(true);
    const metadata = holdJson(fresh.sourceId).metadata as Record<string, unknown>;
    expect(metadata.freshnessGateVersion).toBe(2);
    expect(metadata.freshnessMonitoringBoundary).toBe(PREVIOUS_SUCCESS.toISOString());

    detailMode = "owner";
    const released = await cycle(RELEASED, [fresh]);
    expect(released.sentOk).toBe(1);
    expect(released.suppressedLateDiscovered).toBe(0);
    expect(hasSellerHold(getDb(path), "lun", fresh.sourceId)).toBe(false);
  });

  it("keeps a marked hold across restart and still delivers it", async () => {
    const path = dbPath();
    const store = readyStore(path);
    const fresh = linkedListing(PUBLISHED_NEW);
    fresh.sourceId = "restart-hold";
    fresh.url = "https://lun.ua/uk/realty/restart-hold";
    await runTelegramTestCycle({
      adapters: [adapter("lun", [fresh])],
      config: config({ ENABLE_DOMRIA: "false" }),
      sink: sink(),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => DISCOVERED,
      rieltorDetailGapMs: 0,
      fetchRieltorDetail: async (url) => ({ status: 503, finalUrl: url, bodyText: "" }),
    });
    closeDb();

    const reopened = new DurableDeliveryStore(getDb(path));
    const metadata = holdJson(fresh.sourceId).metadata as Record<string, unknown>;
    expect(metadata.freshnessGateVersion).toBe(2);
    expect(metadata.freshnessMonitoringBoundary).toBe(PREVIOUS_SUCCESS.toISOString());
    const released = await runTelegramTestCycle({
      adapters: [adapter("lun", [fresh])],
      config: config({ ENABLE_DOMRIA: "false" }),
      sink: sink(),
      dedupe: reopened,
      baseline: reopened,
      outbox: reopened,
      now: () => RELEASED,
      rieltorDetailGapMs: 0,
      fetchRieltorDetail: async (url) => ({ status: 200, finalUrl: url, bodyText: OWNER_HTML }),
    });
    expect(released.sentOk).toBe(1);
    expect(released.suppressedLateDiscovered).toBe(0);
  });

  it("keeps a legacy hold outside the global age cap as old_publication", async () => {
    const path = dbPath();
    const store = readyStore(path);
    const ancient = sampleListing({
      sourceId: "ancient-hold",
      url: "https://dom.ria.com/uk/realty-ancient-hold.html",
      publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    upsertSellerHold(getDb(path), ancient, "legacy-old", PREVIOUS_SUCCESS, "olx");

    const report = await runTelegramTestCycle({
      adapters: [adapter("domria", [])],
      config: config({ ENABLE_LUN: "false" }),
      sink: sink(),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => DISCOVERED,
    });

    expect(report.sentOk).toBe(0);
    expect(report.suppressedOld).toBe(1);
    expect(report.suppressedLateDiscovered).toBe(0);
    expect(hasSellerHold(getDb(path), "domria", ancient.sourceId)).toBe(false);
    expect(store.hasSeen(ancient)).toBe(true);
  });
});
