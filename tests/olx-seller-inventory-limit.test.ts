import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import { CONFIRMED_SELLER_CACHE_MS } from "../src/delivery/rieltor-detail-seller.ts";
import {
  SELLER_INVENTORY_LIMIT_MIN,
  SELLER_INVENTORY_LIMIT_REASON,
} from "../src/delivery/seller-profile.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import {
  classifyOlxProfileInventory,
  mergeOlxProfilePages,
  parseOlxProfileInventory,
  type OlxProfileSnapshot,
} from "../src/sources/olx/olx-seller-profile.ts";
import { applyMigrations } from "../src/storage/migrations.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";

const published = new Date("2026-09-22T09:00:00.000Z");
const now = new Date("2026-09-22T10:00:00.000Z");
const TOKEN = "11inv05";
const OLX_URL = `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${TOKEN}.html`;

function preciseAd(id: number, city: string, street: string): unknown {
  return {
    id,
    category: { type: "real_estate" },
    location: {
      city: { name: city },
      district: { name: "центр" },
      streetName: street,
    },
  };
}

function snapshotWithPrecise(streets: Array<{ city: string; street: string }>): OlxProfileSnapshot {
  const ads = streets.map((item, index) => preciseAd(index + 1, item.city, item.street));
  return parseOlxProfileInventory({
    userListing: {
      userListing: {
        totalPages: 1,
        totalElements: ads.length,
        ads: [
          ...ads,
          { id: 900, category: { type: "electronics" }, title: "телефон" },
        ],
      },
    },
  });
}

function lunLinked(): Listing {
  return {
    source: "lun",
    sourceId: "lun-inv-1",
    url: "https://lun.ua/uk/realty/lun-inv-1",
    title: "Квартира",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: published,
    publishedAt: published,
    metadata: { originalUrl: OLX_URL, ownerEvidenceLevel: "platform_confirmed" },
  };
}

function olxListing(meta: Record<string, unknown> = {}): Listing {
  return {
    source: "olx",
    sourceId: TOKEN,
    url: OLX_URL,
    title: "Квартира",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: published,
    publishedAt: published,
    metadata: { urlToken: TOKEN, ...meta },
  };
}

