import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import {
  canonicalRieltorDetailTarget,
  trustedRieltorFinalUrl,
} from "../src/delivery/rieltor-detail-seller.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { applyMigrations, sqliteMigrationSql } from "../src/storage/migrations.ts";
import { runStateCleanupIfDue } from "../src/storage/state-retention.ts";

const seededAt = new Date("2026-09-22T08:00:00.000Z");
const published = new Date("2026-09-22T09:00:00.000Z");
const now = new Date("2026-09-22T10:00:00.000Z");

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
    url: `https://lun.ua/uk/realty/${sourceId}`,
    metadata: {
      originalUrl,
      aggregatedSite: "rieltor.ua",
      ownerEvidenceLevel: "private_unknown",
    },
  });
}

function page(html: string, status = 200, finalUrl = "https://rieltor.ua/lvov/flats-rent/view/1/") {
  return { status, finalUrl, bodyText: html };
}

const realtorHtml = `<div class="offer-view-rieltor-position">Рієлтор</div>`;
const agencyHtml = `<a class="offer-view-rieltor-agency-link">Хата Інвест</a>`;
const ownerHtml = `<div class="offer-view-rieltor-position">Власник</div>`;
const ambiguousHtml = `<div class="offer-view-rieltor-position">Користувач</div>`;
const brokenHtml = `<html><body><h1>RIELTOR</h1><p>phone 050</p></body></html>`;

