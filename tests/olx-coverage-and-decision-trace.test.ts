import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  appliedSchemaVersion,
  applyMigrations,
  SCHEMA_VERSION,
  sqliteMigrationSql,
} from "../src/storage/migrations.ts";
import {
  assessOlxBrowserWalk,
  buildOlxBrowserCategoryUrl,
  classifyOlxPageCatalogEvidence,
  crossedOlxPublicationBoundary,
  OLX_BROWSER_PAGE_BUDGET,
  olxBrowserCoverageNotes,
  olxCatchupKey,
  olxPublicationBoundaryKey,
  organicPublicationTimes,
  planOlxBrowserPages,
} from "../src/sources/olx/olx-browser.coverage.ts";
import { OLX_DISTANCE_KM } from "../src/sources/olx/olx.source.ts";
import {
  ListingDecisionTraceBuffer,
  listingDecisionTraceHas,
  selectListingDecisionTraceRows,
} from "../src/delivery/listing-decision-trace.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import {
  emptyOlxBrowserExtractResult,
  mapOlxBrowserExtractToFetchResult,
  OlxBrowserSource,
} from "../src/sources/olx/olx-browser.source.ts";
import {
  collectedSourceIdsForLog,
  runTelegramTestCycle,
} from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { FetchListingsOptions, ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { parseDomriaSearchIds } from "../src/sources/domria/domria-newest.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

function testConfig(overrides: Record<string, string> = {}) {
  resetConfigCache();
  return loadConfig({
    OWNER_ONLY: "true",
    SELLER_POLICY: "reject_intermediaries",
    ENABLE_DOMRIA: "false",
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
    ...overrides,
  });
}

function drySink() {
  return {
    chatId: "1",
    dryRun: true,
    sendListing: async () => ({
      ok: true,
      dryRun: true,
      attempts: 0,
      chatId: "1",
      messageCount: 1,
    }),
    sendText: async () => ({
      ok: true,
      dryRun: true,
      attempts: 0,
      chatId: "1",
      messageCount: 1,
    }),
  };
}

function listing(
  source: Listing["source"],
  sourceId: string,
  overrides: Partial<Listing> = {},
): Listing {
  return {
    source,
    sourceId,
    url: `https://example.test/${source}/${sourceId}`,
    title: `Listing ${sourceId}`,
    location: { raw: "Львів", city: "Львів" },
    propertyType: "apartment",
    sellerType: "owner",
    sellerConfidence: "high",
    sellerEvidence: ["test"],
    discoveredAt: new Date("2026-09-25T12:00:00.000Z"),
    publishedAt: new Date("2026-09-25T11:00:00.000Z"),
    metadata: { ownerEvidenceLevel: "platform_confirmed" },
    ...overrides,
  };
}

function adapterFor(
  source: Listing["source"],
  result: SourceFetchResult,
): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => result.listings,
    inspectLatest: async () => result,
    healthCheck: async () => result.health,
  };
}

