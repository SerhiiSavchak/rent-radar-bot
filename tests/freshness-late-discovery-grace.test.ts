import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { InMemoryListingDedupe } from "../src/delivery/listing-dedupe-memory.ts";
import {
  classifyListingFreshness,
  LATE_DISCOVERY_GRACE_MINUTES,
} from "../src/delivery/listing-freshness.ts";
import { InMemorySourceBaseline } from "../src/delivery/source-baseline-memory.ts";
import { hasSellerHold } from "../src/delivery/seller-verification-hold.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

const MINUTE_MS = 60_000;
const NOW = new Date("2026-10-03T05:40:58.000Z");
const BOUNDARY = new Date(NOW.getTime() - 10 * MINUTE_MS);
const ESTABLISHED = new Date("2026-09-19T21:15:02.156Z");
const MAX_AGE_MINUTES = 7 * 24 * 60;
const RIELTOR_URL = "https://rieltor.ua/lvov/flats-rent/view/777/";
const OWNER_HTML = `<div class="offer-view-rieltor-position">Власник</div>`;

function minutesAgo(minutes: number, from = NOW): Date {
  return new Date(from.getTime() - minutes * MINUTE_MS);
}

function sampleListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "domria",
    sourceId: "grace-1",
    url: "https://dom.ria.com/uk/realty-grace-1.html",
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
    discoveredAt: NOW,
    publishedAt: minutesAgo(40),
    metadata: { ownerEvidenceLevel: "platform_confirmed" },
    ...overrides,
  };
}

function classify(
  publishedAt: Date | undefined,
  extra: {
    monitoringStartedAt?: Date;
    maxPublicationAgeMinutes?: number;
    strictNewPublications?: boolean;
    refreshedAt?: Date;
    now?: Date;
  } = {},
) {
  const listing = sampleListing({
    publishedAt,
    ...(extra.refreshedAt ? { refreshedAt: extra.refreshedAt } : {}),
  });
  if (publishedAt === undefined) {
    delete (listing as { publishedAt?: Date }).publishedAt;
  }
  return classifyListingFreshness(listing, {
    maxPublicationAgeMinutes: extra.maxPublicationAgeMinutes ?? MAX_AGE_MINUTES,
    strictNewPublications: extra.strictNewPublications ?? true,
    now: extra.now ?? NOW,
    monitoringStartedAt: extra.monitoringStartedAt ?? BOUNDARY,
  });
}

function adapter(
  source: Listing["source"],
  listings: Listing[],
  mode: "ok" | "degraded" = "ok",
): ListingSourceAdapter {
  return {
    source,
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
              pagesFetched: 1,
              cardsFetched: listings.length,
              boundaryReached: false,
              coverageTruncated: true,
            },
          }
        : {}),
      health: {
        source,
        healthy: mode === "ok",
        checkedAt: NOW,
        resultKind: "ok",
        httpStatus: 200,
        transport: "test",
      },
    }),
    healthCheck: async () => ({ source, healthy: true, checkedAt: NOW }),
  };
}

function config(extra: Record<string, string> = {}) {
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
    MAX_LISTING_AGE_MINUTES: String(MAX_AGE_MINUTES),
    ...extra,
  });
}

function liveSink(sendListing?: TelegramTestSink["sendListing"]) {
  const send =
    sendListing ??
    (async () => ({
      ok: true,
      dryRun: false,
      attempts: 1,
      chatId: "1",
      messageCount: 1,
    }));
  return {
    chatId: "1",
    dryRun: false,
    sendListing: send,
    sendText: async () => ({
      ok: true,
      dryRun: false,
      attempts: 1,
      chatId: "1",
      messageCount: 1,
    }),
  } as unknown as TelegramTestSink;
}

