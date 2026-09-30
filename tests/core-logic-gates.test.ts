import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { applyListingFilters } from "../src/filters/listing-filter.ts";
import { filterByLocation } from "../src/filters/location-filter.ts";
import { detectPropertyType } from "../src/filters/property-type.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { parseDomriaInfo } from "../src/sources/domria/domria.parser.ts";
import { applyCategoryPropertyType } from "../src/sources/domria/domria-newest.ts";
import { parseLunCard } from "../src/sources/lun/lun.parser.ts";
import { parseOlxOffer } from "../src/sources/olx/olx.parser.ts";
import { parseRieltorCard } from "../src/sources/rieltor/rieltor.parser.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { readSourceHealth } from "../src/storage/source-health.ts";
import { runStateCleanupIfDue } from "../src/storage/state-retention.ts";
import { haversineKm } from "../src/utils/geo.ts";

const CENTER = { centerLat: 49.8397, centerLng: 24.0297, radiusKm: 15 };

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "domria",
    sourceId: "gate-1",
    url: "https://dom.ria.com/uk/realty-gate-1.html",
    title: "Квартира",
    price: { amount: 12_000, currency: "UAH", period: "month" },
    location: {
      raw: "Львів",
      city: "Львів",
      latitude: 49.84,
      longitude: 24.03,
    },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: new Date("2026-09-20T10:00:00.000Z"),
    publishedAt: new Date("2026-09-20T09:00:00.000Z"),
    ...overrides,
  };
}

describe("property type gate", () => {
  const config = loadConfig({
    PROPERTY_TYPES: "apartment,house",
    SELLER_POLICY: "reject_intermediaries",
    GEO_UNKNOWN_POLICY: "exclude",
  });

  it("keeps long-term apartments and houses and rejects other categories", () => {
    expect(detectPropertyType({ title: "2-кімнатна квартира, довгострокова оренда" })).toBe(
      "apartment",
    );
    expect(detectPropertyType({ title: "будинок, довгострокова оренда", realtyTypeId: 5 })).toBe("house");
    expect(detectPropertyType({ realtyTypeId: 2, title: "Квартира" })).toBe("apartment");
    expect(detectPropertyType({ sectionId: 4, title: "будинок" })).toBe("house");
    expect(detectPropertyType({ title: "домовласник" })).toBe("unknown");

    for (const title of [
      "здам кімнату",
      "комната в центре",
      "оренда гаража",
      "земельна ділянка",
      "оренда офісу",
      "комерційне приміщення",
      "подобово квартира",
      "посуточно дом",
      "продаж квартири",
    ]) {
      expect(detectPropertyType({ title, realtyTypeId: 2 }), title).toBe("unknown");
    }

    expect(detectPropertyType({ title: "квартира з гаражем, довгостроково" })).toBe("apartment");
    expect(detectPropertyType({ title: "не для продажу, тільки оренда квартири" })).toBe("apartment");
    expect(detectPropertyType({ categoryText: "щось інше" })).toBe("unknown");
  });

  it("does not let an unknown category become an apartment in the pipeline", () => {
    const unknown = listing({ propertyType: "unknown", title: "об'єкт" });
    const daily = listing({ price: { amount: 800, currency: "UAH", period: "day" } });
    const filtered = applyListingFilters([unknown, daily, listing()], config);
    expect(filtered[0]?.propertyMatched).toBe(false);
    expect(filtered[0]?.accepted).toBe(false);
    expect(filtered[1]?.accepted).toBe(false);
    expect(filtered[2]?.accepted).toBe(true);

    const promoted = applyCategoryPropertyType(
      listing({ propertyType: "unknown", title: "Оренда", sourceId: "51" }),
      "apartment",
      "51",
      [],
    );
    expect(promoted.propertyType).toBe("unknown");
  });

  it("keeps source category ids strict", () => {
    const discoveredAt = new Date("2026-09-20T00:00:00.000Z");
    const apartment = parseOlxOffer(
      {
        id: 1,
        title: "Оренда",
        url: "https://www.olx.ua/d/uk/obyavlenie/a-ID1.html",
        category: { id: 1760 },
        location: { city: { name: "Львів" } },
      },
      discoveredAt,
    );
    const house = parseOlxOffer(
      {
        id: 2,
        title: "Оренда",
        url: "https://www.olx.ua/d/uk/obyavlenie/b-ID2.html",
        category: { id: 330 },
        location: { city: { name: "Львів" } },
      },
      discoveredAt,
    );
    const saleCategory = parseOlxOffer(
      {
        id: 3,
        title: "Квартира в центрі",
        url: "https://www.olx.ua/d/uk/obyavlenie/c-ID3.html",
        category: { id: 1758 },
        location: { city: { name: "Львів" } },
      },
      discoveredAt,
    );
    const missingCategory = parseOlxOffer(
      {
        id: 4,
        title: "Оренда квартири",
        url: "https://www.olx.ua/d/uk/obyavlenie/d-ID4.html",
        location: { city: { name: "Львів" } },
      },
      discoveredAt,
    );
    const dailyOnRentCategory = parseOlxOffer(
      {
        id: 5,
        title: "подобово квартира",
        url: "https://www.olx.ua/d/uk/obyavlenie/e-ID5.html",
        category: { id: 1760 },
        location: { city: { name: "Львів" } },
      },
      discoveredAt,
    );
    expect(apartment?.propertyType).toBe("apartment");
    expect(house?.propertyType).toBe("house");
    expect(saleCategory?.propertyType).toBe("unknown");
    expect(missingCategory?.propertyType).toBe("unknown");
    expect(dailyOnRentCategory?.propertyType).toBe("unknown");

    const domria = parseDomriaInfo({
      realty_id: 9,
      beautiful_url: "realty-9.html",
      city_name_uk: "Львів",
      realty_type_id: 2,
      advert_type_name_uk: "продаж",
      description_uk: "Квартира",
    });
    expect(domria?.propertyType).toBe("unknown");

    const lun = parseLunCard(
      { id: 9, sectionId: 2, text: "здам кімнату", header: "кімната" },
      undefined,
    );
    expect(lun?.propertyType).toBe("unknown");

    const rieltor = parseRieltorCard(
      `<div class="catalog-card" data-catalog-item-id="77">
        <a href="https://rieltor.ua/lvov/flats-rent/view/77/"></a>
        <h2 class="catalog-card-address">здам кімнату</h2>
      </div>`,
      { category: "apartment", discoveredAt, jsonLd: new Map() },
    );
    expect(rieltor?.propertyType).toBe("unknown");
  });
});