describe("OLX browser coverage contract", () => {
  it("builds long-term Lviv URLs with requested 15km + newest-first keys (application BLOCKED)", () => {
    const apartments = buildOlxBrowserCategoryUrl("apartments");
    const houses = buildOlxBrowserCategoryUrl("houses");
    expect(apartments).toContain("/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/");
    expect(houses).toContain("/doma/arenda-domov/lvov/");
    expect(apartments).toContain(`search%5Bdist%5D=${OLX_DISTANCE_KM}`);
    expect(apartments).toContain("search%5Border%5D=created_at%3Adesc");
    expect(buildOlxBrowserCategoryUrl("apartments", { page: 2 })).toContain("page=2");
    expect(planOlxBrowserPages({}).length).toBe(OLX_BROWSER_PAGE_BUDGET);
    const notes = olxBrowserCoverageNotes({
      distanceKm: OLX_DISTANCE_KM,
      pageBudget: 2,
      pagesFetched: 2,
      boundaryReached: false,
      coverageTruncated: true,
    });
    expect(notes).toContain("olx_browser_radius_sort_status=blocked");
    expect(notes.some((n) => n.includes("url_retention_or_api_analogy_is_not_html_proof"))).toBe(
      true,
    );
  });

  it("keeps time-stop off while HTML sort is unverified; verified mode requires all dated + no undated", () => {
    const watermark = new Date("2026-09-25T12:00:00.000Z");
    const allOld = [
      new Date("2026-09-24T10:00:00.000Z"),
      new Date("2026-09-24T09:00:00.000Z"),
      new Date("2026-09-24T08:00:00.000Z"),
    ];
    // Default (sort BLOCKED): never cross on dates alone.
    expect(crossedOlxPublicationBoundary(allOld, watermark)).toBe(false);
    expect(
      crossedOlxPublicationBoundary(
        [new Date("2026-09-20T12:00:00.000Z")],
        watermark,
      ),
    ).toBe(false);
    // Mixed dates / majority-old still false when sort unverified.
    expect(
      crossedOlxPublicationBoundary(
        [
          new Date("2026-09-25T11:50:00.000Z"),
          new Date("2026-09-24T09:00:00.000Z"),
          new Date("2026-09-24T08:00:00.000Z"),
        ],
        watermark,
      ),
    ).toBe(false);
    // Future verified-sort path: all dated old, no undated organic.
    expect(
      crossedOlxPublicationBoundary(allOld, watermark, undefined, {
        sortVerified: true,
        undatedOrganicCount: 0,
      }),
    ).toBe(true);
    expect(
      crossedOlxPublicationBoundary(allOld, watermark, undefined, {
        sortVerified: true,
        undatedOrganicCount: 1,
      }),
    ).toBe(false);
    expect(
      crossedOlxPublicationBoundary(
        [
          new Date("2026-09-25T11:50:00.000Z"),
          new Date("2026-09-24T09:00:00.000Z"),
          new Date("2026-09-24T08:00:00.000Z"),
        ],
        watermark,
        undefined,
        { sortVerified: true },
      ),
    ).toBe(false);
    expect(
      organicPublicationTimes([
        {
          publishedAt: new Date("2026-09-20T12:00:00.000Z"),
          metadata: { olxIsPromoted: true },
        },
      ]),
    ).toHaveLength(0);
  });

  it("treats budget exhaustion as truncated catch-up and ignores zero cards without confirmed empty", () => {
    expect(
      assessOlxBrowserWalk({
        mode: "steady",
        plannedPages: [1, 2],
        fetchedPages: [1, 2],
        lastPageCardCount: 30,
        lastPageCatalogEvidence: "has_listings",
        crossedBoundary: false,
        failed: false,
        previousCommitted: "2026-09-24T10:00:00.000Z",
      }),
    ).toMatchObject({
      coverageTruncated: true,
      boundaryReached: false,
      catchup: { resumePage: 3, target: "2026-09-24T10:00:00.000Z" },
    });
    expect(
      assessOlxBrowserWalk({
        mode: "steady",
        plannedPages: [1, 2],
        fetchedPages: [1],
        lastPageCardCount: 0,
        lastPageCatalogEvidence: "unknown",
        crossedBoundary: false,
        failed: false,
      }).boundaryReached,
    ).toBe(false);
    expect(
      assessOlxBrowserWalk({
        mode: "steady",
        plannedPages: [1, 2],
        fetchedPages: [1],
        lastPageCardCount: 0,
        lastPageCatalogEvidence: "confirmed_empty",
        crossedBoundary: false,
        failed: false,
        newestOrganic: "2026-09-25T11:00:00.000Z",
      }),
    ).toEqual({
      boundaryReached: true,
      coverageTruncated: false,
      committed: "2026-09-25T11:00:00.000Z",
      catchup: null,
    });
    expect(
      assessOlxBrowserWalk({
        mode: "seed",
        plannedPages: [1],
        fetchedPages: [1],
        lastPageCardCount: 40,
        lastPageCatalogEvidence: "has_listings",
        crossedBoundary: false,
        failed: false,
        newestOrganic: "2026-09-25T11:00:00.000Z",
      }),
    ).toEqual({
      boundaryReached: true,
      coverageTruncated: false,
      committed: "2026-09-25T11:00:00.000Z",
      catchup: null,
    });
  });
});

