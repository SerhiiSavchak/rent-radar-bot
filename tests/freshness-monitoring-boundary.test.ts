import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { InMemoryListingDedupe } from "../src/delivery/listing-dedupe-memory.ts";
import { InMemorySourceBaseline } from "../src/delivery/source-baseline-memory.ts";
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
const DEGRADED_AT = new Date("2026-10-01T16:00:00.000Z");

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

function adapter(
  listings: Listing[],
  mode: "ok" | "degraded" = "ok",
): ListingSourceAdapter {
  return {
    source: "domria",
    fetchLatest: async () => listings,
    inspectLatest: async (): Promise<SourceFetchResult> => ({
      listings,
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: "ok",
      httpStatus: 200,
      ...(mode === "degraded"
        ? {
            coverage: {
              pagesFetched: 2,
              cardsFetched: listings.length,
              boundaryReached: false,
              coverageTruncated: true,
            },
          }
        : {}),
      health: {
        source: "domria",
        healthy: mode === "ok",
        checkedAt: DISCOVERED,
        resultKind: "ok",
        httpStatus: 200,
        transport: "test",
      },
    }),
    healthCheck: async () => ({ source: "domria", healthy: true, checkedAt: DISCOVERED }),
  };
}

function config() {
  resetConfigCache();
  return loadConfig({
    OWNER_ONLY: "true",
    SELLER_POLICY: "reject_intermediaries",
    ENABLE_DOMRIA: "true",
    ENABLE_LUN: "false",
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
  });
}

function sink() {
  return new TelegramTestSink({
    botToken: "1:token",
    chatId: "1",
    testMode: true,
    dryRun: true,
    timeoutMs: 1000,
    maxRetries: 0,
  });
}

function pinSellerPolicy(appliedAt?: Date): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('seller_policy', 'reject_intermediaries')").run();
  if (appliedAt) {
    db.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('seller_policy_applied_at', ?)",
    ).run(appliedAt.toISOString());
  }
}

function storedLastSuccess(): string | undefined {
  const row = getDb()
    .prepare("SELECT last_success_at AS lastSuccessAt FROM source_baselines WHERE source = 'domria'")
    .get() as { lastSuccessAt: string } | undefined;
  return row?.lastSuccessAt;
}