describe("60-minute late-discovery grace", () => {
  it("keeps the named grace default at 60 minutes", () => {
    expect(LATE_DISCOVERY_GRACE_MINUTES).toBe(60);
  });

  it("delivers a listing published after the previous boundary", () => {
    const result = classify(minutesAgo(5));
    expect(result.kind).toBe("new_publication");
    expect(result.deliverable).toBe(true);
    expect(result.reason).toContain("after monitoring started");
  });

  it("delivers a 21-minute listing published before the previous boundary", () => {
    const result = classify(minutesAgo(21));
    expect(result.deliverable).toBe(true);
    expect(result.kind).toBe("new_publication");
    expect(result.reason).toContain("late-discovery grace");
  });

  it("delivers a 40-minute listing published before the previous boundary", () => {
    const result = classify(minutesAgo(40));
    expect(result.deliverable).toBe(true);
    expect(result.kind).toBe("new_publication");
    expect(result.reason).toContain("late-discovery grace");
  });

  it("treats a publication exactly 60 minutes old as inside the grace", () => {
    const publishedAt = new Date(NOW.getTime() - LATE_DISCOVERY_GRACE_MINUTES * MINUTE_MS);
    const result = classify(publishedAt);
    expect(publishedAt.getTime()).toBeLessThan(BOUNDARY.getTime());
    expect(result.deliverable).toBe(true);
    expect(result.kind).toBe("new_publication");
  });

  it("suppresses a listing 60 minutes and 1 millisecond old when it predates the boundary", () => {
    const publishedAt = new Date(NOW.getTime() - LATE_DISCOVERY_GRACE_MINUTES * MINUTE_MS - 1);
    const result = classify(publishedAt);
    expect(publishedAt.getTime()).toBeLessThan(BOUNDARY.getTime());
    expect(result.kind).toBe("late_discovered");
    expect(result.deliverable).toBe(false);
  });

  it("suppresses a listing published several days ago", () => {
    const result = classify(minutesAgo(5 * 24 * 60));
    expect(result.kind).toBe("late_discovered");
    expect(result.deliverable).toBe(false);
  });

  it("does not let grace rescue a listing past maxPublicationAgeMinutes", () => {
    const result = classify(minutesAgo(45), { maxPublicationAgeMinutes: 30 });
    expect(result.kind).toBe("old_publication");
    expect(result.deliverable).toBe(false);
  });

  it("keeps refreshed-old rejection ahead of grace", () => {
    const result = classify(new Date("2026-08-01T00:00:00.000Z"), {
      refreshedAt: minutesAgo(5),
    });
    expect(result.kind).toBe("refreshed_old");
    expect(result.deliverable).toBe(false);
  });

  it("keeps unknown publishedAt excluded in strict mode", () => {
    const result = classify(undefined);
    expect(result.kind).toBe("first_noticed");
    expect(result.deliverable).toBe(false);
    expect(result.reason).toContain("strict");
  });

  it("matches the observed OLX false suppressions once grace is applied", () => {
    const first = classifyListingFreshness(
      sampleListing({
        source: "olx",
        sourceId: "936671739",
        url: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID936671739.html",
        publishedAt: new Date("2026-10-03T04:30:12.000Z"),
      }),
      {
        maxPublicationAgeMinutes: MAX_AGE_MINUTES,
        strictNewPublications: true,
        now: new Date("2026-10-03T04:50:47.000Z"),
        monitoringStartedAt: new Date("2026-10-03T04:40:47.000Z"),
      },
    );
    const second = classifyListingFreshness(
      sampleListing({
        source: "olx",
        sourceId: "936672350",
        url: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID936672350.html",
        publishedAt: new Date("2026-10-03T05:01:08.000Z"),
      }),
      {
        maxPublicationAgeMinutes: MAX_AGE_MINUTES,
        strictNewPublications: true,
        now: new Date("2026-10-03T05:40:54.000Z"),
        monitoringStartedAt: new Date("2026-10-03T05:30:54.000Z"),
      },
    );
    expect(first.deliverable).toBe(true);
    expect(second.deliverable).toBe(true);
    expect(first.kind).not.toBe("late_discovered");
    expect(second.kind).not.toBe("late_discovered");
  });
});