describe("OLX page catalog evidence", () => {
  it("confirms empty only with prerendered ads path and zero raw offers", () => {
    expect(
      classifyOlxPageCatalogEvidence({
        listings: [],
        accessibilityOk: true,
        rawOfferCount: 0,
        htmlDiagnostics: { hasPrerenderedState: true, prerenderedAdsPathFound: true },
      }),
    ).toBe("confirmed_empty");
  });

  it("marks accessible page with missing/broken listing state as parse_failed", () => {
    expect(
      classifyOlxPageCatalogEvidence({
        listings: [],
        accessibilityOk: true,
        rawOfferCount: 0,
        htmlDiagnostics: { hasPrerenderedState: false, prerenderedAdsPathFound: false },
      }),
    ).toBe("parse_failed");
    expect(
      classifyOlxPageCatalogEvidence({
        listings: [],
        accessibilityOk: true,
        rawOfferCount: 0,
        htmlDiagnostics: { hasPrerenderedState: true, prerenderedAdsPathFound: false },
        rejections: [{ reason: "state parsed but listing.listing.ads was missing or empty" }],
      }),
    ).toBe("parse_failed");
  });

  it("does not treat page-two parse failure after page one as end of catalog", () => {
    const assessed = assessOlxBrowserWalk({
      mode: "catchup",
      plannedPages: [1, 2],
      fetchedPages: [1, 2],
      lastPageCardCount: 0,
      lastPageCatalogEvidence: "parse_failed",
      crossedBoundary: false,
      failed: true,
      newestOrganic: "2026-09-25T11:00:00.000Z",
      catchupTarget: "2026-09-25T11:00:00.000Z",
    });
    expect(assessed.boundaryReached).toBe(false);
    expect(assessed.coverageTruncated).toBe(true);
    expect(assessed.committed).toBeUndefined();
    expect(assessed.catchup?.resumePage).toBe(2);
  });

  it("keeps partial cards with parse failures as has_listings", () => {
    expect(
      classifyOlxPageCatalogEvidence({
        listings: [{ id: 1 }],
        accessibilityOk: true,
        rawOfferCount: 5,
        rejections: [{ reason: "rejected_missing_location" }],
        htmlDiagnostics: { hasPrerenderedState: true, prerenderedAdsPathFound: true },
      }),
    ).toBe("has_listings");
  });
});

