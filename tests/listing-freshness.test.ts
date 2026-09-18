import { describe, expect, it, vi } from "vitest";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { InMemoryListingDedupe } from "../src/delivery/listing-dedupe-memory.ts";
import { classifyListingFreshness } from "../src/delivery/listing-freshness.ts";
import { InMemorySourceBaseline } from "../src/delivery/source-baseline-memory.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import {
  formatKyivDateTime,
  formatListingTelegramHtml,
  formatSellerLabel,
  TelegramTestSink,
} from "../src/outputs/telegram-test.sink.ts";

function sampleListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "domria",
    sourceId: "100",
    url: "https://dom.ria.com/uk/realty-100.html",
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
    discoveredAt: new Date("2026-09-17T10:00:00Z"),
    publishedAt: new Date("2026-09-16T12:00:00Z"),
    ...overrides,
  };
}

function adapter(source: Listing["source"], listings: Listing[], ok = true): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => listings,
    inspectLatest: async (): Promise<SourceFetchResult> => ({
      listings,
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: ok ? (listings.length > 0 ? "ok" : "valid_empty") : "http_error",
      httpStatus: ok ? 200 : 503,
      health: {
        source,
        healthy: ok,
        checkedAt: new Date(),
        message: ok ? "ok" : "fail",
      },
    }),
    healthCheck: async () => ({ source, healthy: ok, checkedAt: new Date() }),
  };
}

