import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { classifyListingFreshness } from "../src/delivery/listing-freshness.ts";
import { sellerVerificationDisposition } from "../src/delivery/seller-verification-hold.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import { SELLER_INVENTORY_LIMIT_MIN } from "../src/delivery/seller-profile.ts";
import {
  classifyOwner,
  isSellerEligible,
  sellerRejectionReason,
} from "../src/filters/owner-filter.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { sellerRegistrationYearRejectionReason } from "../src/sources/olx/olx-account-registration.ts";
import {
  assessOlxBusinessFullScanAge,
  buildOlxBrowserCategoryUrl,
  isOlxBusinessFullScanDue,
  OLX_BUSINESS_APARTMENT_PAGE_CEILING,
  OLX_BUSINESS_FULL_SCAN_INTERVAL_MS,
  OLX_BUSINESS_LAST_FULL_SCAN_KEY,
  olxCatchupKey,
  olxForwardScanMissesInsertedOnPage1,
  olxPageCursorResumeMisses,
  RETIRED_OLX_BUSINESS_ROLLING_KEYS,
} from "../src/sources/olx/olx-browser.coverage.ts";
import { extractOlxListingsViaBrowser } from "../src/sources/olx/olx-browser.extract.ts";
import {
  derivedOracleApartmentPrivateAd,
  derivedOracleHousePrivateAd,
} from "./fixtures/olx-prerendered-oracle-derived.ts";
import type { Browser, BrowserContext, Page } from "playwright";
import { applyMigrations } from "../src/storage/migrations.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";
import type { OlxProfileSnapshot } from "../src/sources/olx/olx-seller-profile.ts";

const NOW = new Date("2026-10-04T00:00:00.000Z");

function config() {
  resetConfigCache();
  return loadConfig({
    OWNER_ONLY: "false",
    SELLER_POLICY: "reject_intermediaries",
    ENABLE_DOMRIA: "false",
    ENABLE_LUN: "true",
    ENABLE_OLX: "false",
    ENABLE_OLX_BROWSER: "true",
    ENABLE_RIELTOR: "false",
    PROPERTY_TYPES: "apartment,house",
    TARGET_LAT: "49.8397",
    TARGET_LNG: "24.0297",
    TARGET_RADIUS_KM: "15",
    GEO_UNKNOWN_POLICY: "include",
    FIRST_RUN_MODE: "seed",
    TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
    TELEGRAM_DRY_RUN: "true",
  });
}

function drySink() {
  return {
    chatId: "1",
    dryRun: true,
    sendListing: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }),
    sendText: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }),
  } as never;
}