describe("geo gate", () => {
  const exclude = { ...CENTER, unknownPolicy: "exclude" as const };
  const include = { ...CENTER, unknownPolicy: "include" as const };

  it("accepts the 15 km boundary and rejects a point beyond it", () => {
    const kmPerDegree = haversineKm(CENTER.centerLat, CENTER.centerLng, CENTER.centerLat + 1, CENTER.centerLng);
    const onEdge = CENTER.centerLat + 15 / kmPerDegree;
    const inside = filterByLocation(
      { latitude: onEdge, longitude: CENTER.centerLng },
      exclude,
    );
    expect(inside.matched).toBe(true);
    expect(inside.reason).toBe("within-radius");
    expect(inside.distanceKm).toBeLessThanOrEqual(15);
    expect(inside.distanceKm).toBeGreaterThan(14.9);

    const outside = filterByLocation(
      { latitude: CENTER.centerLat + 16 / kmPerDegree, longitude: CENTER.centerLng },
      exclude,
    );
    expect(outside.matched).toBe(false);
    expect(outside.reason).toBe("outside-radius");
    expect(outside.distanceKm).toBeGreaterThan(15);
  });

  it("does not pass malformed coordinates and does not invent Lviv", () => {
    expect(filterByLocation({ latitude: Number.NaN, longitude: 24 }, include).matched).toBe(false);
    expect(filterByLocation({ latitude: 0, longitude: 0 }, include).matched).toBe(false);
    expect(filterByLocation({ latitude: 10, longitude: 10 }, include).matched).toBe(false);
    expect(
      filterByLocation({ latitude: "немає" as unknown as number, longitude: 24.02 }, include).matched,
    ).toBe(false);
    const missing = filterByLocation({ city: "Львів" }, exclude);
    expect(missing.matched).toBe(false);
    expect(missing.reason).toBe("no-coordinates");

    const lun = parseLunCard({ id: 15, sectionId: 2, header: "вулиця без міста" }, undefined);
    expect(lun?.location.city).toBeUndefined();
    expect(lun?.location.raw.toLowerCase()).not.toContain("львів");
    expect(lun?.location.raw.toLowerCase()).not.toContain("lviv");

    const domria = parseDomriaInfo({
      realty_id: 15,
      beautiful_url: "realty-15.html",
      realty_type_id: 2,
    });
    expect(domria?.location.city).toBeUndefined();
    expect(domria?.location.raw.toLowerCase()).not.toContain("lviv");
    expect(domria?.location.raw.toLowerCase()).not.toContain("львів");
  });
});