describe("late-discovery grace in the telegram pipeline", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-grace-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  function pinSellerPolicy(): void {
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('seller_policy', 'reject_intermediaries')",
      )
      .run();
  }

  function baselinedMemory(previousSuccess = BOUNDARY) {
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    baseline.establishSilent("domria", [], dedupe, ESTABLISHED);
    baseline.recordSuccess("domria", previousSuccess);
    return { dedupe, baseline };
  }

  it("still seeds the first successful poll instead of sending fresh inventory", async () => {
    const listing = sampleListing({ publishedAt: minutesAgo(30) });
    const sendListing = vi.fn(async () => ({
      ok: true,
      dryRun: false,
      attempts: 1,
      chatId: "1",
      messageCount: 1,
    }));
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [listing])],
        config: config(),
        sink: liveSink(sendListing),
        dedupe: new InMemoryListingDedupe(),
        baseline: new InMemorySourceBaseline(),
        firstRunMode: "seed",
        now: () => NOW,
      },
      1,
    );
    expect(report.deliveryMode).toBe("inventory_seed");
    expect(report.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
  });

  it("does not advance last_success_at on coverage_degraded", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy();
    store.establishSilent("domria", [], store, ESTABLISHED);
    store.recordSuccess("domria", BOUNDARY);
    const stale = sampleListing({
      sourceId: "stale-5d",
      url: "https://dom.ria.com/uk/realty-stale-5d.html",
      publishedAt: minutesAgo(5 * 24 * 60),
    });
    const delayed = sampleListing({
      sourceId: "delayed-40",
      url: "https://dom.ria.com/uk/realty-delayed-40.html",
      publishedAt: minutesAgo(40),
    });
    const fresh = sampleListing({
      sourceId: "fresh-5",
      url: "https://dom.ria.com/uk/realty-fresh-5.html",
      publishedAt: minutesAgo(5),
    });

    const report = await runTelegramTestCycle({
      adapters: [adapter("domria", [stale, delayed, fresh], "degraded")],
      config: config(),
      sink: liveSink(),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => NOW,
    });

    const row = getDb()
      .prepare(
        "SELECT last_success_at AS lastSuccessAt FROM source_baselines WHERE source = 'domria'",
      )
      .get() as { lastSuccessAt: string };
    expect(row.lastSuccessAt).toBe(BOUNDARY.toISOString());
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(report.sentOk).toBe(2);
    expect(store.hasSeen(stale)).toBe(true);
  });

  it("still rejects a grace-aged confirmed intermediary", async () => {
    const { dedupe, baseline } = baselinedMemory();
    const agent = sampleListing({
      sourceId: "agent-1",
      url: "https://dom.ria.com/uk/realty-agent-1.html",
      publishedAt: minutesAgo(30),
      sellerType: "agent",
      metadata: { ownerEvidenceLevel: "intermediary" },
    });
    const sendListing = vi.fn();
    const report = await runTelegramTestCycle({
      adapters: [adapter("domria", [agent])],
      config: config(),
      sink: liveSink(sendListing),
      dedupe,
      baseline,
      now: () => NOW,
    });
    expect(sendListing).not.toHaveBeenCalled();
    expect(report.sentOk).toBe(0);
    expect(report.suppressedLateDiscovered).toBe(0);
    expect(report.sellerRejectedIntermediary).toBeGreaterThan(0);
  });

  it("still rejects seller_registration_year_2026 inside the grace window", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy();
    store.establishSilent("domria", [], store, ESTABLISHED);
    store.recordSuccess("domria", BOUNDARY);
    const young = sampleListing({
      sourceId: "year-2026",
      url: "https://dom.ria.com/uk/realty-year-2026.html",
      publishedAt: minutesAgo(25),
      metadata: {
        ownerEvidenceLevel: "platform_confirmed",
        accountRegistrationYear: 2026,
      },
    });
    const sendListing = vi.fn();
    const report = await runTelegramTestCycle({
      adapters: [adapter("domria", [young])],
      config: config(),
      sink: liveSink(sendListing),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => NOW,
    });
    const traced = getDb()
      .prepare(
        `SELECT reason_code AS reasonCode FROM listing_decision_trace
         WHERE source_id = ? AND stage = 'rejected_seller'`,
      )
      .get(young.sourceId) as { reasonCode: string } | undefined;
    expect(sendListing).not.toHaveBeenCalled();
    expect(report.sentOk).toBe(0);
    expect(report.suppressedLateDiscovered).toBe(0);
    expect(traced?.reasonCode).toBe("seller_registration_year_2026");
    expect(store.hasSeen(young)).toBe(true);
  });

  it("still suppresses a grace-aged confirmed cross-source duplicate", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy();
    store.establishSilent("lun", [], store, ESTABLISHED);
    store.establishSilent("olx", [], store, ESTABLISHED);
    store.recordSuccess("lun", BOUNDARY);
    store.recordSuccess("olx", BOUNDARY);
    const olxUrl = "https://www.olx.ua/d/obyavlenie/orenda-ID11gWHG.html";
    const lun = sampleListing({
      source: "lun",
      sourceId: "5001",
      url: "https://lun.ua/uk/realty/5001",
      publishedAt: minutesAgo(35),
      sellerType: "unknown",
      metadata: {
        originalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID11gWHG.html",
        aggregatedSite: "olx.ua",
        ownerEvidenceLevel: "private_unknown",
      },
    });
    const olx = sampleListing({
      source: "olx",
      sourceId: "934944232",
      url: olxUrl,
      publishedAt: minutesAgo(35),
      sellerType: "owner",
      metadata: { ownerEvidenceLevel: "platform_confirmed" },
    });
    const sendListing = vi.fn(async () => ({
      ok: true,
      dryRun: false,
      attempts: 1,
      chatId: "1",
      messageCount: 1,
    }));
    const report = await runTelegramTestCycle({
      adapters: [adapter("lun", [lun]), adapter("olx", [olx])],
      config: config({ ENABLE_DOMRIA: "false", ENABLE_LUN: "true", ENABLE_OLX: "true" }),
      sink: liveSink(sendListing),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => NOW,
      fetchOlxDetail: async () => {
        throw new Error("confirmed duplicate must not fetch OLX detail");
      },
    });
    expect(report.sentOk).toBe(1);
    expect(report.suppressedCrossSourceDuplicate).toBe(1);
    expect(report.suppressedLateDiscovered).toBe(0);
    expect(sendListing).toHaveBeenCalledTimes(1);
    expect(sendListing).toHaveBeenCalledWith(
      expect.objectContaining({ source: "lun", sourceId: "5001" }),
      expect.anything(),
    );
  });

  it("queues a 20–40 minute delayed owner listing and does not send it twice", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy();
    const seenAt = new Date("2026-10-03T05:40:54.000Z");
    const previousSuccess = new Date(seenAt.getTime() - 10 * MINUTE_MS);
    store.establishSilent("domria", [], store, ESTABLISHED);
    store.recordSuccess("domria", previousSuccess);
    const delayed = sampleListing({
      sourceId: "936672350",
      url: "https://dom.ria.com/uk/realty-936672350.html",
      title: "Оренда затишної квартири від власника",
      publishedAt: new Date("2026-10-03T05:01:08.000Z"),
    });
    const sendListing = vi.fn(async () => ({
      ok: true,
      dryRun: false,
      attempts: 1,
      chatId: "1",
      messageCount: 1,
    }));
    const cycle = (at: Date) =>
      runTelegramTestCycle({
        adapters: [adapter("domria", [delayed])],
        config: config(),
        sink: liveSink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => at,
      });

    const first = await cycle(seenAt);
    const outbox = getDb()
      .prepare("SELECT status FROM telegram_outbox WHERE source_id = ?")
      .get(delayed.sourceId) as { status: string };
    expect(first.sentOk).toBe(1);
    expect(first.suppressedLateDiscovered).toBe(0);
    expect(outbox.status).toBe("sent");
    expect(store.hasSeen(delayed)).toBe(true);

    const again = await cycle(new Date(seenAt.getTime() + MINUTE_MS));
    expect(again.sentOk).toBe(0);
    expect(again.suppressedLateDiscovered).toBe(0);
    expect(sendListing).toHaveBeenCalledTimes(1);
  });

  it("suppresses a newly discovered 5-day-old listing", async () => {
    const { dedupe, baseline } = baselinedMemory();
    const old = sampleListing({
      sourceId: "five-days",
      url: "https://dom.ria.com/uk/realty-five-days.html",
      publishedAt: minutesAgo(5 * 24 * 60),
    });
    const report = await runTelegramTestCycle({
      adapters: [adapter("domria", [old])],
      config: config(),
      sink: liveSink(),
      dedupe,
      baseline,
      now: () => NOW,
    });
    expect(report.sentOk).toBe(0);
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(report.suppressedOld).toBe(0);
    expect(dedupe.hasSeen(old)).toBe(true);
  });

  it("releases a grace-approved seller hold after the grace window has expired", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    pinSellerPolicy();
    store.establishSilent("lun", [], store, ESTABLISHED);
    store.recordSuccess("lun", new Date("2026-10-03T05:20:00.000Z"));
    const heldListing = sampleListing({
      source: "lun",
      sourceId: "held-grace",
      url: "https://lun.ua/uk/realty/held-grace",
      publishedAt: new Date("2026-10-03T04:50:00.000Z"),
      sellerType: "unknown",
      metadata: {
        originalUrl: RIELTOR_URL,
        aggregatedSite: "rieltor.ua",
        ownerEvidenceLevel: "private_unknown",
      },
    });
    const discovered = new Date("2026-10-03T05:40:00.000Z");
    const releasedAt = new Date("2026-10-03T06:15:00.000Z");
    let detailMode: "fail" | "owner" = "fail";
    const cycle = (at: Date) =>
      runTelegramTestCycle({
        adapters: [adapter("lun", [heldListing])],
        config: config({ ENABLE_DOMRIA: "false", ENABLE_LUN: "true" }),
        sink: liveSink(),
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

    const held = await cycle(discovered);
    expect(held.sentOk).toBe(0);
    expect(held.suppressedLateDiscovered).toBe(0);
    expect(hasSellerHold(getDb(path), "lun", heldListing.sourceId)).toBe(true);
    const metadata = JSON.parse(
      (
        getDb()
          .prepare(
            "SELECT listing_json AS listingJson FROM seller_verification_holds WHERE source_id = ?",
          )
          .get(heldListing.sourceId) as { listingJson: string }
      ).listingJson,
    ).metadata as { freshnessGateVersion?: number };
    expect(metadata.freshnessGateVersion).toBe(2);

    detailMode = "owner";
    const released = await cycle(releasedAt);
    expect(released.sentOk).toBe(1);
    expect(released.suppressedLateDiscovered).toBe(0);
    expect(hasSellerHold(getDb(path), "lun", heldListing.sourceId)).toBe(false);
  });
});