function olxListing(sourceId: string, overrides: Partial<Listing> = {}): Listing {
  return {
    source: "olx",
    sourceId,
    url: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${sourceId}.html`,
    title: "Оренда квартири",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "unknown",
    sellerConfidence: "medium",
    sellerEvidence: [],
    discoveredAt: NOW,
    publishedAt: new Date("2020-01-01T00:00:00.000Z"),
    metadata: {
      olxAccountType: "business",
      olxIsBusiness: true,
      ownerEvidenceLevel: "business_ambiguous",
    },
    ...overrides,
  };
}

function adapter(source: Listing["source"], listings: Listing[], coverage?: SourceFetchResult["coverage"]): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => listings,
    healthCheck: async () => ({ source, healthy: true, checkedAt: NOW }),
    inspectLatest: async () => ({
      listings,
      transport: source === "olx" ? "stock_playwright_chromium" : "https",
      dataKind: "FIXTURE DATA",
      resultKind: "ok",
      ...(coverage ? { coverage } : {}),
      health: { source, healthy: true, checkedAt: NOW, resultKind: "ok" },
    }),
  };
}

describe("OLX business account semantics", () => {
  it("rejects a business account with no owner evidence", () => {
    const result = classifyOwner({ isBusiness: true, text: "Здається двокімнатна квартира по вулиці Пасічна" });
    expect(result.sellerType).not.toBe("business");
    expect(result.ownerEvidenceLevel).toBe("business_ambiguous");
    expect(
      sellerRejectionReason({
        sellerType: result.sellerType,
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      }),
    ).toBe("business_without_positive_owner_evidence");
    expect(isSellerEligible({ sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } })).toBe(
      false,
    );
  });

  it("allows a clean explicit owner claim on a business account", () => {
    const result = classifyOwner({
      isBusiness: true,
      text: "Оренда квартири від власника",
    });
    expect(result.ownerEvidenceLevel).toBe("self_declared");
    expect(result.filterConsidersSelfDeclaredOwner).toBe(true);
    expect(isSellerEligible({ sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } })).toBe(
      true,
    );
  });

  it("keeps registration year 2026 stronger than an owner claim", () => {
    const result = classifyOwner({ isBusiness: true, text: "від власника" });
    expect(result.ownerEvidenceLevel).toBe("self_declared");
    expect(sellerRegistrationYearRejectionReason(2026)).toBe("seller_registration_year_2026");
  });

  it("rejects an owner claim that also has agency text", () => {
    const result = classifyOwner({
      isBusiness: true,
      text: 'від власника. АН "Центр"',
    });
    expect(result.ownerEvidenceLevel).toBe("conflict");
    expect(sellerRejectionReason({ sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } })).toBe(
      "explicit_intermediary_conflicts_with_owner_claim",
    );
  });

  it("rejects an explicit platform agent on a business account", () => {
    const result = classifyOwner({ isBusiness: true, platformAgent: true, text: "від власника" });
    expect(result.sellerType).toBe("agent");
    expect(["intermediary", "conflict"]).toContain(result.ownerEvidenceLevel);
    expect(isSellerEligible({ sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } })).toBe(
      false,
    );
  });

  it("allows a platform-confirmed owner on a business account", () => {
    const result = classifyOwner({ isBusiness: true, platformOwner: true });
    expect(result.sellerType).toBe("owner");
    expect(result.ownerEvidenceLevel).toBe("platform_confirmed");
    expect(isSellerEligible({ sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } })).toBe(
      true,
    );
  });

  it("leaves a private unknown listing sendable", () => {
    const result = classifyOwner({ isBusiness: false, platformPrivate: true, text: "Оренда квартири" });
    expect(result.ownerEvidenceLevel).toBe("private_unknown");
    expect(isSellerEligible({ sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } })).toBe(
      true,
    );
  });

  it("does not treat a bare private title as a new private self-declaration rule", () => {
    const result = classifyOwner({ isBusiness: false, platformPrivate: true, text: "Власник, здам квартиру" });
    expect(result.ownerEvidenceLevel).toBe("private_unknown");
  });
});

describe("audit fixtures", () => {
  it("classifies 936607509 / 11nUoJ as a self-declared owner and not a current send", () => {
    const title = "Приватний будинок .Є підвал .Поруч з центром .Від власника.";
    const result = classifyOwner({ isBusiness: true, text: title });
    expect(result.ownerEvidenceLevel).toBe("self_declared");
    expect(sellerRegistrationYearRejectionReason(2016)).toBeUndefined();
    const freshness = classifyListingFreshness(
      {
        source: "olx",
        sourceId: "936607509",
        publishedAt: new Date("2026-10-02T10:02:47.000Z"),
      },
      {
        maxPublicationAgeMinutes: 7 * 24 * 60,
        strictNewPublications: true,
        lateDiscoveryGraceMinutes: 60,
        now: NOW,
        monitoringStartedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
      },
    );
    expect(freshness.deliverable).toBe(false);
    expect(freshness.kind).toBe("late_discovered");
  });

  it("still rejects a confirmed intermediary and a 2026 registration", () => {
    const intermediary = classifyOwner({
      isBusiness: true,
      platformAgent: true,
      text: "Оренда квартири",
    });
    expect(isSellerEligible({ sellerType: intermediary.sellerType, metadata: { ownerEvidenceLevel: intermediary.ownerEvidenceLevel } })).toBe(
      false,
    );
    const ambiguous = classifyOwner({ isBusiness: true, text: "Здається двокімнатна квартира по вулиці Пасічна" });
    expect(
      sellerRejectionReason({
        sellerType: ambiguous.sellerType,
        metadata: { ownerEvidenceLevel: ambiguous.ownerEvidenceLevel },
      }),
    ).toBe("business_without_positive_owner_evidence");
    expect(sellerRegistrationYearRejectionReason(2026)).toBe("seller_registration_year_2026");
  });
});

describe("business full snapshot schedule", () => {
  it("requests private and business catalogs separately", () => {
    expect(new URL(buildOlxBrowserCategoryUrl("apartments")).searchParams.get("search[private_business]")).toBe(
      "private",
    );
    expect(new URL(buildOlxBrowserCategoryUrl("houses")).searchParams.get("search[private_business]")).toBe("private");
    expect(
      new URL(buildOlxBrowserCategoryUrl("apartments", { accountCatalog: "business" })).searchParams.get(
        "search[private_business]",
      ),
    ).toBe("business");
    expect(
      new URL(buildOlxBrowserCategoryUrl("houses", { accountCatalog: "business", page: 2 })).searchParams.get("page"),
    ).toBe("2");
  });

  it("treats a missing successful snapshot as due", () => {
    expect(isOlxBusinessFullScanDue(undefined, NOW)).toBe(true);
    expect(assessOlxBusinessFullScanAge(undefined, NOW)).toMatchObject({
      due: true,
      degraded: true,
      unsafe: true,
      ageMinutes: null,
    });
  });

  it("is hot at 10 and 20 minutes and due again at 30", () => {
    const success = NOW;
    expect(isOlxBusinessFullScanDue(success, new Date(NOW.getTime() + 10 * 60 * 1000))).toBe(false);
    expect(isOlxBusinessFullScanDue(success, new Date(NOW.getTime() + 20 * 60 * 1000))).toBe(false);
    expect(isOlxBusinessFullScanDue(success, new Date(NOW.getTime() + OLX_BUSINESS_FULL_SCAN_INTERVAL_MS))).toBe(true);
    const atThirty = assessOlxBusinessFullScanAge(success, new Date(NOW.getTime() + 30 * 60 * 1000));
    expect(atThirty.due).toBe(true);
    expect(atThirty.degraded).toBe(false);
    expect(atThirty.ageMinutes).toBe(30);
    const overdue = assessOlxBusinessFullScanAge(success, new Date(NOW.getTime() + 31 * 60 * 1000));
    expect(overdue.degraded).toBe(true);
    expect(overdue.unsafe).toBe(false);
    const unsafe = assessOlxBusinessFullScanAge(success, new Date(NOW.getTime() + 60 * 60 * 1000));
    expect(unsafe.unsafe).toBe(true);
    expect(unsafe.degraded).toBe(true);
  });

  it("does not treat pages 2-9, 10-17, and 18-25 across polls as one complete catalog", () => {
    const movedOntoSkippedPage = olxPageCursorResumeMisses({
      resumePage: 10,
      idsNowOnSkippedPages: ["moved-onto-page-3"],
      idsAlreadyStored: new Set(["seen-on-first-poll"]),
    });
    expect(movedOntoSkippedPage).toEqual(["moved-onto-page-3"]);
    const insertedAfterPage1 = olxForwardScanMissesInsertedOnPage1({
      walkedPagesInOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      idsByPageAtWalkTime: { 1: ["already-walked"] },
      latePage1InsertIds: ["inserted-after-page-1"],
    });
    expect(insertedAfterPage1.missedIds).toEqual(["inserted-after-page-1"]);
    const secondWindow = olxPageCursorResumeMisses({
      resumePage: 18,
      idsNowOnSkippedPages: ["now-on-page-12"],
      idsAlreadyStored: new Set<string>(),
    });
    expect(secondWindow).toEqual(["now-on-page-12"]);
  });
});

describe("business snapshot persistence and first enable", () => {
  const dir = mkdtempSync(join(tmpdir(), "olx-business-rolling-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  function readStamp(db: DatabaseSync): string | undefined {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(OLX_BUSINESS_LAST_FULL_SCAN_KEY) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  it("persists a successful snapshot, stays hot, retries a failure, and keeps the stamp across restart", async () => {
    const path = dbPath();
    const db = new DatabaseSync(path);
    applyMigrations(db);
    for (const key of RETIRED_OLX_BUSINESS_ROLLING_KEYS) {
      db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)").run(key, JSON.stringify({ resumePage: 10 }));
    }
    const store = new DurableDeliveryStore(db);
    const seen: Array<{ due: boolean; last: string | null }> = [];
    let failFullScan = false;
    let optionsNow = NOW;
    const olx: ListingSourceAdapter = {
      source: "olx",
      fetchLatest: async () => [],
      healthCheck: async () => ({ source: "olx", healthy: true, checkedAt: NOW }),
      inspectLatest: async (options) => {
        const last = options?.olxBusinessLastFullScanAt ?? null;
        const due = isOlxBusinessFullScanDue(last ? new Date(last) : undefined, optionsNow);
        seen.push({ due, last });
        const success = due && !failFullScan;
        return {
          listings: [olxListing("apt-1", { publishedAt: new Date("2020-01-01T00:00:00.000Z") })],
          transport: "stock_playwright_chromium",
          dataKind: "FIXTURE DATA" as const,
          resultKind: "ok" as const,
          coverage: {
            pagesFetched: success ? 25 : 1,
            cardsFetched: 1,
            boundaryReached: success || !due,
            coverageTruncated: due && !success,
            ...(success ? { olxBusinessLastFullScanAt: optionsNow.toISOString() } : {}),
          },
          health: { source: "olx" as const, healthy: success || !due, checkedAt: optionsNow, resultKind: "ok" as const },
        };
      },
    };
    const run = (cycle: number) =>
      runTelegramTestCycle(
        {
          adapters: [olx],
          config: config(),
          sink: drySink(),
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => optionsNow,
          firstRunMode: "seed",
        },
        cycle,
      );

    await run(1);
    expect(seen[0]).toEqual({ due: true, last: null });
    expect(readStamp(db)).toBe(NOW.toISOString());
    for (const key of RETIRED_OLX_BUSINESS_ROLLING_KEYS) {
      expect(db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key)).toBeUndefined();
    }
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(olxCatchupKey("apartments"))).toBeUndefined();

    optionsNow = new Date(NOW.getTime() + 10 * 60 * 1000);
    await run(2);
    expect(seen[1]?.due).toBe(false);
    expect(seen[1]?.last).toBe(NOW.toISOString());
    expect(readStamp(db)).toBe(NOW.toISOString());

    optionsNow = new Date(NOW.getTime() + 20 * 60 * 1000);
    await run(3);
    expect(seen[2]?.due).toBe(false);
    expect(readStamp(db)).toBe(NOW.toISOString());

    failFullScan = true;
    optionsNow = new Date(NOW.getTime() + 30 * 60 * 1000);
    await run(4);
    expect(seen[3]?.due).toBe(true);
    expect(readStamp(db)).toBe(NOW.toISOString());

    failFullScan = false;
    optionsNow = new Date(NOW.getTime() + 40 * 60 * 1000);
    await run(5);
    expect(seen[4]?.due).toBe(true);
    expect(seen[4]?.last).toBe(NOW.toISOString());
    expect(readStamp(db)).toBe(optionsNow.toISOString());

    closeDb();
    const reopened = getDb(path);
    expect(readStamp(reopened)).toBe(optionsNow.toISOString());
  });

  it("does not move the snapshot timestamp when coverage is truncated, and still keeps other sources", async () => {
    const path = dbPath();
    const db = new DatabaseSync(path);
    applyMigrations(db);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)").run(
      OLX_BUSINESS_LAST_FULL_SCAN_KEY,
      NOW.toISOString(),
    );
    const store = new DurableDeliveryStore(db);
    const olx: ListingSourceAdapter = {
      source: "olx",
      fetchLatest: async () => [],
      healthCheck: async () => ({ source: "olx", healthy: false, checkedAt: NOW }),
      inspectLatest: async () => ({
        listings: [olxListing("page-1")],
        transport: "stock_playwright_chromium",
        dataKind: "FIXTURE DATA",
        resultKind: "ok",
        coverage: {
          pagesFetched: 1,
          cardsFetched: 1,
          boundaryReached: false,
          coverageTruncated: true,
        },
        health: { source: "olx", healthy: false, checkedAt: NOW, resultKind: "ok" },
      }),
    };
    const lunListing: Listing = {
      source: "lun",
      sourceId: "lun-keep",
      url: "https://lun.ua/uk/realty/lun-keep",
      title: "Квартира",
      location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
      propertyType: "apartment",
      sellerType: "unknown",
      discoveredAt: NOW,
      publishedAt: new Date("2020-01-01T00:00:00.000Z"),
      metadata: { ownerEvidenceLevel: "private_unknown" },
    };
    const report = await runTelegramTestCycle(
      {
        adapters: [olx, adapter("lun", [lunListing])],
        config: config(),
        sink: drySink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(NOW.getTime() + 40 * 60 * 1000),
      },
      1,
    );
    expect(readStamp(db)).toBe(NOW.toISOString());
    expect(report.sourceAttempts.find((attempt) => attempt.source === "olx")?.resultKind).toBe("coverage_degraded");
    expect(report.sourceAttempts.find((attempt) => attempt.source === "lun")?.ok).toBe(true);
    expect(report.collectedRaw).toBeGreaterThanOrEqual(2);
  });

  it("does not open detail pages for a thousand old business rows and does not send them", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    store.establishSilent("olx", [], store, new Date("2026-09-01T00:00:00.000Z"));
    store.recordSuccess("olx", new Date("2026-10-03T23:00:00.000Z"));
    const old = Array.from({ length: 1000 }, (_, index) =>
      olxListing(String(800000000 + index), {
        metadata: {
          olxAccountType: "business",
          olxIsBusiness: true,
          ownerEvidenceLevel: "self_declared",
          filterConsidersSelfDeclaredOwner: true,
        },
        publishedAt: new Date("2024-01-01T00:00:00.000Z"),
      }),
    );
    const fetchOlxDetail = vi.fn(async () => ({ status: 200, finalUrl: "https://www.olx.ua/", bodyText: "" }));
    const probeOlxProfile = vi.fn(async () => ({ acquired: false }) as OlxProfileSnapshot);
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("olx", old)],
        config: config(),
        sink: drySink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => NOW,
        fetchOlxDetail,
        probeOlxProfile,
      },
      2,
    );
    expect(report.sentOk).toBe(0);
    expect(report.suppressedOld + report.suppressedRefreshedOld + report.suppressedLateDiscovered).toBeGreaterThan(0);
    expect(fetchOlxDetail).not.toHaveBeenCalled();
    expect(probeOlxProfile).not.toHaveBeenCalled();
  });

  it("lets a business owner discovered inside the grace window reach detail, then not duplicate", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    store.establishSilent("olx", [], store, new Date("2026-10-03T22:00:00.000Z"));
    store.recordSuccess("olx", new Date("2026-10-03T23:20:00.000Z"));
    const listing = olxListing("936607509", {
      url: "https://www.olx.ua/d/uk/obyavlenie/privatniy-budinok-ID11nUoJ.html",
      title: "Приватний будинок .Є підвал .Поруч з центром .Від власника.",
      propertyType: "house",
      metadata: {
        olxAccountType: "business",
        olxIsBusiness: true,
        ownerEvidenceLevel: "self_declared",
        filterConsidersSelfDeclaredOwner: true,
        urlToken: "11nUoJ",
      },
      publishedAt: new Date("2026-10-03T23:30:00.000Z"),
    });
    const detailHtml = derivedOracleOfferDetailHtml(
      {
        id: 936607509,
        url: listing.url,
        title: listing.title,
        description: "Від власника.",
        business: true,
        isBusiness: true,
        user: { id: 1, name: "Власник", company_name: "", sellerType: null },
      },
      { memberSince: "січень 2016 р." },
    );
    const probeOlxProfile = vi.fn(
      async (): Promise<OlxProfileSnapshot> => ({
        acquired: true,
        listingHtml: detailHtml,
        precisePropertyKeys: [],
        visibleAds: 3,
      }),
    );
    const sendingSink = {
      chatId: "1",
      dryRun: false,
      sendListing: async () => ({ ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 }),
      sendText: async () => ({ ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 }),
    } as never;
    const first = await runTelegramTestCycle(
      {
        adapters: [adapter("olx", [listing])],
        config: config(),
        sink: sendingSink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => NOW,
        probeOlxProfile,
      },
      3,
    );
    expect(probeOlxProfile).toHaveBeenCalledTimes(1);
    expect(first.sentOk).toBe(1);
    expect(first.sellerAcceptedSelfDeclared).toBe(1);
    const second = await runTelegramTestCycle(
      {
        adapters: [adapter("olx", [listing])],
        config: config(),
        sink: sendingSink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(NOW.getTime() + 60_000),
        probeOlxProfile,
      },
      4,
    );
    expect(second.newAfterDedupe).toBe(0);
    expect(probeOlxProfile).toHaveBeenCalledTimes(1);
  });

  it("defers a business detail transport failure and does not send", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    store.establishSilent("olx", [], store, new Date("2026-10-03T22:00:00.000Z"));
    store.recordSuccess("olx", new Date("2026-10-03T23:20:00.000Z"));
    const listing = olxListing("fresh-owner", {
      url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDfresh01.html",
      title: "Оренда від власника",
      metadata: {
        olxAccountType: "business",
        olxIsBusiness: true,
        ownerEvidenceLevel: "self_declared",
        filterConsidersSelfDeclaredOwner: true,
      },
      publishedAt: new Date("2026-10-03T23:40:00.000Z"),
    });
    const probeOlxProfile = vi.fn(async () => {
      throw new Error("detail transport down");
    });
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("olx", [listing])],
        config: config(),
        sink: drySink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => NOW,
        probeOlxProfile,
      },
      5,
    );
    expect(report.sentOk).toBe(0);
    expect(report.linkedSellerEvents.some((event) => event.outcome === "detail_transport_failure" || event.outcome === "detail_capacity_deferred")).toBe(
      true,
    );
  });

  it("rejects inventory at the current precise threshold and a 2026 profile year", async () => {
    const listing = olxListing("inv-1", {
      url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDinv0001.html",
      title: "Оренда від власника",
      metadata: {
        olxAccountType: "business",
        olxIsBusiness: true,
        ownerEvidenceLevel: "self_declared",
      },
    });
    const yearHtml = derivedOracleOfferDetailHtml(
      {
        id: 1,
        url: listing.url,
        title: listing.title,
        description: "Від власника.",
        business: true,
        isBusiness: true,
        user: { id: 9, name: "Оля", company_name: "", sellerType: null },
      },
      { memberSince: "січень 2026 р." },
    );
    const yearDecision = await createCycleOlxSellerVerifier({
      peers: [],
      now: () => NOW,
      timeoutMs: 1000,
      probeProfile: async () => ({ acquired: true, listingHtml: yearHtml, precisePropertyKeys: [] }),
    })(listing);
    expect(yearDecision.drop).toBe(true);
    expect(yearDecision.outcome).toBe("detail_registration_year_excluded");

    const inventoryDecision = await createCycleOlxSellerVerifier({
      peers: [],
      now: () => NOW,
      timeoutMs: 1000,
      fetchPage: async () => ({
        status: 200,
        finalUrl: listing.url,
        bodyText: derivedOracleOfferDetailHtml(
          {
            id: 1,
            url: listing.url,
            title: listing.title,
            description: "Від власника.",
            business: true,
            isBusiness: true,
            user: { id: 9, name: "Оля", company_name: "", sellerType: null },
          },
          { memberSince: "січень 2016 р." },
        ),
      }),
      probeProfile: async () => ({
        acquired: true,
        precisePropertyKeys: Array.from(
          { length: SELLER_INVENTORY_LIMIT_MIN },
          (_, index) => `Львів|вул. Тест ${index + 1}`,
        ),
      }),
    })(listing);
    expect(inventoryDecision.drop).toBe(true);
    expect(inventoryDecision.outcome).toBe("detail_inventory_limit");
  });

  it("keeps a LUN listing when OLX business acquisition throws", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const olx: ListingSourceAdapter = {
      source: "olx",
      fetchLatest: async () => [],
      healthCheck: async () => ({ source: "olx", healthy: false, checkedAt: NOW }),
      inspectLatest: async () => {
        throw new Error("business transport down");
      },
    };
    const lunListing: Listing = {
      source: "lun",
      sourceId: "lun-1",
      url: "https://lun.ua/uk/realty/lun-1",
      title: "Квартира",
      location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
      propertyType: "apartment",
      sellerType: "unknown",
      discoveredAt: NOW,
      publishedAt: new Date("2020-01-01T00:00:00.000Z"),
      metadata: { ownerEvidenceLevel: "private_unknown" },
    };
    const report = await runTelegramTestCycle(
      {
        adapters: [olx, adapter("lun", [lunListing])],
        config: config(),
        sink: drySink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => NOW,
        firstRunMode: "seed",
      },
      1,
    );
    expect(report.sourceAttempts.find((attempt) => attempt.source === "olx")?.ok).toBe(false);
    expect(report.sourceAttempts.find((attempt) => attempt.source === "lun")?.ok).toBe(true);
    expect(report.collectedRaw).toBe(1);
  });
});

describe("business catalog walk and probe budget", () => {
  function catalogHtml(ads: unknown[], pageNumber: number, totalPages: number): string {
    const state = { listing: { listing: { ads, pageNumber: pageNumber - 1, totalPages, totalElements: ads.length } } };
    const encoded = JSON.stringify(JSON.stringify(state));
    return `<!DOCTYPE html><html lang="uk"><head><title>OLX</title></head><body>
<script>window.__PRERENDERED_STATE__ = ${encoded};</script>
</body></html>`;
  }

  function ad(id: number, business: boolean) {
    const base = derivedOracleApartmentPrivateAd();
    return {
      ...base,
      id,
      isBusiness: business,
      business,
      url: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${id}.html`,
      urlPath: `/d/uk/obyavlenie/orenda-ID${id}.html`,
    };
  }

  function houseAd(id: number) {
    const base = derivedOracleHousePrivateAd();
    return {
      ...base,
      id,
      isBusiness: true,
      business: true,
      url: `https://www.olx.ua/d/uk/obyavlenie/budynok-ID${id}.html`,
      urlPath: `/d/uk/obyavlenie/budynok-ID${id}.html`,
    };
  }

  function mockBrowser(handler: (url: string) => string | "fail"): { urls: string[]; launch: () => Promise<Browser> } {
    const urls: string[] = [];
    const page = {
      on: vi.fn(),
      route: vi.fn(async () => undefined),
      goto: vi.fn(async (navUrl: string) => {
        urls.push(navUrl);
        const outcome = handler(navUrl);
        if (outcome === "fail") {
          const error = new Error(`page.goto: Timeout 45000ms exceeded navigating to "${navUrl}"`);
          error.name = "TimeoutError";
          throw error;
        }
        return {
          url: () => navUrl,
          status: () => 200,
          headers: () => ({ "content-type": "text/html; charset=utf-8" }),
          body: async () => Buffer.from(outcome, "utf8"),
          text: async () => outcome,
        };
      }),
      waitForLoadState: vi.fn(async () => undefined),
      content: vi.fn(async () => "<html></html>"),
      url: () => urls[urls.length - 1] ?? "https://www.olx.ua/",
      title: async () => "OLX",
      close: vi.fn(async () => undefined),
    } as unknown as Page;
    const browser = {
      newContext: async () =>
        ({
          newPage: async () => page,
          close: vi.fn(async () => undefined),
        }) as unknown as BrowserContext,
      close: vi.fn(async () => undefined),
    } as unknown as Browser;
    return { urls, launch: async () => browser };
  }

  function pageOf(url: string): number {
    const value = new URL(url).searchParams.get("page");
    return value === null ? 1 : Number(value);
  }

  function businessApartmentPages(urls: string[]): number[] {
    return urls
      .filter(
        (url) =>
          new URL(url).searchParams.get("search[private_business]") === "business" &&
          url.includes("/kvartiry/"),
      )
      .map(pageOf);
  }

  function businessHousePages(urls: string[]): number[] {
    return urls
      .filter(
        (url) =>
          new URL(url).searchParams.get("search[private_business]") === "business" && url.includes("/doma/"),
      )
      .map(pageOf);
  }

  async function walk(input: {
    apartmentPages: number;
    housePages?: number;
    failApartmentPage?: number;
    lastFullScanAt?: string;
    now?: Date;
    repeatPage1IdOnPage2?: boolean;
  }) {
    const housePages = input.housePages ?? 2;
    const mocked = mockBrowser((url) => {
      const page = pageOf(url);
      const houses = url.includes("/doma/");
      const account = new URL(url).searchParams.get("search[private_business]");
      if (account === "private") {
        return catalogHtml([ad(1000 + page, false)], page, 1);
      }
      if (houses) {
        return catalogHtml([houseAd(2000 + page)], page, housePages);
      }
      if (input.failApartmentPage === page) {
        return "fail";
      }
      const id = input.repeatPage1IdOnPage2 && page === 2 ? 3001 : 3000 + page;
      return catalogHtml([ad(id, true)], page, input.apartmentPages);
    });
    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      categoryBudgetMs: 120_000,
      totalBudgetMs: 180_000,
      cleanupBudgetMs: 1_000,
      launch: mocked.launch,
      now: () => input.now ?? NOW,
      ...(input.lastFullScanAt ? { businessLastFullScanAt: input.lastFullScanAt } : {}),
    });
    return { result, urls: mocked.urls };
  }

  it("fetches every declared business apartment page in one full snapshot", async () => {
    const { result, urls } = await walk({ apartmentPages: 25 });
    expect(businessApartmentPages(urls)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(businessHousePages(urls)).toEqual([1, 2]);
    expect(result.businessScan?.apartments.mode).toBe("full");
    expect(result.businessScan?.apartments.fullCoverage).toBe(true);
    expect(result.businessFullScan?.succeeded).toBe(true);
    expect(result.businessFullScan?.pagesExpected).toBe(25);
    expect(result.businessFullScan?.pagesFetched).toBe(25);
    expect(result.coverage?.coverageTruncated).toBe(false);
    expect(result.coverage?.olxBusinessLastFullScanAt).toBe(NOW.toISOString());
    expect(result.businessFullScan?.apartmentFullCoverage).toBe(true);
    expect(urls.filter((url) => businessApartmentPages([url])[0] === 1)).toHaveLength(1);
  });

  it("keeps page 1, degrades, and does not stamp a snapshot when a later page fails", async () => {
    const { result, urls } = await walk({ apartmentPages: 25, failApartmentPage: 13 });
    expect(businessApartmentPages(urls)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
    expect(result.businessScan?.apartments.fetchedPages).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(result.businessScan?.apartments.fullCoverage).toBe(false);
    expect(result.businessFullScan?.succeeded).toBe(false);
    expect(result.coverage?.olxBusinessLastFullScanAt).toBeUndefined();
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.privateScan?.apartments.status).toBe("complete");
    expect(result.listings.some((item) => item.sourceId === "1001")).toBe(true);
    expect(businessHousePages(urls)).toEqual([1, 2]);
    expect(result.listings.some((item) => item.sourceId === "3001")).toBe(true);
  });

  it("uses the totalPages declared on this cycle, including a change from 25 to 26", async () => {
    const first = await walk({ apartmentPages: 25 });
    const second = await walk({
      apartmentPages: 26,
      lastFullScanAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    expect(businessApartmentPages(first.urls)).toHaveLength(25);
    expect(businessApartmentPages(second.urls)).toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
    expect(second.result.businessScan?.apartments.fullCoverage).toBe(true);
    expect(second.result.businessScan?.apartments.expectedPages).toBe(26);
  });

  it("degrades instead of claiming a snapshot above the safety ceiling", async () => {
    const pages = OLX_BUSINESS_APARTMENT_PAGE_CEILING + 1;
    const { result, urls } = await walk({ apartmentPages: pages, housePages: 1 });
    expect(businessApartmentPages(urls)).toEqual([1]);
    expect(result.businessScan?.apartments.ceilingExceeded).toBe(true);
    expect(result.businessScan?.apartments.fullCoverage).toBe(false);
    expect(result.businessFullScan?.succeeded).toBe(false);
    expect(result.coverage?.olxBusinessLastFullScanAt).toBeUndefined();
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.notes.some((note) => note.includes("exceeds_ceiling"))).toBe(true);
  });

  it("fetches only business apartment page 1 on a hot cycle and does not call it full coverage", async () => {
    const recent = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    const { result, urls } = await walk({ apartmentPages: 25, lastFullScanAt: recent });
    expect(businessApartmentPages(urls)).toEqual([1]);
    expect(businessHousePages(urls)).toEqual([1, 2]);
    expect(result.businessScan?.apartments.mode).toBe("hot");
    expect(result.businessScan?.apartments.fullCoverage).toBe(false);
    expect(result.businessFullScan?.apartmentFullCoverage).toBe(false);
    expect(result.businessFullScan?.succeeded).toBe(false);
    expect(result.coverage?.coverageTruncated).toBe(false);
    expect(result.coverage?.olxBusinessLastFullScanAt).toBeUndefined();
    expect(result.businessFullScan?.ageStatus).toBe("healthy");
    expect(result.businessFullScan?.due).toBe(false);
  });

  it("does not emit the same page-1 business id twice in one full snapshot", async () => {
    const { result, urls } = await walk({ apartmentPages: 3, repeatPage1IdOnPage2: true, housePages: 1 });
    expect(businessApartmentPages(urls)).toEqual([1, 2, 3]);
    expect(result.listings.filter((item) => item.sourceId === "3001")).toHaveLength(1);
    expect(result.businessScan?.apartments.uniqueListingIds).toBe(2);
  });

  it("keeps one downstream listing when the same id appears in private and business", async () => {
    const mocked = mockBrowser((url) => {
      const account = new URL(url).searchParams.get("search[private_business]");
      const houses = url.includes("/doma/");
      if (houses) {
        return catalogHtml([], pageOf(url), 1);
      }
      return catalogHtml([ad(424242, account === "business")], pageOf(url), 1);
    });
    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      categoryBudgetMs: 30_000,
      totalBudgetMs: 60_000,
      cleanupBudgetMs: 1_000,
      launch: mocked.launch,
    });
    expect(result.listings.filter((item) => item.sourceId === "424242")).toHaveLength(1);
    expect(result.listings.find((item) => item.sourceId === "424242")?.metadata?.olxAccountCatalog).toBe(
      "private",
    );
  });

  it("defers a business account when the profile budget is exhausted and still allows private", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => NOW,
      timeoutMs: 1000,
      maxProfileProbes: 0,
      probeProfile: async () => {
        throw new Error("budget must win before a probe");
      },
    });
    const business = await verify(
      olxListing("cap-biz", {
        url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDcapbiz1.html",
        metadata: { olxAccountType: "business", olxIsBusiness: true, ownerEvidenceLevel: "self_declared" },
      }),
    );
    const privateListing = await verify(
      olxListing("cap-priv", {
        url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDcapprov.html",
        metadata: { olxAccountType: "private", olxIsBusiness: false, ownerEvidenceLevel: "private_unknown" },
      }),
    );
    expect(business.outcome).toBe("detail_capacity_deferred");
    expect(business.drop).toBe(false);
    expect(sellerVerificationDisposition(business)).toBe("defer");
    expect(privateListing.outcome).toBe("detail_unknown");
    expect(sellerVerificationDisposition(privateListing)).toBe("allow");
  });
});