describe("dedup, first run, health, retention, restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-gates-"));
  let fileIndex = 0;

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function config() {
    return loadConfig({
      OWNER_ONLY: "false",
      ENABLE_DOMRIA: "true",
      ENABLE_LUN: "true",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: "false",
      ENABLE_RIELTOR: "false",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "exclude",
      FIRST_RUN_MODE: "seed",
      TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
      SELLER_POLICY: "reject_intermediaries",
    });
  }

  function adapter(
    source: Listing["source"],
    listings: Listing[],
    resultKind?: SourceFetchResult["resultKind"],
  ): ListingSourceAdapter {
    const kind = resultKind ?? (listings.length > 0 ? "ok" : "valid_empty");
    return {
      source,
      fetchLatest: async () => listings,
      inspectLatest: async () => ({
        listings,
        transport: "test",
        dataKind: "MOCK DATA",
        resultKind: kind,
        health: {
          source,
          healthy: kind === "ok" || kind === "valid_empty",
          checkedAt: new Date("2026-09-20T12:00:00.000Z"),
          ...(kind === "parser_failure" ? { message: "parser_failure" } : {}),
        },
      }),
      healthCheck: async () => ({
        source,
        healthy: true,
        checkedAt: new Date("2026-09-20T12:00:00.000Z"),
      }),
    };
  }

  function sink(sendListing: TelegramTestSink["sendListing"]): TelegramTestSink {
    return {
      chatId: "1",
      dryRun: false,
      sendListing,
      sendText: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }),
    } as unknown as TelegramTestSink;
  }

  it("seeds the first catalog without sending, then delivers only a later listing once", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const sendListing = vi.fn(async () => ({
      ok: true,
      dryRun: true,
      attempts: 0,
      chatId: "1",
      messageCount: 1,
    }));
    const existing = listing({
      sourceId: "old",
      url: "https://dom.ria.com/uk/realty-old.html",
      publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const seed = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [existing]), adapter("lun", [], "parser_failure")],
        config: config(),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-20T12:00:00.000Z"),
      },
      1,
    );
    expect(seed.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
    expect(readSourceHealth(getDb(), "lun")?.status).toBe("parser_failure");
    expect(readSourceHealth(getDb(), "domria")?.status).toBe("ok");

    const fresh = listing({
      sourceId: "new",
      url: "https://dom.ria.com/uk/realty-new.html",
      publishedAt: new Date("2026-09-20T13:00:00.000Z"),
    });
    const second = await runTelegramTestCycle(
      {
        adapters: [
          adapter("domria", [existing, fresh]),
          adapter("lun", [], "valid_empty"),
        ],
        config: config(),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-20T14:00:00.000Z"),
      },
      2,
    );
    expect(second.sentOk).toBe(1);
    expect(sendListing).toHaveBeenCalledTimes(1);
    expect(readSourceHealth(getDb(), "lun")?.status).toBe("valid_empty");
    expect(readSourceHealth(getDb(), "lun")?.consecutiveFailures).toBe(0);

    const bumped = {
      ...fresh,
      refreshedAt: new Date("2026-09-21T08:00:00.000Z"),
      metadata: { pushupTime: "2026-09-21T08:00:00.000Z" },
    };
    const third = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [existing, bumped])],
        config: config(),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-21T09:00:00.000Z"),
      },
      3,
    );
    expect(third.sentOk).toBe(0);
    expect(sendListing).toHaveBeenCalledTimes(1);

    closeDb();
    const restarted = new DurableDeliveryStore(getDb(path));
    const fourth = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [existing, bumped])],
        config: config(),
        sink: sink(sendListing),
        dedupe: restarted,
        baseline: restarted,
        outbox: restarted,
        now: () => new Date("2026-09-21T10:00:00.000Z"),
      },
      4,
    );
    expect(fourth.sentOk).toBe(0);
    expect(sendListing).toHaveBeenCalledTimes(1);
  });

  it("keeps seen identity after the 30-day cleanup", () => {
    const path = dbPath();
    const db = getDb(path);
    const old = "2026-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO seen_listings (
         source, source_id, fingerprint, canonical_url, first_seen_at, last_seen_at
       ) VALUES ('domria', 'keep-dedup', 'fp', 'https://dom.ria.com/uk/realty-keep-dedup.html', ?, ?)`,
    ).run(old, old);
    const report = runStateCleanupIfDue(db, {
      now: new Date("2026-09-22T00:00:00.000Z"),
      databasePath: path,
      force: true,
    });
    expect(report.seenRowsRemoved).toBe(0);
    const left = db.prepare("SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'keep-dedup'").get() as {
      n: number;
    };
    expect(Number(left.n)).toBe(1);
  });
});
