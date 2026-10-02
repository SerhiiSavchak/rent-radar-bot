import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { canonicalDomriaDetailTarget } from "../src/delivery/domria-detail-seller.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

const VAGOVA =
  "https://dom.ria.com/uk/realty-dolgosrochnaya-arenda-kvartira-lvov-galitskiy-vagovaya-ulitsa-27193619.html";
const HLEBNAYA =
  "https://dom.ria.com/uk/realty-dolgosrochnaya-arenda-kvartira-lvov-paseki-hlebnaya-ulitsa-33009485.html";
const VAGOVA_ID = "27193619";
const HLEBNAYA_ID = "33009485";

const seededAt = new Date("2026-10-01T08:00:00.000Z");
const published = new Date("2026-10-01T12:00:00.000Z");
const now = new Date("2026-10-01T18:00:00.000Z");
const retryAt = new Date(now.getTime() + 90_000);

function listing(
  overrides: Partial<Listing> & Pick<Listing, "source" | "sourceId" | "url">,
): Listing {
  return {
    title: "Квартира",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: published,
    publishedAt: published,
    ...overrides,
  };
}

function lunLinked(sourceId: string, originalUrl: string): Listing {
  return listing({
    source: "lun",
    sourceId,
    url: `https://lun.ua/realty/${sourceId}`,
    metadata: {
      originalUrl,
      aggregatedSite: "dom.ria.com",
      ownerEvidenceLevel: "private_unknown",
    },
  });
}

function domriaPeer(id: string, url: string, sellerType: "agent" | "owner" | "unknown"): Listing {
  const evidence =
    sellerType === "owner"
      ? ["platform seller type = owner", "platform offer type = від власника"]
      : sellerType === "agent"
        ? ["platform seller type = agent", "platform offer type = від посередника"]
        : ["characteristic 1437 missing or unrecognized"];
  return listing({
    source: "domria",
    sourceId: id,
    url,
    sellerType,
    sellerEvidence: evidence,
    metadata: {
      ownerEvidenceLevel: sellerType === "agent" ? "intermediary" : "private_unknown",
      characteristic1437Recognized: sellerType !== "unknown",
    },
  });
}

function dataCard(id: string): string {
  return JSON.stringify({
    realty_id: Number(id),
    beautiful_url: `realty-${id}.html`,
    city_name_uk: "Львів",
    street_name_uk: "вул. Тестова",
    publishing_date: "2026-10-01 12:00:00",
    price: 25000,
    currency_type: "грн",
    realty_type_id: 2,
    advert_type_name_uk: "довгострокова оренда",
    user_id: 488374,
    latitude: 49.83,
    longitude: 24.03,
    description_uk: "Квартира",
    agency_id: 0,
    characteristics_values: {},
  });
}

function listingPage(id: string, role: number | undefined): string {
  const state = {
    card: {
      realty_id: Number(id),
      ...(role !== undefined ? { characteristics_values: { "1437": role } } : {}),
    },
  };
  return `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script>`;
}