describe("freshness monitoring boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-freshness-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  it("suppresses a within-window listing published before the previous complete poll", async () => {
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const stale = sampleListing();
    baseline.establishSilent("domria", [], dedupe, ESTABLISHED);
    baseline.recordSuccess("domria", PREVIOUS_SUCCESS);

    const report = await runTelegramTestCycle({
      adapters: [adapter([stale])],
      config: config(),
      sink: sink(),
      dedupe,
      baseline,
      now: () => DISCOVERED,
    });

    expect(report.sentOk).toBe(0);
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(report.suppressedOld).toBe(0);
    expect(dedupe.hasSeen(stale)).toBe(true);
  });

  it("delivers a listing published after the previous complete poll and before this cycle", async () => {
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const fresh = sampleListing({
      sourceId: "fresh-1",
      url: "https://dom.ria.com/uk/realty-fresh-1.html",
      publishedAt: PUBLISHED_NEW,
    });
    baseline.establishSilent("domria", [], dedupe, ESTABLISHED);
    baseline.recordSuccess("domria", PREVIOUS_SUCCESS);

    const report = await runTelegramTestCycle({
      adapters: [adapter([fresh])],
      config: config(),
      sink: sink(),
      dedupe,
      baseline,
      now: () => DISCOVERED,
    });

    expect(report.sentOk).toBe(1);
    expect(report.suppressedLateDiscovered).toBe(0);
    expect(report.deliveryMode).toBe("send_new");
  });

  it("does not move last_success_at on coverage_degraded and still classifies against the previous poll", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy();
    store.establishSilent("domria", [], store, ESTABLISHED);
    store.recordSuccess("domria", PREVIOUS_SUCCESS);
    const stale = sampleListing();
    const fresh = sampleListing({
      sourceId: "between",
      url: "https://dom.ria.com/uk/realty-between.html",
      publishedAt: PUBLISHED_NEW,
    });

    const report = await runTelegramTestCycle({
      adapters: [adapter([stale, fresh], "degraded")],
      config: config(),
      sink: sink(),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => DEGRADED_AT,
    });

    expect(storedLastSuccess()).toBe(PREVIOUS_SUCCESS.toISOString());
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(report.sentOk).toBe(1);
    expect(store.hasSeen(stale)).toBe(true);
  });

  it("keeps the previous complete poll across a store restart and suppresses stale inventory", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy();
    store.establishSilent("domria", [], store, ESTABLISHED);
    store.recordSuccess("domria", PREVIOUS_SUCCESS);
    closeDb();

    const reopened = new DurableDeliveryStore(getDb(path));
    expect(storedLastSuccess()).toBe(PREVIOUS_SUCCESS.toISOString());
    const stale = sampleListing({
      sourceId: "4727172962",
      url: "https://dom.ria.com/uk/realty-4727172962.html",
      publishedAt: new Date("2026-09-29T14:41:19.000Z"),
    });
    const report = await runTelegramTestCycle({
      adapters: [adapter([stale])],
      config: config(),
      sink: sink(),
      dedupe: reopened,
      baseline: reopened,
      outbox: reopened,
      now: () => DISCOVERED,
    });

    expect(report.sentOk).toBe(0);
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(reopened.hasSeen(stale)).toBe(true);
    expect(storedLastSuccess()).toBe(DISCOVERED.toISOString());
  });

  it("still silently seeds the first successful poll", async () => {
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const initial = sampleListing({ publishedAt: PUBLISHED_NEW });
    const report = await runTelegramTestCycle({
      adapters: [adapter([initial])],
      config: config(),
      sink: sink(),
      dedupe,
      baseline,
      firstRunMode: "seed",
      now: () => DISCOVERED,
    });

    expect(report.deliveryMode).toBe("inventory_seed");
    expect(report.sentOk).toBe(0);
    expect(baseline.hasBaseline("domria")).toBe(true);
    expect(dedupe.hasSeen(initial)).toBe(true);
  });

  it("keeps a later policy cutover as the freshness floor", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const cutover = new Date("2026-10-01T15:00:00.000Z");
    pinSellerPolicy(cutover);
    store.establishSilent("domria", [], store, ESTABLISHED);
    store.recordSuccess("domria", PREVIOUS_SUCCESS);
    const between = sampleListing({
      sourceId: "cutover-gap",
      url: "https://dom.ria.com/uk/realty-cutover-gap.html",
      publishedAt: PUBLISHED_NEW,
    });

    const report = await runTelegramTestCycle({
      adapters: [adapter([between])],
      config: config(),
      sink: sink(),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => DISCOVERED,
    });

    expect(store.sellerPolicyCutoverAt()?.toISOString()).toBe(cutover.toISOString());
    expect(report.sentOk).toBe(0);
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(store.hasSeen(between)).toBe(true);
  });

  it("still uses the previous complete poll when it is later than policy cutover", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy(new Date("2026-09-20T00:00:00.000Z"));
    store.establishSilent("domria", [], store, ESTABLISHED);
    store.recordSuccess("domria", PREVIOUS_SUCCESS);
    const stale = sampleListing();

    const report = await runTelegramTestCycle({
      adapters: [adapter([stale])],
      config: config(),
      sink: sink(),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => DISCOVERED,
    });

    expect(report.sentOk).toBe(0);
    expect(report.suppressedLateDiscovered).toBe(1);
  });

  it("keeps a listing older than the global max age as old_publication", async () => {
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const ancient = sampleListing({
      sourceId: "ancient",
      url: "https://dom.ria.com/uk/realty-ancient.html",
      publishedAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    baseline.establishSilent("domria", [], dedupe, ESTABLISHED);
    baseline.recordSuccess("domria", PREVIOUS_SUCCESS);

    const report = await runTelegramTestCycle({
      adapters: [adapter([ancient])],
      config: config(),
      sink: sink(),
      dedupe,
      baseline,
      now: () => DISCOVERED,
    });

    expect(report.sentOk).toBe(0);
    expect(report.suppressedOld).toBe(1);
    expect(report.suppressedLateDiscovered).toBe(0);
    expect(dedupe.hasSeen(ancient)).toBe(true);
  });
});