function baseConfig(extra: Record<string, string> = {}) {
  resetConfigCache();
  return loadConfig({
    OWNER_ONLY: "true",
    ENABLE_DOMRIA: "true",
    ENABLE_LUN: "false",
    ENABLE_OLX: "false",
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

describe("listing freshness classification", () => {
  const now = new Date("2026-09-17T12:00:00Z");

  it("marks Dec 2025 Domria publishing_date as old_publication", () => {
    const result = classifyListingFreshness(
      sampleListing({ publishedAt: new Date("2025-12-31T15:03:31.000Z") }),
      { maxPublicationAgeMinutes: 7 * 24 * 60, strictNewPublications: true, now },
    );
    expect(result.kind).toBe("old_publication");
    expect(result.deliverable).toBe(false);
  });

  it("accepts a genuinely new publication", () => {
    const result = classifyListingFreshness(
      sampleListing({ publishedAt: new Date("2026-09-17T08:00:00Z") }),
      { maxPublicationAgeMinutes: 7 * 24 * 60, strictNewPublications: true, now },
    );
    expect(result.kind).toBe("new_publication");
    expect(result.deliverable).toBe(true);
  });

  it("classifies refreshed old listing without treating it as new", () => {
    const result = classifyListingFreshness(
      sampleListing({
        publishedAt: new Date("2025-12-31T15:03:31.000Z"),
        refreshedAt: new Date("2026-09-17T10:00:00Z"),
      }),
      { maxPublicationAgeMinutes: 7 * 24 * 60, strictNewPublications: true, now },
    );
    expect(result.kind).toBe("refreshed_old");
    expect(result.deliverable).toBe(false);
  });

  it("does not treat live OLX August/early-September createdTime as new publications", () => {
    const probeAt = new Date("2026-09-18T20:27:56.395Z");
    const policy = {
      maxPublicationAgeMinutes: 7 * 24 * 60,
      strictNewPublications: true,
      now: probeAt,
    };
    expect(
      classifyListingFreshness(
        sampleListing({
          source: "olx",
          sourceId: "933128280",
          publishedAt: new Date("2026-08-28T13:34:45.000Z"),
          refreshedAt: new Date("2026-09-18T12:44:42.000Z"),
        }),
        policy,
      ),
    ).toMatchObject({ kind: "refreshed_old", deliverable: false });
    expect(
      classifyListingFreshness(
        sampleListing({
          source: "olx",
          sourceId: "934256136",
          publishedAt: new Date("2026-09-08T22:32:52.000Z"),
          refreshedAt: new Date("2026-09-08T22:36:16.000Z"),
        }),
        policy,
      ),
    ).toMatchObject({ kind: "old_publication", deliverable: false });
    expect(
      classifyListingFreshness(
        sampleListing({
          source: "olx",
          sourceId: "934623975",
          publishedAt: new Date("2026-09-12T17:55:42.000Z"),
          refreshedAt: new Date("2026-09-12T17:59:30.000Z"),
        }),
        policy,
      ),
    ).toMatchObject({ kind: "new_publication", deliverable: true });
  });

  it("labels missing publishedAt as first_noticed and excludes in strict mode", () => {
    const listing = sampleListing();
    delete (listing as { publishedAt?: Date }).publishedAt;
    const strict = classifyListingFreshness(listing, {
      maxPublicationAgeMinutes: 7 * 24 * 60,
      strictNewPublications: true,
      now,
    });
    expect(strict.kind).toBe("first_noticed");
    expect(strict.deliverable).toBe(false);
    const loose = classifyListingFreshness(listing, {
      maxPublicationAgeMinutes: 7 * 24 * 60,
      strictNewPublications: false,
      now,
    });
    expect(loose.deliverable).toBe(true);
  });
});

describe("Telegram freshness pipeline", () => {
  it("silently baselines old initial inventory and does not send as new", async () => {
    const config = baseConfig();
    const old = sampleListing({
      sourceId: "old-1",
      url: "https://dom.ria.com/uk/realty-old-1.html",
      publishedAt: new Date("2025-12-31T15:03:31.000Z"),
    });
    const sendListing = vi.fn();
    const sink = { chatId: "1", sendListing } as unknown as TelegramTestSink;
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();

    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [old])],
        config,
        sink,
        dedupe,
        baseline,
        firstRunMode: "seed",
        now: () => new Date("2026-09-17T12:00:00Z"),
      },
      1,
    );

    expect(report.deliveryMode).toBe("inventory_seed");
    expect(report.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
    expect(baseline.hasBaseline("domria")).toBe(true);
    expect(dedupe.hasSeen(old)).toBe(true);
    resetConfigCache();
  });

  it("after baseline, delivers a genuinely new publication", async () => {
    const config = baseConfig();
    const old = sampleListing({
      sourceId: "old-1",
      url: "https://dom.ria.com/uk/realty-old-1.html",
      publishedAt: new Date("2025-12-31T15:03:31.000Z"),
    });
    const neu = sampleListing({
      sourceId: "new-1",
      url: "https://dom.ria.com/uk/realty-new-1.html",
      publishedAt: new Date("2026-09-17T09:00:00Z"),
    });
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "1",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const now = () => new Date("2026-09-17T12:00:00Z");

    await runTelegramTestCycle(
      { adapters: [adapter("domria", [old])], config, sink, dedupe, baseline, now },
      1,
    );
    const report2 = await runTelegramTestCycle(
      { adapters: [adapter("domria", [old, neu])], config, sink, dedupe, baseline, now },
      2,
    );
    expect(report2.sentOk).toBe(1);
    expect(report2.suppressedOld).toBe(0);
    expect(report2.newlyObservedCount).toBe(1);
    resetConfigCache();
  });

  it("suppresses refreshed old listing after baseline", async () => {
    const config = baseConfig();
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "1",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const now = () => new Date("2026-09-17T12:00:00Z");

    await runTelegramTestCycle(
      { adapters: [adapter("domria", [])], config, sink, dedupe, baseline, now },
      1,
    );
    const refreshed = sampleListing({
      sourceId: "ref-1",
      url: "https://dom.ria.com/uk/realty-ref-1.html",
      publishedAt: new Date("2025-06-01T00:00:00Z"),
      refreshedAt: new Date("2026-09-17T11:00:00Z"),
    });
    const report2 = await runTelegramTestCycle(
      { adapters: [adapter("domria", [refreshed])], config, sink, dedupe, baseline, now },
      2,
    );
    expect(report2.sentOk).toBe(0);
    expect(report2.suppressedRefreshedOld).toBe(1);
    resetConfigCache();
  });

  it("failed source does not establish baseline; recovery re-baselines silently", async () => {
    const config = baseConfig();
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "1",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const now = () => new Date("2026-09-17T12:00:00Z");
    const inventory = [
      sampleListing({
        sourceId: "hist-1",
        url: "https://dom.ria.com/uk/realty-hist-1.html",
        publishedAt: new Date("2025-12-31T15:03:31.000Z"),
      }),
      sampleListing({
        sourceId: "hist-2",
        url: "https://dom.ria.com/uk/realty-hist-2.html",
        publishedAt: new Date("2026-01-15T10:00:00Z"),
      }),
    ];

    const fail1 = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [], false)],
        config,
        sink,
        dedupe,
        baseline,
        now,
      },
      1,
    );
    expect(fail1.hasSourceFailures).toBe(true);
    expect(baseline.hasBaseline("domria")).toBe(false);
    expect(fail1.sentOk).toBe(0);

    const recover = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", inventory)],
        config,
        sink,
        dedupe,
        baseline,
        now,
      },
      2,
    );
    expect(recover.deliveryMode).toBe("inventory_seed");
    expect(recover.sentOk).toBe(0);
    expect(baseline.hasBaseline("domria")).toBe(true);
    expect(dedupe.hasSeen(inventory[0]!)).toBe(true);
    resetConfigCache();
  });

  it("restart with empty baseline silently re-baselines instead of flooding", async () => {
    const config = baseConfig();
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "1",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    const inventory = [
      sampleListing({
        sourceId: "r1",
        url: "https://dom.ria.com/uk/realty-r1.html",
        publishedAt: new Date("2025-12-31T15:03:31.000Z"),
      }),
    ];
    // Simulate process restart: fresh dedupe + baseline.
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", inventory)],
        config,
        sink,
        dedupe: new InMemoryListingDedupe(),
        baseline: new InMemorySourceBaseline(),
        now: () => new Date("2026-09-17T12:00:00Z"),
      },
      1,
    );
    expect(report.restartRebaseline).toBe(true);
    expect(report.baselineSurvivesRestart).toBe(false);
    expect(report.sentOk).toBe(0);
    expect(report.deliveryMode).toBe("inventory_seed");
    resetConfigCache();
  });

  it("preview mode sends a small sample labeled Початкова добірка", async () => {
    const config = baseConfig({ FIRST_RUN_MODE: "preview" });
    const listings = [
      sampleListing({
        sourceId: "p1",
        url: "https://dom.ria.com/uk/realty-p1.html",
        publishedAt: new Date("2025-12-31T15:03:31.000Z"),
      }),
      sampleListing({
        sourceId: "p2",
        url: "https://dom.ria.com/uk/realty-p2.html",
        publishedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];
    const sendListing = vi.fn(async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }));
    const sink = { chatId: "1", sendListing } as unknown as TelegramTestSink;
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", listings)],
        config,
        sink,
        dedupe: new InMemoryListingDedupe(),
        baseline: new InMemorySourceBaseline(),
        firstRunMode: "preview",
        initialPreviewLimit: 1,
        now: () => new Date("2026-09-17T12:00:00Z"),
      },
      1,
    );
    expect(report.deliveryMode).toBe("initial_preview");
    expect(sendListing).toHaveBeenCalledTimes(1);
    const call = sendListing.mock.calls[0] as unknown as [Listing, { deliveryKind: string }];
    expect(call[1]?.deliveryKind).toBe("initial_preview");
    resetConfigCache();
  });
});

describe("Telegram copy", () => {
  it("uses Kyiv human dates and platform-label seller wording", () => {
    const listing = sampleListing({
      publishedAt: new Date("2025-12-31T15:03:31.000Z"),
      firstSeenAt: new Date("2026-09-17T12:00:00Z"),
    });
    const text = formatListingTelegramHtml(listing, { deliveryKind: "new_publication" });
    expect(text).toContain("Нова публікація");
    expect(text).not.toContain("нове оголошення");
    expect(text).not.toMatch(/2025-12-31T15:03:31/);
    expect(text).toContain(formatKyivDateTime(listing.publishedAt));
    expect(formatSellerLabel(listing)).toBe("Власник — за позначкою майданчика");
    expect(formatSellerLabel(listing)).not.toContain("platform-verified");
    expect(formatListingTelegramHtml(listing, { deliveryKind: "initial_preview" })).toContain(
      "Початкова добірка",
    );
    expect(formatListingTelegramHtml(listing, { deliveryKind: "first_noticed" })).toContain(
      "Вперше помічено",
    );
  });
});