describe("seller_inventory_limit classification", () => {
  it("rejects at 5 precise properties and keeps 4 below the inventory exclusion", () => {
    const four = snapshotWithPrecise([
      { city: "Львів", street: "вул. А 1" },
      { city: "Львів", street: "вул. Б 2" },
      { city: "Київ", street: "вул. В 3" },
      { city: "Одеса", street: "вул. Г 4" },
    ]);
    expect(four.precisePropertyKeys).toHaveLength(4);
    expect(classifyOlxProfileInventory(four).verdict).not.toBe("seller_inventory_limit");

    const five = snapshotWithPrecise([
      { city: "Львів", street: "вул. А 1" },
      { city: "Львів", street: "вул. Б 2" },
      { city: "Київ", street: "вул. В 3" },
      { city: "Одеса", street: "вул. Г 4" },
      { city: "Харків", street: "вул. Д 5" },
    ]);
    expect(five.precisePropertyKeys).toHaveLength(SELLER_INVENTORY_LIMIT_MIN);
    const decision = classifyOlxProfileInventory(five);
    expect(decision.verdict).toBe("seller_inventory_limit");
    expect(decision.evidence).toContain(SELLER_INVENTORY_LIMIT_REASON);
    expect(decision.evidence).toContain("distinct_precise_properties=5");
  });

  it("counts duplicate ads for one property once and ignores non-RE ads", () => {
    const ads = [
      preciseAd(1, "Львів", "вул. Одна 10"),
      preciseAd(2, "Львів", "вул. Одна 10"),
      preciseAd(3, "Львів", "вул. Одна 10"),
      { id: 4, category: { type: "electronics" } },
      preciseAd(5, "Київ", "вул. Дві 20"),
      preciseAd(6, "Одеса", "вул. Три 30"),
      preciseAd(7, "Харків", "вул. Чотири 40"),
      preciseAd(8, "Дніпро", "вул. Пʼять 50"),
    ];
    const snap = parseOlxProfileInventory({
      userListing: { userListing: { totalPages: 1, totalElements: ads.length, ads } },
    });
    expect(snap.realEstateAds).toBe(7);
    expect(snap.precisePropertyKeys).toHaveLength(5);
    expect(classifyOlxProfileInventory(snap).verdict).toBe("seller_inventory_limit");
  });

  it("counts rental and sale real-estate offers across cities toward the limit", () => {
    // category.type=real_estate covers rent and sale; cities differ.
    const snap = snapshotWithPrecise([
      { city: "Львів", street: "вул. Оренда 1" },
      { city: "Київ", street: "вул. Продаж 2" },
      { city: "Одеса", street: "вул. Оренда 3" },
      { city: "Харків", street: "вул. Продаж 4" },
      { city: "Дніпро", street: "вул. Оренда 5" },
    ]);
    expect(classifyOlxProfileInventory(snap).verdict).toBe("seller_inventory_limit");
  });

  it("keeps incomplete multi-page inventory unknown (not verified below-threshold)", () => {
    // 2 precise is below likely (3) and inventory (5); unread pages must stay unknown.
    const page1 = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 3,
          totalElements: 20,
          ads: [
            preciseAd(1, "Львів", "вул. А 1"),
            preciseAd(2, "Львів", "вул. Б 2"),
          ],
        },
      },
    });
    expect(page1.pagesFetched).toBe(1);
    expect(page1.precisePropertyKeys).toHaveLength(2);
    const decision = classifyOlxProfileInventory(page1);
    expect(decision.verdict).toBe("unknown");
    expect(decision.evidence).toContain("olx_inventory_incomplete=1");
    expect(decision.verdict).not.toBe("seller_inventory_limit");
    expect(decision.verdict).not.toBe("profile_likely_intermediary");

    const page2 = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 3,
          totalElements: 20,
          ads: [
            preciseAd(3, "Київ", "вул. В 3"),
            preciseAd(4, "Одеса", "вул. Г 4"),
            preciseAd(5, "Харків", "вул. Д 5"),
          ],
        },
      },
    });
    const merged = mergeOlxProfilePages(page1, page2);
    expect(merged.pagesFetched).toBe(2);
    expect(merged.precisePropertyKeys).toHaveLength(5);
    // Once 5 precise properties are established, exclude — unread pages are unnecessary.
    expect(classifyOlxProfileInventory(merged).verdict).toBe("seller_inventory_limit");
  });

  it("keeps four visible precise properties unknown while later profile pages are unread", () => {
    const page1 = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 3,
          totalElements: 20,
          ads: [
            preciseAd(1, "Львів", "вул. А 1"),
            preciseAd(2, "Львів", "вул. Б 2"),
            preciseAd(3, "Київ", "вул. В 3"),
            preciseAd(4, "Одеса", "вул. Г 4"),
          ],
        },
      },
    });
    expect(page1.precisePropertyKeys).toHaveLength(4);
    const decision = classifyOlxProfileInventory(page1);
    expect(decision.verdict).toBe("unknown");
    expect(decision.verdict).not.toBe("profile_likely_intermediary");
    expect(decision.verdict).not.toBe("seller_inventory_limit");
    expect(decision.evidence).toContain("olx_inventory_incomplete=1");
  });
});

describe("seller_inventory_limit via createCycleOlxSellerVerifier", () => {
  it("rejects linked LUN when same-cycle peer reports ≥5 precise properties", async () => {
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked(), olxListing({ distinctPreciseRealEstateProperties: 5 })],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        throw new Error("must not detail-fetch");
      },
      probeProfile: async () => {
        throw new Error("must not probe when peer inventory is known");
      },
    });
    const decision = await verify(lunLinked());
    expect(fetches).toBe(0);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("same_cycle_inventory_limit");
    expect(decision.evidence).toBe(SELLER_INVENTORY_LIMIT_REASON);
  });

  it("rejects linked LUN from cached seller_inventory_limit", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const checkedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + CONFIRMED_SELLER_CACHE_MS).toISOString();
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', ?, ?, 'seller_inventory_limit', ?, ?, ?, NULL, NULL)`,
    ).run(TOKEN, OLX_URL, SELLER_INVENTORY_LIMIT_REASON, checkedAt, expiresAt);

    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [lunLinked(), olxListing()],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        throw new Error("cache inventory must win");
      },
    });
    const decision = await verify(lunLinked());
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("cache_inventory_limit");
  });

  it("rejects direct OLX when profile probe finds ≥5 precise properties", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      probeProfile: async () =>
        snapshotWithPrecise([
          { city: "Львів", street: "вул. А 1" },
          { city: "Львів", street: "вул. Б 2" },
          { city: "Київ", street: "вул. В 3" },
          { city: "Одеса", street: "вул. Г 4" },
          { city: "Харків", street: "вул. Д 5" },
        ]),
    });
    const decision = await verify(olxListing());
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_inventory_limit");
    expect(decision.evidence).toContain(SELLER_INVENTORY_LIMIT_REASON);
  });

  it("detail path rejects linked LUN after profile inventory of 5", async () => {
    const html = derivedOracleOfferDetailHtml({
      id: 11,
      url: OLX_URL,
      title: "Квартира",
      description: "оренда",
      user: { name: "Продавець", company_name: null, sellerType: null },
      isBusiness: false,
    }).replace(
      "</body>",
      `<a href="/uk/list/user/invseller/">усі оголошення</a></body>`,
    );
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked()],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: html }),
      probeProfile: async () =>
        snapshotWithPrecise([
          { city: "Львів", street: "вул. А 1" },
          { city: "Львів", street: "вул. Б 2" },
          { city: "Київ", street: "вул. В 3" },
          { city: "Одеса", street: "вул. Г 4" },
          { city: "Харків", street: "вул. Д 5" },
        ]),
    });
    const decision = await verify(lunLinked());
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_inventory_limit");
  });
});