describe("LUN exact DOM.RIA linked seller", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-lun-domria-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  function configFor() {
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
    });
  }

  function adapter(source: Listing["source"], getListings: () => Listing[]): ListingSourceAdapter {
    return {
      source,
      fetchLatest: async () => getListings(),
      inspectLatest: async (): Promise<SourceFetchResult> => {
        const listings = getListings();
        return {
          listings,
          transport: "test",
          dataKind: "MOCK DATA",
          resultKind: listings.length > 0 ? "ok" : "valid_empty",
          httpStatus: 200,
          health: { source, healthy: true, checkedAt: now, message: "ok" },
        };
      },
      healthCheck: async () => ({ source, healthy: true, checkedAt: now }),
    };
  }

  function sink(sent: Listing[] = []): TelegramTestSink {
    return {
      chatId: "1",
      dryRun: false,
      sendListing: async (item: Listing) => {
        sent.push(item);
        return { ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 };
      },
      sendText: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }),
    } as unknown as TelegramTestSink;
  }

  async function seed(store: DurableDeliveryStore, adapters: ListingSourceAdapter[]) {
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async () => {
          throw new Error("detail fetch during seed");
        },
      },
      1,
    );
  }

  function holdRow(): { externalSource: string; externalListingId: string } | undefined {
    return getDb()
      .prepare(
        `SELECT external_source AS externalSource, external_listing_id AS externalListingId
         FROM seller_verification_holds WHERE source = 'lun'`,
      )
      .get() as { externalSource: string; externalListingId: string } | undefined;
  }

  it("I: extracts the canonical id from the two real DOM.RIA listing URLs", () => {
    expect(canonicalDomriaDetailTarget(VAGOVA)).toEqual({
      id: VAGOVA_ID,
      url: VAGOVA,
    });
    expect(canonicalDomriaDetailTarget(HLEBNAYA)).toEqual({
      id: HLEBNAYA_ID,
      url: HLEBNAYA,
    });
    expect(canonicalDomriaDetailTarget(`${VAGOVA}?utm=1#photo`)).toEqual({
      id: VAGOVA_ID,
      url: VAGOVA,
    });
    expect(
      canonicalDomriaDetailTarget(`https://www.dom.ria.com/uk/realty-example-${HLEBNAYA_ID}.html`),
    ).toEqual({
      id: HLEBNAYA_ID,
      url: `https://dom.ria.com/uk/realty-example-${HLEBNAYA_ID}.html`,
    });
    expect(
      canonicalDomriaDetailTarget("http://dom.ria.com/uk/realty-1-27193619.html"),
    ).toBeUndefined();
    expect(canonicalDomriaDetailTarget("https://lun.ua/realty/4727172963")).toBeUndefined();
    expect(
      canonicalDomriaDetailTarget("https://dom.ria.com/uk/search?id=27193619"),
    ).toBeUndefined();
    expect(
      canonicalDomriaDetailTarget("https://evil.dom.ria.com.example/uk/realty-27193619.html"),
    ).toBeUndefined();
  });

  it("A: rejects a same-cycle DOM.RIA intermediary without another detail request", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("4727172963", VAGOVA);
    const peer = domriaPeer(VAGOVA_ID, VAGOVA, "agent");
    const batch = { lun: [] as Listing[], domria: [] as Listing[] };
    const calls: string[] = [];
    const adapters = [adapter("lun", () => batch.lun), adapter("domria", () => batch.domria)];
    await seed(store, adapters);
    batch.lun.push(lun);
    batch.domria.push(peer);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => {
          calls.push(url);
          throw new Error("same-cycle must not fetch");
        },
      },
      2,
    );
    expect(calls).toEqual([]);
    expect(report.sentOk).toBe(0);
    expect(report.linkedSellerVerification.detailRequests).toBe(0);
    expect(report.linkedSellerVerification.sameCycleConfirmedAgent).toBe(1);
    expect(report.linkedSellerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "lun",
          sourceId: "4727172963",
          outcome: "same_cycle_confirmed_agent",
          externalId: VAGOVA_ID,
        }),
      ]),
    );
    expect(store.hasSeen(lun)).toBe(true);
    expect(holdRow()).toBeUndefined();
  });

  it("B: keeps a same-cycle DOM.RIA owner and records owner evidence without a detail request", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("4727172962", HLEBNAYA);
    const peer = domriaPeer(HLEBNAYA_ID, HLEBNAYA, "owner");
    const sent: Listing[] = [];
    const batch = { lun: [] as Listing[], domria: [] as Listing[] };
    const calls: string[] = [];
    const adapters = [adapter("lun", () => batch.lun), adapter("domria", () => batch.domria)];
    await seed(store, adapters);
    batch.lun.push(lun);
    batch.domria.push(peer);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(sent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => {
          calls.push(url);
          throw new Error("same-cycle must not fetch");
        },
      },
      2,
    );
    expect(calls).toEqual([]);
    expect(report.linkedSellerVerification.detailRequests).toBe(0);
    expect(report.sellerRejectedIntermediary).toBe(0);
    expect(report.linkedSellerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "lun",
          sourceId: "4727172962",
          outcome: "same_cycle_resolved",
          externalId: HLEBNAYA_ID,
          evidence: expect.stringContaining("від власника"),
        }),
      ]),
    );
    const delivered = sent.find((item) => item.source === "lun" && item.sourceId === "4727172962");
    expect(delivered).toBeDefined();
    expect(delivered?.sellerType).not.toBe("agent");
  });

  it("uses a same-cycle unknown DOM.RIA seller without a detail request or an owner promotion", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("901", VAGOVA);
    const peer = domriaPeer(VAGOVA_ID, VAGOVA, "unknown");
    const sent: Listing[] = [];
    const batch = { lun: [] as Listing[], domria: [] as Listing[] };
    const calls: string[] = [];
    const adapters = [adapter("lun", () => batch.lun), adapter("domria", () => batch.domria)];
    await seed(store, adapters);
    batch.lun.push(lun);
    batch.domria.push(peer);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(sent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => {
          calls.push(url);
          throw new Error("same-cycle unknown must not fetch");
        },
      },
      2,
    );
    expect(calls).toEqual([]);
    expect(report.sentOk).toBe(1);
    expect(report.sellerRejectedIntermediary).toBe(0);
    expect(report.linkedSellerVerification.detailRequests).toBe(0);
    expect(report.linkedSellerVerification.detailConfirmedOwner).toBe(0);
    expect(report.linkedSellerVerification.detailUnknown).toBe(1);
    expect(sent.find((item) => item.source === "lun")?.sellerType).toBe("unknown");
    expect(holdRow()).toBeUndefined();
  });

  it("C: rejects a linked DOM.RIA intermediary from characteristic 1437 = 1434", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("4727172963", VAGOVA);
    const batch: Listing[] = [];
    const calls: string[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lun);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => {
          calls.push(url);
          if (url.includes(`/realty/data/${VAGOVA_ID}`)) {
            return { status: 200, url, bodyText: dataCard(VAGOVA_ID) };
          }
          return { status: 200, url, bodyText: listingPage(VAGOVA_ID, 1434) };
        },
      },
      2,
    );
    expect(calls.some((url) => url.includes(`/realty/data/${VAGOVA_ID}`))).toBe(true);
    expect(report.sentOk).toBe(0);
    expect(report.linkedSellerVerification.detailConfirmedAgent).toBe(1);
    expect(report.linkedSellerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "lun",
          sourceId: "4727172963",
          outcome: "detail_confirmed_agent",
          externalId: VAGOVA_ID,
          evidence: expect.stringContaining("від посередника"),
        }),
      ]),
    );
    expect(store.hasSeen(lun)).toBe(true);
    expect(holdRow()).toBeUndefined();
  });

  it("D: allows a linked DOM.RIA owner from characteristic 1437 = 1436", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("4727172962", HLEBNAYA);
    const sent: Listing[] = [];
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lun);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(sent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => {
          if (url.includes(`/realty/data/${HLEBNAYA_ID}`)) {
            return { status: 200, url, bodyText: dataCard(HLEBNAYA_ID) };
          }
          return { status: 200, url, bodyText: listingPage(HLEBNAYA_ID, 1436) };
        },
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(report.sellerRejectedIntermediary).toBe(0);
    expect(report.linkedSellerVerification.detailConfirmedOwner).toBe(1);
    expect(report.linkedSellerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "detail_confirmed_owner",
          externalId: HLEBNAYA_ID,
          evidence: expect.stringContaining("від власника"),
        }),
      ]),
    );
    expect(sent.map((item) => item.sourceId)).toEqual(["4727172962"]);
  });

  it("E: holds a LUN listing when exact DOM.RIA verification is temporarily unavailable", async () => {
    for (const mode of ["503", "429", "timeout"] as const) {
      const path = dbPath();
      const store = new DurableDeliveryStore(getDb(path));
      const lun = lunLinked(`hold-${mode}`, VAGOVA);
      const batch: Listing[] = [];
      const adapters = [adapter("lun", () => batch)];
      await seed(store, adapters);
      batch.push(lun);
      const report = await runTelegramTestCycle(
        {
          adapters,
          config: configFor(),
          sink: sink(),
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => now,
          domriaDetailGapMs: 0,
          fetchDomriaDetail: async (url) => {
            if (mode === "timeout") {
              throw new Error("timeout");
            }
            return { status: mode === "429" ? 429 : 503, url, bodyText: "" };
          },
        },
        2,
      );
      expect(report.sentOk, mode).toBe(0);
      expect(store.hasSeen(lun), mode).toBe(false);
      expect(holdRow(), mode).toEqual({
        externalSource: "domria",
        externalListingId: VAGOVA_ID,
      });
      closeDb();
    }
  });

  it("F: retries a persisted DOM.RIA hold after restart to a terminal agent reject", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("4727172963", VAGOVA);
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lun);
    const failed = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => ({ status: 503, url, bodyText: "" }),
      },
      2,
    );
    expect(failed.sentOk).toBe(0);
    expect(holdRow()?.externalSource).toBe("domria");
    closeDb();

    const reopened = new DurableDeliveryStore(getDb(path));
    let fetches = 0;
    const resolved = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => retryAt,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => {
          fetches += 1;
          if (url.includes(`/realty/data/${VAGOVA_ID}`)) {
            return { status: 200, url, bodyText: dataCard(VAGOVA_ID) };
          }
          return { status: 200, url, bodyText: listingPage(VAGOVA_ID, 1434) };
        },
      },
      3,
    );
    expect(fetches).toBeGreaterThan(0);
    expect(resolved.sentOk).toBe(0);
    expect(reopened.hasSeen(lun)).toBe(true);
    expect(holdRow()).toBeUndefined();
  });

  it("F2: delivers a restarted DOM.RIA owner hold exactly once", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("4727172962", HLEBNAYA);
    const sent: Listing[] = [];
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lun);
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => ({ status: 503, url, bodyText: "" }),
      },
      2,
    );
    expect(holdRow()?.externalSource).toBe("domria");
    closeDb();

    const reopened = new DurableDeliveryStore(getDb(path));
    const ownerPage = async (url: string) => {
      if (url.includes(`/realty/data/${HLEBNAYA_ID}`)) {
        return { status: 200, url, bodyText: dataCard(HLEBNAYA_ID) };
      }
      return { status: 200, url, bodyText: listingPage(HLEBNAYA_ID, 1436) };
    };
    const resolved = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(sent),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => retryAt,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: ownerPage,
      },
      3,
    );
    const again = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(sent),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date(retryAt.getTime() + 60_000),
        domriaDetailGapMs: 0,
        fetchDomriaDetail: ownerPage,
      },
      4,
    );
    expect(resolved.sentOk).toBe(1);
    expect(again.sentOk).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sourceId).toBe("4727172962");
    expect(holdRow()).toBeUndefined();
  });

  it("G: does not send when the DOM.RIA detail body is unusable", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("4727172963", VAGOVA);
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lun);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => ({ status: 200, url, bodyText: "not-json" }),
      },
      2,
    );
    expect(report.sentOk).toBe(0);
    expect(report.linkedSellerVerification.detailParserFailure).toBe(1);
    expect(store.hasSeen(lun)).toBe(false);
    expect(holdRow()?.externalSource).toBe("domria");
  });

  it("evaluates a DOM.RIA unknown seller without promoting it to owner", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = lunLinked("900", VAGOVA);
    const sent: Listing[] = [];
    const batch: Listing[] = [];
    const calls: string[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lun);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(sent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        domriaDetailGapMs: 0,
        fetchDomriaDetail: async (url) => {
          calls.push(url);
          if (url.includes(`/realty/data/${VAGOVA_ID}`)) {
            return { status: 200, url, bodyText: dataCard(VAGOVA_ID) };
          }
          return { status: 200, url, bodyText: listingPage(VAGOVA_ID, undefined) };
        },
      },
      2,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(report.sentOk).toBe(1);
    expect(report.sellerRejectedIntermediary).toBe(0);
    expect(report.linkedSellerVerification.detailConfirmedOwner).toBe(0);
    expect(report.linkedSellerVerification.detailUnknown).toBe(1);
    expect(sent[0]?.sellerType).toBe("unknown");
    expect(holdRow()).toBeUndefined();
  });

  it("H: leaves an exact RIELTOR original on the existing RIELTOR path", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const original = "https://rieltor.ua/lvov/flats-rent/view/13065183/";
    const lun = listing({
      source: "lun",
      sourceId: "880",
      url: "https://lun.ua/realty/880",
      metadata: { originalUrl: original, aggregatedSite: "rieltor.ua" },
    });
    const batch: Listing[] = [];
    const rieltorCalls: string[] = [];
    const domriaCalls: string[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lun);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        domriaDetailGapMs: 0,
        fetchRieltorDetail: async (url) => {
          rieltorCalls.push(url);
          return {
            status: 200,
            finalUrl: url,
            bodyText: `<div class="offer-view-rieltor-position">Власник</div>`,
          };
        },
        fetchDomriaDetail: async (url) => {
          domriaCalls.push(url);
          throw new Error("RIELTOR original must not use DOM.RIA verification");
        },
      },
      2,
    );
    expect(domriaCalls).toEqual([]);
    expect(rieltorCalls).toEqual([original]);
    expect(report.sentOk).toBe(1);
    expect(report.linkedSellerVerification.detailConfirmedOwner).toBe(1);
    expect(holdRow()?.externalSource).not.toBe("domria");
  });
});