describe("OLX publication watermark wiring", () => {
  it("passes per-category watermarks from inspectLatest into extract", async () => {
    const extract = vi.fn(async () =>
      emptyOlxBrowserExtractResult({
        listings: [listing("olx", "1")],
        accessibilityOk: true,
        extractionOk: true,
        coverage: {
          pagesFetched: 1,
          cardsFetched: 1,
          boundaryReached: true,
          coverageTruncated: false,
          committedBoundary: { apartment: "2026-09-25T11:00:00.000Z" },
        },
        apartments: {
          ...emptyOlxBrowserExtractResult().apartments,
          accessibilityOk: true,
          validatedListingCount: 1,
          listings: [listing("olx", "1")],
          httpStatus: 200,
        },
        houses: {
          ...emptyOlxBrowserExtractResult().houses,
          accessibilityOk: true,
          validatedListingCount: 0,
          listings: [],
          httpStatus: 200,
        },
      }),
    );
    const source = new OlxBrowserSource({ extract });
    await source.inspectLatest({
      publicationWatermarks: {
        apartment: new Date("2026-09-24T10:00:00.000Z"),
        house: new Date("2026-09-23T10:00:00.000Z"),
      },
    });
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationWatermarks: {
          apartments: new Date("2026-09-24T10:00:00.000Z"),
          houses: new Date("2026-09-23T10:00:00.000Z"),
        },
      }),
    );
  });

  it("autonomous seed commits monitoring boundary; catch-up advances without manual SQL", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const store = new DurableDeliveryStore(db);
    const config = testConfig({ ENABLE_OLX_BROWSER: "true" });
    let call = 0;
    const seenOptions: Array<{
      watermarks?: FetchListingsOptions["publicationWatermarks"];
      catchup?: FetchListingsOptions["olxCatchup"];
      bootstrap?: Date;
    }> = [];
    const olx: ListingSourceAdapter = {
      source: "olx",
      fetchLatest: async () => [],
      healthCheck: async () => ({
        source: "olx",
        healthy: true,
        checkedAt: new Date(),
      }),
      inspectLatest: async (options) => {
        call += 1;
        seenOptions.push({
          ...(options?.publicationWatermarks
            ? { watermarks: options.publicationWatermarks }
            : {}),
          ...(options?.olxCatchup ? { catchup: options.olxCatchup } : {}),
          ...(options?.olxBootstrapTarget
            ? { bootstrap: options.olxBootstrapTarget }
            : {}),
        });
        if (call === 1) {
          // Fresh DB / no OLX keys: seed page-1 monitoring start.
          expect(options?.publicationWatermarks).toBeUndefined();
          expect(options?.olxCatchup).toBeUndefined();
          return {
            listings: [
              listing("olx", "seed-a", {
                publishedAt: new Date("2026-09-25T11:00:00.000Z"),
              }),
              listing("olx", "seed-b", {
                publishedAt: new Date("2026-09-25T10:30:00.000Z"),
              }),
            ],
            transport: "stock_playwright_chromium",
            dataKind: "LIVE DATA",
            resultKind: "ok",
            coverage: {
              pagesFetched: 1,
              cardsFetched: 2,
              boundaryReached: true,
              coverageTruncated: false,
              committedBoundary: { apartment: "2026-09-25T11:00:00.000Z" },
              catchup: { apartment: null, house: null },
            },
            health: {
              source: "olx",
              healthy: true,
              checkedAt: new Date(),
              resultKind: "ok",
            },
          };
        }
        if (call === 2) {
          // Steady with watermark; more pages than budget → catch-up cursor.
          expect(options?.publicationWatermarks?.apartment?.toISOString()).toBe(
            "2026-09-25T11:00:00.000Z",
          );
          return {
            listings: [
              listing("olx", "p1"),
              listing("olx", "p2"),
            ],
            transport: "stock_playwright_chromium",
            dataKind: "LIVE DATA",
            resultKind: "ok",
            coverage: {
              pagesFetched: 2,
              cardsFetched: 2,
              boundaryReached: false,
              coverageTruncated: true,
              catchup: {
                apartment: { target: "2026-09-25T11:00:00.000Z", resumePage: 3 },
              },
            },
            health: {
              source: "olx",
              healthy: false,
              checkedAt: new Date(),
              resultKind: "ok",
              message: "truncated",
            },
          };
        }
        // Restart mid catch-up: resumePage persisted; page 1 rechecked for new listings.
        expect(options?.olxCatchup?.apartment?.resumePage).toBe(3);
        expect(options?.publicationWatermarks?.apartment?.toISOString()).toBe(
          "2026-09-25T11:00:00.000Z",
        );
        return {
          listings: [listing("olx", "new-during-catchup")],
          transport: "stock_playwright_chromium",
          dataKind: "LIVE DATA",
          resultKind: "ok",
          coverage: {
            pagesFetched: 2,
            cardsFetched: 1,
            boundaryReached: true,
            coverageTruncated: false,
            committedBoundary: { apartment: "2026-09-25T12:00:00.000Z" },
            catchup: { apartment: null },
          },
          health: {
            source: "olx",
            healthy: true,
            checkedAt: new Date(),
            resultKind: "ok",
          },
        };
      },
    };
    await runTelegramTestCycle(
      {
        adapters: [olx],
        config,
        sink: drySink() as never,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-25T12:00:00.000Z"),
        firstRunMode: "seed",
      },
      1,
    );
    const boundary1 = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(olxPublicationBoundaryKey("apartments")) as { value: string };
    expect(boundary1.value).toBe("2026-09-25T11:00:00.000Z");
    expect(
      db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(olxCatchupKey("apartments")),
    ).toBeUndefined();

    await runTelegramTestCycle(
      {
        adapters: [olx],
        config,
        sink: drySink() as never,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-25T12:10:00.000Z"),
        firstRunMode: "seed",
      },
      2,
    );
    const catchupRow = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(olxCatchupKey("apartments")) as { value: string };
    expect(JSON.parse(catchupRow.value)).toMatchObject({ resumePage: 3 });

    await runTelegramTestCycle(
      {
        adapters: [olx],
        config,
        sink: drySink() as never,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-25T12:20:00.000Z"),
        firstRunMode: "seed",
      },
      3,
    );
    expect(
      db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(olxCatchupKey("apartments")),
    ).toBeUndefined();
    const boundary3 = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(olxPublicationBoundaryKey("apartments")) as { value: string };
    expect(boundary3.value).toBe("2026-09-25T12:00:00.000Z");
    expect(seenOptions).toHaveLength(3);
    expect(seenOptions[0]?.watermarks).toBeUndefined();
    expect(seenOptions[2]?.catchup?.apartment?.resumePage).toBe(3);
    resetConfigCache();
  });

  it("existing baseline without OLX watermark keys supplies bootstrap target", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const store = new DurableDeliveryStore(db);
    db.prepare(
      `INSERT INTO source_baselines (source, established_at, last_success_at, seed_listing_count)
       VALUES ('olx', '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z', 10)`,
    ).run();
    const config = testConfig({ ENABLE_OLX_BROWSER: "true" });
    let sawBootstrap: Date | undefined;
    const olx: ListingSourceAdapter = {
      source: "olx",
      fetchLatest: async () => [],
      healthCheck: async () => ({ source: "olx", healthy: true, checkedAt: new Date() }),
      inspectLatest: async (options) => {
        sawBootstrap = options?.olxBootstrapTarget;
        return {
          listings: [listing("olx", "boot-1")],
          transport: "stock_playwright_chromium",
          dataKind: "LIVE DATA",
          resultKind: "ok",
          coverage: {
            pagesFetched: 1,
            cardsFetched: 1,
            boundaryReached: true,
            coverageTruncated: false,
            committedBoundary: { apartment: "2026-09-25T11:00:00.000Z" },
            catchup: { apartment: null },
          },
          health: { source: "olx", healthy: true, checkedAt: new Date(), resultKind: "ok" },
        };
      },
    };
    await runTelegramTestCycle(
      {
        adapters: [olx],
        config,
        sink: drySink() as never,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-25T12:00:00.000Z"),
        firstRunMode: "seed",
      },
      1,
    );
    expect(sawBootstrap?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    resetConfigCache();
  });

  it("acquired-card cap blocks boundary commit past discarded cards", () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      listing("olx", `cap-${i}`, { propertyType: "apartment" }),
    );
    const mapped = mapOlxBrowserExtractToFetchResult(
      emptyOlxBrowserExtractResult({
        listings: many,
        accessibilityOk: true,
        extractionOk: true,
        coverage: {
          pagesFetched: 2,
          cardsFetched: 130,
          boundaryReached: true,
          coverageTruncated: false,
          committedBoundary: { apartment: "2026-09-25T12:00:00.000Z" },
        },
        apartments: {
          ...emptyOlxBrowserExtractResult().apartments,
          accessibilityOk: true,
          validatedListingCount: 130,
          listings: many,
          httpStatus: 200,
        },
      }),
      { startedMs: Date.now() },
    );
    expect(mapped.coverage?.coverageTruncated).toBe(true);
    expect(mapped.coverage?.boundaryReached).toBe(false);
    expect(mapped.coverage?.committedBoundary).toBeUndefined();
    expect(mapped.listings.length).toBeLessThanOrEqual(120);
  });
});