describe("seller_inventory_limit blocks Telegram delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-inv-limit-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  it("does not deliver linked LUN when same-cycle OLX peer hits inventory limit", async () => {
    fileIndex += 1;
    const sqlitePath = join(dir, `inv-${fileIndex}.sqlite`);
    resetConfigCache();
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "1:test",
      TELEGRAM_CHAT_ID: "1",
      TELEGRAM_DRY_RUN: "false",
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "true",
      ENABLE_RIELTOR: "false",
      ENABLE_OLX: "true",
      ENABLE_OLX_BROWSER: "false",
      SQLITE_PATH: sqlitePath,
      SELLER_POLICY: "reject_intermediaries",
      GEO_UNKNOWN_POLICY: "include",
      TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
      FIRST_RUN_MODE: "seed",
    });
    const store = new DurableDeliveryStore(getDb(sqlitePath));
    const sent: Listing[] = [];
    const sink = {
      chatId: "1",
      dryRun: false,
      sendListing: async (listing: Listing) => {
        sent.push(listing);
        return { ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 };
      },
      sendText: async () => ({ ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 }),
    } as unknown as TelegramTestSink;

    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const adapters: ListingSourceAdapter[] = [
      {
        source: "lun",
        fetchLatest: async () => lunBatch,
        inspectLatest: async (): Promise<SourceFetchResult> => ({
          listings: [...lunBatch],
          transport: "http",
          dataKind: "LIVE DATA",
          resultKind: "ok",
          health: { source: "lun", healthy: true, checkedAt: now, resultKind: "ok" },
        }),
        healthCheck: async () => ({ source: "lun", healthy: true, checkedAt: now }),
      },
      {
        source: "olx",
        fetchLatest: async () => olxBatch,
        inspectLatest: async (): Promise<SourceFetchResult> => ({
          listings: [...olxBatch],
          transport: "http",
          dataKind: "LIVE DATA",
          resultKind: "ok",
          health: { source: "olx", healthy: true, checkedAt: now, resultKind: "ok" },
        }),
        healthCheck: async () => ({ source: "olx", healthy: true, checkedAt: now }),
      },
    ];

    const seedAt = new Date("2026-09-22T08:00:00.000Z");
    await runTelegramTestCycle(
      {
        adapters,
        config,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seedAt,
        firstRunMode: "seed",
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => {
          throw new Error("detail during seed");
        },
      },
      1,
    );

    lunBatch.push(lunLinked());
    olxBatch.push(olxListing({ distinctPreciseRealEstateProperties: 5 }));

    const report = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => {
          throw new Error("same-cycle inventory must not detail-fetch");
        },
        probeOlxProfile: async () => {
          throw new Error("same-cycle inventory must not probe");
        },
      },
      2,
    );

    expect(sent.filter((item) => item.sourceId === "lun-inv-1")).toHaveLength(0);
    expect(report.linkedSellerVerification.sameCycleInventoryLimit).toBeGreaterThanOrEqual(1);
    expect(store.hasSeen(lunLinked())).toBe(true);
  });
});