describe("linked RIELTOR seller verification", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-link-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  function configFor(flags: Record<string, string> = {}) {
    resetConfigCache();
    return loadConfig({
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
      ...flags,
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

  function sink(): TelegramTestSink {
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
        fetchRieltorDetail: async () => {
          throw new Error("detail fetch during seed");
        },
        rieltorDetailGapMs: 0,
      },
      1,
    );
  }

  function outboxCount(sourceId: string): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM telegram_outbox WHERE source = 'lun' AND source_id = ?")
      .get(sourceId) as { n: number };
    return row.n;
  }

  it("rejects hosts and paths that are not a canonical RIELTOR detail id", () => {
    expect(
      canonicalRieltorDetailTarget("https://evil.example/lvov/flats-rent/view/13065183/"),
    ).toBeUndefined();
    expect(
      canonicalRieltorDetailTarget("https://rieltor.ua.evil.example/lvov/flats-rent/view/1/"),
    ).toBeUndefined();
    expect(
      canonicalRieltorDetailTarget("http://rieltor.ua/lvov/flats-rent/view/13065183/"),
    ).toBeUndefined();
    expect(
      canonicalRieltorDetailTarget("https://user:pass@rieltor.ua/lvov/flats-rent/view/1/"),
    ).toBeUndefined();
    expect(canonicalRieltorDetailTarget("https://rieltor.ua/view/13065183/")).toBeUndefined();
    expect(
      canonicalRieltorDetailTarget("https://rieltor.ua/lvov/flats-rent/view/abc/"),
    ).toBeUndefined();
    expect(
      canonicalRieltorDetailTarget("https://www.rieltor.ua/lvov/flats-rent/view/13065183/?utm=1#x"),
    ).toEqual({
      id: "13065183",
      url: "https://rieltor.ua/lvov/flats-rent/view/13065183/",
    });
  });

  it("trusts a redirect only when it is still the same RIELTOR listing", () => {
    const requested = "https://rieltor.ua/lvov/flats-rent/view/13065183/";
    expect(trustedRieltorFinalUrl("https://rieltor.ua/lvov/flats-rent/view/999/", requested)).toBe(
      false,
    );
    expect(trustedRieltorFinalUrl("https://rieltor.ua/", requested)).toBe(false);
    expect(trustedRieltorFinalUrl("https://rieltor.ua/lvov/flats-rent/", requested)).toBe(false);
    expect(
      trustedRieltorFinalUrl("https://evil.example/lvov/flats-rent/view/13065183/", requested),
    ).toBe(false);
    expect(
      trustedRieltorFinalUrl("https://www.rieltor.ua/lvov/flats-rent/view/13065183/", requested),
    ).toBe(true);
    expect(
      trustedRieltorFinalUrl(
        "https://rieltor.ua/lvov/flats-rent/view/13065183/?utm=1#x",
        requested,
      ),
    ).toBe(true);
    expect(
      trustedRieltorFinalUrl(
        "https://www.rieltor.ua/lvov/flats-rent/view/13065183/?utm=1",
        requested,
      ),
    ).toBe(true);
  });

  it("drops a LUN copy when the out-of-sample RIELTOR page says Рієлтор or names an agency", async () => {
    for (const [sourceId, html, externalId] of [
      ["4725862679", realtorHtml, "13065183"],
      ["4725024756", agencyHtml, "13059493"],
    ] as const) {
      const path = dbPath();
      const store = new DurableDeliveryStore(getDb(path));
      const batch: Listing[] = [];
      const fetched: string[] = [];
      const adapters = [adapter("lun", () => batch)];
      await seed(store, adapters);
      batch.push(
        lunLinked(sourceId, `https://rieltor.ua/lvov/flats-rent/view/${externalId}/?utm=1`),
      );
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
          fetchRieltorDetail: async (url) => {
            fetched.push(url);
            return {
              ...page(html),
              finalUrl: `https://rieltor.ua/lvov/flats-rent/view/${externalId}/`,
            };
          },
        },
        2,
      );
      expect(fetched).toEqual([`https://rieltor.ua/lvov/flats-rent/view/${externalId}/`]);
      expect(report.sentOk).toBe(0);
      expect(report.linkedSellerVerification.detailConfirmedAgent).toBe(1);
      expect(outboxCount(sourceId)).toBe(0);
      closeDb();
    }
  });

  it("keeps a LUN copy when the detail page confirms an owner or is only ambiguous", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lunLinked("880", "https://rieltor.ua/lvov/flats-rent/view/555/"));
    const ownerReport = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url) => page(ownerHtml, 200, url),
      },
      2,
    );
    expect(ownerReport.sentOk).toBe(1);
    expect(ownerReport.linkedSellerVerification.detailConfirmedOwner).toBe(1);
    expect(outboxCount("880")).toBe(1);

    const path2 = dbPath();
    const store2 = new DurableDeliveryStore(getDb(path2));
    const batch2: Listing[] = [];
    const adapters2 = [adapter("lun", () => batch2)];
    await seed(store2, adapters2);
    batch2.push(lunLinked("881", "https://rieltor.ua/lvov/houses-rent/view/556/"));
    const unknownReport = await runTelegramTestCycle(
      {
        adapters: adapters2,
        config: configFor(),
        sink: sink(),
        dedupe: store2,
        baseline: store2,
        outbox: store2,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url) => page(ambiguousHtml, 200, url),
      },
      2,
    );
    expect(unknownReport.sentOk).toBe(1);
    expect(unknownReport.linkedSellerVerification.detailUnknown).toBe(1);
    expect(outboxCount("881")).toBe(1);
  });

  it("does not invent an agent on 429, and does not request the remaining detail URLs", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(
      lunLinked("1", "https://rieltor.ua/lvov/flats-rent/view/11/"),
      lunLinked("2", "https://rieltor.ua/lvov/flats-rent/view/22/"),
    );
    let calls = 0;
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
        fetchRieltorDetail: async (url) => {
          calls += 1;
          return page("nope", 429, url);
        },
      },
      2,
    );
    expect(calls).toBe(1);
    expect(report.linkedSellerVerification.detailRequests).toBe(1);
    expect(report.linkedSellerVerification.detailRateLimited).toBe(1);
    expect(report.linkedSellerVerification.skippedAfterRateLimit).toBe(1);
    expect(report.linkedSellerVerification.detailConfirmedAgent).toBe(0);
    expect(report.sentOk).toBe(2);
  });

  it("keeps transport and parser failures distinct from a confirmed seller", async () => {
    const cases = [
      {
        name: "403",
        fetch: async (url: string) => page("blocked", 403, url),
        outcome: "detailTransportFailure" as const,
      },
      {
        name: "timeout",
        fetch: async () => Promise.reject(new Error("timeout")),
        outcome: "detailTransportFailure" as const,
      },
      {
        name: "network",
        fetch: async () => Promise.reject(new Error("socket hang up")),
        outcome: "detailTransportFailure" as const,
      },
      {
        name: "parser",
        fetch: async (url: string) => page(brokenHtml, 200, url),
        outcome: "detailParserFailure" as const,
      },
    ];
    for (const [index, item] of cases.entries()) {
      const path = dbPath();
      const store = new DurableDeliveryStore(getDb(path));
      const batch: Listing[] = [];
      const adapters = [adapter("lun", () => batch)];
      await seed(store, adapters);
      const sourceId = `p${index}`;
      batch.push(lunLinked(sourceId, `https://rieltor.ua/lvov/flats-rent/view/${100 + index}/`));
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
          fetchRieltorDetail: item.fetch,
        },
        2,
      );
      expect(report.linkedSellerVerification[item.outcome], item.name).toBe(1);
      expect(report.linkedSellerVerification.detailConfirmedAgent).toBe(0);
      expect(report.linkedSellerVerification.detailConfirmedOwner).toBe(0);
      expect(report.sentOk).toBe(1);
      const verdict = getDb()
        .prepare("SELECT seller_verdict AS verdict FROM external_seller_verifications")
        .get() as { verdict: string };
      expect(
        verdict.verdict === "confirmed_intermediary" || verdict.verdict === "confirmed_owner",
      ).toBe(false);
      closeDb();
    }
  });

  it("uses same-cycle RIELTOR evidence and does not detail-fetch", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const rieltorBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("rieltor", () => rieltorBatch)];
    await seed(store, adapters);
    lunBatch.push(lunLinked("4725463684", "https://rieltor.ua/lvov/flats-rent/view/13064424/"));
    rieltorBatch.push(
      listing({
        source: "rieltor",
        sourceId: "13064424",
        url: "https://rieltor.ua/lvov/flats-rent/view/13064424/",
        sellerType: "agent",
        metadata: { ownerEvidenceLevel: "intermediary", platformRoleLabel: "Рієлтор" },
      }),
    );
    const fetched: string[] = [];
    const agentReport = await runTelegramTestCycle(
      {
        adapters,
        config: configFor({ ENABLE_RIELTOR: "true" }),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url) => {
          fetched.push(url);
          return page(realtorHtml, 200, url);
        },
      },
      2,
    );
    expect(fetched).toEqual([]);
    expect(agentReport.sentOk).toBe(0);
    expect(agentReport.linkedSellerVerification.sameCycleConfirmedAgent).toBe(1);
    expect(agentReport.linkedSellerVerification.detailRequests).toBe(0);

    const path2 = dbPath();
    const store2 = new DurableDeliveryStore(getDb(path2));
    const lunBatch2: Listing[] = [];
    const rieltorBatch2: Listing[] = [];
    const adapters2 = [adapter("lun", () => lunBatch2), adapter("rieltor", () => rieltorBatch2)];
    await seed(store2, adapters2);
    lunBatch2.push(lunLinked("880", "https://rieltor.ua/lvov/flats-rent/view/555/"));
    rieltorBatch2.push(
      listing({
        source: "rieltor",
        sourceId: "555",
        url: "https://rieltor.ua/lvov/flats-rent/view/555/",
        sellerType: "owner",
      }),
    );
    const ownerFetched: string[] = [];
    const ownerReport = await runTelegramTestCycle(
      {
        adapters: adapters2,
        config: configFor({ ENABLE_RIELTOR: "true" }),
        sink: sink(),
        dedupe: store2,
        baseline: store2,
        outbox: store2,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url) => {
          ownerFetched.push(url);
          return page(realtorHtml, 200, url);
        },
      },
      2,
    );
    expect(ownerFetched).toEqual([]);
    expect(ownerReport.sentOk).toBe(1);
    expect(ownerReport.linkedSellerVerification.sameCycleResolved).toBe(1);
  });

  it("detail-checks a same-cycle RIELTOR card whose seller is still unknown", async () => {
    const cases = [
      {
        name: "realtor",
        html: realtorHtml,
        sentOk: 0,
        outbox: 0,
        counter: "detailConfirmedAgent" as const,
      },
      {
        name: "owner",
        html: ownerHtml,
        sentOk: 1,
        outbox: 1,
        counter: "detailConfirmedOwner" as const,
      },
      {
        name: "ambiguous",
        html: ambiguousHtml,
        sentOk: 1,
        outbox: 1,
        counter: "detailUnknown" as const,
      },
    ];
    for (const [index, item] of cases.entries()) {
      const path = dbPath();
      const store = new DurableDeliveryStore(getDb(path));
      const externalId = String(700 + index);
      const sourceId = `unk-${index}`;
      const lunBatch: Listing[] = [];
      const rieltorBatch: Listing[] = [];
      const adapters = [adapter("lun", () => lunBatch), adapter("rieltor", () => rieltorBatch)];
      await seed(store, adapters);
      lunBatch.push(lunLinked(sourceId, `https://rieltor.ua/lvov/flats-rent/view/${externalId}/`));
      rieltorBatch.push(
        listing({
          source: "rieltor",
          sourceId: externalId,
          url: `https://rieltor.ua/lvov/flats-rent/view/${externalId}/`,
          sellerType: "unknown",
          metadata: { ownerEvidenceLevel: "private_unknown" },
        }),
      );
      let calls = 0;
      const report = await runTelegramTestCycle(
        {
          adapters,
          config: configFor({ ENABLE_RIELTOR: "true" }),
          sink: sink(),
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => now,
          rieltorDetailGapMs: 0,
          fetchRieltorDetail: async (url) => {
            calls += 1;
            return page(item.html, 200, url);
          },
        },
        2,
      );
      expect(calls, item.name).toBe(1);
      expect(report.linkedSellerVerification.detailRequests, item.name).toBe(1);
      expect(report.linkedSellerVerification.sameCycleResolved, item.name).toBe(0);
      expect(report.linkedSellerVerification[item.counter], item.name).toBe(1);
      expect(report.sentOk, item.name).toBe(item.sentOk);
      expect(outboxCount(sourceId), item.name).toBe(item.outbox);
      closeDb();
    }
  });

  it("does not accept seller markers after a redirect to a different RIELTOR page", async () => {
    const finals = ["https://rieltor.ua/lvov/flats-rent/view/1/", "https://rieltor.ua/"];
    for (const [index, finalUrl] of finals.entries()) {
      const path = dbPath();
      const store = new DurableDeliveryStore(getDb(path));
      const batch: Listing[] = [];
      const adapters = [adapter("lun", () => batch)];
      await seed(store, adapters);
      const sourceId = `redir-${index}`;
      batch.push(lunLinked(sourceId, "https://rieltor.ua/lvov/flats-rent/view/13065183/"));
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
          fetchRieltorDetail: async () => page(realtorHtml, 200, finalUrl),
        },
        2,
      );
      expect(report.linkedSellerVerification.detailTransportFailure, finalUrl).toBe(1);
      expect(report.linkedSellerVerification.detailConfirmedAgent, finalUrl).toBe(0);
      expect(report.linkedSellerVerification.detailConfirmedOwner, finalUrl).toBe(0);
      expect(report.sentOk, finalUrl).toBe(1);
      const verdict = getDb()
        .prepare("SELECT seller_verdict AS verdict FROM external_seller_verifications")
        .get() as { verdict: string };
      expect(verdict.verdict, finalUrl).toBe("transport_failure");
      closeDb();
    }
  });

  it("accepts www and query-canonical redirects of the same RIELTOR listing", async () => {
    const finals = [
      "https://www.rieltor.ua/lvov/flats-rent/view/13065183/",
      "https://rieltor.ua/lvov/flats-rent/view/13065183/?utm=1#x",
    ];
    for (const [index, finalUrl] of finals.entries()) {
      const path = dbPath();
      const store = new DurableDeliveryStore(getDb(path));
      const batch: Listing[] = [];
      const adapters = [adapter("lun", () => batch)];
      await seed(store, adapters);
      const sourceId = `canon-${index}`;
      batch.push(lunLinked(sourceId, "https://rieltor.ua/lvov/flats-rent/view/13065183/?utm=1"));
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
          fetchRieltorDetail: async () => page(realtorHtml, 200, finalUrl),
        },
        2,
      );
      expect(report.linkedSellerVerification.detailConfirmedAgent, finalUrl).toBe(1);
      expect(report.sentOk, finalUrl).toBe(0);
      expect(outboxCount(sourceId), finalUrl).toBe(0);
      closeDb();
    }
  });

  it("never fetches an arbitrary or malformed external URL", async () => {
    const urls = [
      "https://evil.example/lvov/flats-rent/view/1/",
      "https://evil.example/steal",
      "https://rieltor.ua/lvov/flats-rent/view/not-numeric/",
      "https://rieltor.ua/view/13065183/",
      "http://rieltor.ua/lvov/flats-rent/view/13065184/",
    ];
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    urls.forEach((url, index) => batch.push(lunLinked(`u${index}`, url)));
    const fetched: string[] = [];
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
        fetchRieltorDetail: async (url) => {
          fetched.push(url);
          return page(realtorHtml, 200, url);
        },
      },
      2,
    );
    expect(fetched).toEqual([]);
    expect(report.linkedSellerVerification.detailRequests).toBe(0);
    expect(report.sentOk).toBe(urls.length);
  });

  it("reuses a confirmed verdict across reopen and skips a second detail request", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lunLinked("4725847579", "https://rieltor.ua/lvov/flats-rent/view/13064911/"));
    let calls = 0;
    const fetchRieltorDetail = async (url: string) => {
      calls += 1;
      return page(realtorHtml, 200, url);
    };
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail,
      },
      2,
    );
    expect(calls).toBe(1);
    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    const again = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail,
      },
      3,
    );
    expect(calls).toBe(1);
    expect(again.sentOk).toBe(0);
    expect(again.linkedSellerVerification.cacheConfirmedAgent).toBe(1);
    expect(outboxCount("4725847579")).toBe(0);
  });

  it("reuses a confirmed owner cache without a second detail request", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lunLinked("owner-1", "https://rieltor.ua/lvov/flats-rent/view/777/"));
    let calls = 0;
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url) => {
          calls += 1;
          return page(ownerHtml, 200, url);
        },
      },
      2,
    );
    expect(calls).toBe(1);
    getDb().prepare("DELETE FROM seen_listings").run();
    getDb().prepare("DELETE FROM telegram_outbox").run();
    const again = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url) => {
          calls += 1;
          return page(realtorHtml, 200, url);
        },
      },
      3,
    );
    expect(calls).toBe(1);
    expect(again.linkedSellerVerification.cacheConfirmedOwner).toBe(1);
    expect(again.sentOk).toBe(1);
  });

  it("re-verifies an expired cache row", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    batch.push(lunLinked("exp", "https://rieltor.ua/lvov/flats-rent/view/888/"));
    let calls = 0;
    const fetchRieltorDetail = async (url: string) => {
      calls += 1;
      return page(realtorHtml, 200, url);
    };
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail,
      },
      2,
    );
    getDb()
      .prepare("UPDATE external_seller_verifications SET expires_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail,
      },
      3,
    );
    expect(calls).toBe(2);
  });

  it("does not detail-fetch a silent baseline or an already-seen listing", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const item = lunLinked("seeded", "https://rieltor.ua/lvov/flats-rent/view/321/");
    let calls = 0;
    const fetchRieltorDetail = async (url: string) => {
      calls += 1;
      return page(realtorHtml, 200, url);
    };
    await runTelegramTestCycle(
      {
        adapters: [adapter("lun", () => [item])],
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
        rieltorDetailGapMs: 0,
        fetchRieltorDetail,
      },
      1,
    );
    expect(calls).toBe(0);
    expect(outboxCount("seeded")).toBe(0);
    await runTelegramTestCycle(
      {
        adapters: [adapter("lun", () => [item])],
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail,
      },
      2,
    );
    expect(calls).toBe(0);
  });

  it("does not verify a fuzzy similar apartment or an OLX isBusiness flag", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const shared = {
      rooms: 2,
      areaM2: 54,
      price: { amount: 18000, currency: "UAH" as const, period: "month" as const },
    };
    const lun = listing({
      source: "lun",
      sourceId: "900",
      url: "https://lun.ua/uk/realty/900",
      ...shared,
    });
    const agent = listing({
      source: "rieltor",
      sourceId: "901",
      url: "https://rieltor.ua/lvov/flats-rent/view/901/",
      sellerType: "agent",
      ...shared,
    });
    const olx = listing({
      source: "lun",
      sourceId: "901b",
      url: "https://lun.ua/uk/realty/901b",
      metadata: {
        originalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID11gWHG.html",
        olxIsBusiness: true,
        ownerEvidenceLevel: "private_unknown",
      },
    });
    const lunBatch: Listing[] = [];
    const rieltorBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("rieltor", () => rieltorBatch)];
    await seed(store, adapters);
    lunBatch.push(lun, olx);
    rieltorBatch.push(agent);
    let calls = 0;
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor({ ENABLE_RIELTOR: "true" }),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url) => {
          calls += 1;
          return page(realtorHtml, 200, url);
        },
      },
      2,
    );
    expect(calls).toBe(0);
    expect(report.sentOk).toBe(2);
    expect(report.linkedSellerVerification.detailRequests).toBe(0);
  });

  it("migrates schema 5 rows forward and deletes only expired verification cache rows", () => {
    const path = dbPath();
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (let version = 1; version <= 5; version += 1) {
      db.exec("BEGIN IMMEDIATE;");
      db.exec(sqliteMigrationSql(version));
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        now.toISOString(),
      );
      db.exec("COMMIT;");
    }
    db.prepare(
      `INSERT INTO source_health (
         source, status, checked_at, consecutive_failures, updated_at
       ) VALUES ('lun', 'ok', ?, 0, ?)`,
    ).run(now.toISOString(), now.toISOString());
    expect(applyMigrations(db)).toBe(7);
    expect(
      (
        db.prepare("SELECT status FROM source_health WHERE source = 'lun'").get() as {
          status: string;
        }
      ).status,
    ).toBe("ok");
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence, checked_at, expires_at
       ) VALUES ('rieltor', '1', 'https://rieltor.ua/lvov/flats-rent/view/1/', 'confirmed_intermediary', 'role=Рієлтор', ?, ?)`,
    ).run(now.toISOString(), "2020-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence, checked_at, expires_at
       ) VALUES ('rieltor', '2', 'https://rieltor.ua/lvov/flats-rent/view/2/', 'confirmed_owner', 'role=Власник', ?, ?)`,
    ).run(now.toISOString(), "2026-10-22T00:00:00.000Z");
    db.close();

    const opened = getDb(path);
    const cleanup = runStateCleanupIfDue(opened, { now, databasePath: path, force: true });
    expect(cleanup.externalSellerRowsRemoved).toBe(1);
    expect(
      opened.prepare("SELECT external_listing_id AS id FROM external_seller_verifications").all(),
    ).toEqual([{ id: "2" }]);
    expect(
      (
        opened.prepare("SELECT status FROM source_health WHERE source = 'lun'").get() as {
          status: string;
        }
      ).status,
    ).toBe("ok");
  });
});