describe("MIGRATION_11 profile_likely_intermediary", () => {
  it("upgrades schema-9 with verification rows and persists the new verdict", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (let version = 1; version <= 9; version += 1) {
      db.exec("BEGIN IMMEDIATE;");
      db.exec(sqliteMigrationSql(version));
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-09-01T00:00:00.000Z",
      );
      db.exec("COMMIT;");
    }
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '9')").run();
    const now = "2026-09-25T10:00:00.000Z";
    const expires = "2026-10-25T10:00:00.000Z";
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', 'keep-owner', 'https://www.olx.ua/d/uk/obyavlenie/ID1.html',
         'confirmed_owner', 'owner', ?, ?, NULL, NULL)`,
    ).run(now, expires);
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', 'keep-unknown', 'https://www.olx.ua/d/uk/obyavlenie/ID2.html',
         'unknown', 'unclear', ?, ?, NULL, NULL)`,
    ).run(now, expires);

    expect(appliedSchemaVersion(db)).toBe(9);
    expect(() =>
      db.prepare(
        `INSERT INTO external_seller_verifications (
           source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
           checked_at, expires_at
         ) VALUES ('olx', 'likely', 'https://www.olx.ua/d/uk/obyavlenie/IDx.html',
           'profile_likely_intermediary', '3 addresses', ?, ?)`,
      ).run(now, expires),
    ).toThrow(/CHECK constraint failed|constraint/i);

    expect(applyMigrations(db)).toBe(SCHEMA_VERSION);
    expect(appliedSchemaVersion(db)).toBe(11);
    expect(SCHEMA_VERSION).toBe(11);

    const preserved = db
      .prepare(
        `SELECT external_listing_id AS id, seller_verdict AS verdict
         FROM external_seller_verifications ORDER BY external_listing_id`,
      )
      .all() as Array<{ id: string; verdict: string }>;
    expect(preserved).toEqual([
      { id: "keep-owner", verdict: "confirmed_owner" },
      { id: "keep-unknown", verdict: "unknown" },
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'external_seller_verifications_expires_idx'",
        )
        .get(),
    ).toBeTruthy();

    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at
       ) VALUES ('olx', 'tok', 'https://www.olx.ua/d/uk/obyavlenie/orenda-IDtok.html',
         'profile_likely_intermediary', 'distinct_addresses=3', ?, ?)`,
    ).run(now, expires);

    const row = db
      .prepare(
        `SELECT seller_verdict AS verdict FROM external_seller_verifications
         WHERE external_listing_id = 'tok'`,
      )
      .get() as { verdict: string };
    expect(row.verdict).toBe("profile_likely_intermediary");

    let probeCalls = 0;
    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [],
      now: () => new Date(now),
      timeoutMs: 5_000,
      profileLikelyPolicy: "reject",
      fetchPage: async () => {
        throw new Error("cache should short-circuit");
      },
      probeProfile: async () => {
        probeCalls += 1;
        return {
          acquired: true,
          totalPages: 1,
          totalElements: 3,
          visibleAds: 3,
          realEstateAds: 3,
          propertyKeys: ["a", "b", "c"],
          precisePropertyKeys: ["a", "b", "c"],
        };
      },
    });
    const cached = await verify(
      listing("lun", "linked-1", {
        metadata: {
          ownerEvidenceLevel: "platform_confirmed",
          originalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDtok.html",
        },
        sellerType: "unknown",
      }),
    );
    expect(cached.outcome).toBe("detail_profile_likely");
    expect(cached.drop).toBe(true);
    expect(cached.requested).toBe(false);
    expect(probeCalls).toBe(0);

    const store = new DurableDeliveryStore(db);
    const config = testConfig({ ENABLE_LUN: "true" });
    const lunResult: SourceFetchResult = {
      listings: [listing("lun", "lun-ok")],
      transport: "https",
      dataKind: "LIVE DATA",
      resultKind: "ok",
      health: { source: "lun", healthy: true, checkedAt: new Date(), resultKind: "ok" },
    };
    const report = await runTelegramTestCycle(
      {
        adapters: [adapterFor("lun", lunResult)],
        config,
        sink: drySink() as never,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-25T12:00:00.000Z"),
        firstRunMode: "seed",
      },
      3,
    );
    expect(report.sourceAttempts.some((a) => a.source === "lun" && a.ok)).toBe(true);
    expect(report.hasSourceFailures).toBe(false);
    resetConfigCache();
  });
});

describe("listing decision trace fairness", () => {
  it("distinguishes collected-but-rejected from never-observed", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const trace = new ListingDecisionTraceBuffer(42);
    trace.record("olx", "111", "collected", "source_fetch");
    trace.record("olx", "111", "rejected_seller", "intermediary");
    expect(trace.flush(db)).toMatchObject({ written: 2, dropped: 0, truncated: false });
    expect(listingDecisionTraceHas(db, { source: "olx", sourceId: "111", stage: "collected" })).toBe(
      true,
    );
    expect(
      listingDecisionTraceHas(db, { source: "olx", sourceId: "111", stage: "rejected_seller" }),
    ).toBe(true);
    expect(listingDecisionTraceHas(db, { source: "olx", sourceId: "999" })).toBe(false);
  });

  it("round-robins terminal decisions across sources when over budget", () => {
    const rows = [];
    for (const source of ["domria", "lun", "olx", "rieltor"] as const) {
      for (let i = 0; i < 80; i += 1) {
        rows.push({
          cycleId: 1,
          source,
          sourceId: `${source}-${i}`,
          stage: "collected" as const,
          reasonCode: "source_fetch",
        });
        rows.push({
          cycleId: 1,
          source,
          sourceId: `${source}-${i}`,
          stage: "normalized" as const,
          reasonCode: "listing_object",
        });
        rows.push({
          cycleId: 1,
          source,
          sourceId: `${source}-${i}`,
          stage: "rejected_seller" as const,
          reasonCode: "intermediary",
        });
      }
    }
    expect(rows.length).toBeGreaterThan(400);
    const selected = selectListingDecisionTraceRows(rows, 400);
    expect(selected.kept.length).toBe(400);
    expect(selected.dropped).toBe(rows.length - 400);
    const terminals = selected.kept.filter((r) => r.stage === "rejected_seller");
    const bySource = new Map<string, number>();
    for (const row of terminals) {
      bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1);
    }
    expect(bySource.get("domria")).toBeGreaterThan(20);
    expect(bySource.get("lun")).toBeGreaterThan(20);
    expect(bySource.get("olx")).toBeGreaterThan(20);
    expect(bySource.get("rieltor")).toBeGreaterThan(20);
    // Absence from truncated trace is not proof of non-collection.
    expect(listingDecisionTraceHas).toBeTypeOf("function");
  });

  it("exposes collectedSourceIds completeness metadata", () => {
    const many = Array.from({ length: 150 }, (_, i) => listing("olx", `id-${i}`));
    const sample = collectedSourceIdsForLog(many, 120);
    expect(sample.ids).toHaveLength(120);
    expect(sample.totalUnique).toBe(150);
    expect(sample.complete).toBe(false);
    expect(sample.ids.includes("id-149")).toBe(false);
  });

  it("multi-source cycle reports honest truncation when event budget is exceeded", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const store = new DurableDeliveryStore(db);
    const config = testConfig({
      ENABLE_DOMRIA: "true",
      ENABLE_LUN: "true",
      ENABLE_RIELTOR: "true",
    });
    const makeMany = (source: Listing["source"], n: number) =>
      Array.from({ length: n }, (_, i) =>
        listing(source, `${source}-${i}`, {
          url: `https://example.test/${source}/${i}`,
        }),
      );
    const adapters: ListingSourceAdapter[] = (
      [
        ["domria", makeMany("domria", 90)],
        ["lun", makeMany("lun", 90)],
        ["rieltor", makeMany("rieltor", 90)],
      ] as const
    ).map(([source, listings]) =>
      adapterFor(source, {
        listings,
        transport: "https",
        dataKind: "LIVE DATA",
        resultKind: "ok",
        health: { source, healthy: true, checkedAt: new Date(), resultKind: "ok" },
      }),
    );
    // Establish baselines so the measured cycle records full decision paths.
    await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: drySink() as never,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-25T11:00:00.000Z"),
        firstRunMode: "seed",
      },
      8,
    );
    const report = await runTelegramTestCycle(
      {
        adapters: (
          [
            ["domria", makeMany("domria", 90).map((l, i) => listing("domria", `domria-n-${i}`))],
            ["lun", makeMany("lun", 90).map((l, i) => listing("lun", `lun-n-${i}`))],
            [
              "rieltor",
              makeMany("rieltor", 90).map((l, i) => listing("rieltor", `rieltor-n-${i}`)),
            ],
          ] as const
        ).map(([source, listings]) =>
          adapterFor(source, {
            listings,
            transport: "https",
            dataKind: "LIVE DATA",
            resultKind: "ok",
            health: { source, healthy: true, checkedAt: new Date(), resultKind: "ok" },
          }),
        ),
        config,
        sink: drySink() as never,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-25T12:00:00.000Z"),
        firstRunMode: "seed",
      },
      9,
    );
    expect(report.decisionTrace?.truncated).toBe(true);
    expect(report.decisionTrace?.dropped).toBeGreaterThan(0);
    expect(report.decisionTrace?.totalAttempted).toBeGreaterThan(400);
    for (const attempt of report.sourceAttempts) {
      if (attempt.listingCount && attempt.listingCount > 120) {
        expect(attempt.collectedSourceIdsComplete).toBe(false);
        expect(attempt.collectedSourceIdsTotal).toBe(attempt.listingCount);
      }
    }
    resetConfigCache();
  });
});

describe("DIM.RIA searchEngine parse distinctions", () => {
  it("keeps empty items as ok/empty and HTML/missing structure as parser failure", () => {
    expect(parseDomriaSearchIds('{"count":0,"items":[]}')).toEqual({
      ok: true,
      ids: [],
      empty: true,
    });
    expect(parseDomriaSearchIds("<!DOCTYPE html><html></html>").ok).toBe(false);
    if (!parseDomriaSearchIds("<html></html>").ok) {
      const failed = parseDomriaSearchIds("<html></html>");
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.reason).toBe("html_page_not_search_json");
      }
    }
    expect(parseDomriaSearchIds('{"count":1}').ok).toBe(false);
  });
});
