import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import { CONFIRMED_SELLER_CACHE_MS } from "../src/delivery/rieltor-detail-seller.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { applyMigrations } from "../src/storage/migrations.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { OLX_SELLER_REGISTRATION_YEAR_2026_REASON } from "../src/sources/olx/olx-account-registration.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";
import { derivedOracleHousePrivateAd } from "./fixtures/olx-prerendered-oracle-derived.ts";

const published = new Date("2026-09-22T09:00:00.000Z");
const now = new Date("2026-09-22T10:00:00.000Z");
const TOKEN = "11reg26";
const OLX_URL = `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${TOKEN}.html`;

function lunLinked(): Listing {
  return {
    source: "lun",
    sourceId: "lun-reg-1",
    url: "https://lun.ua/uk/realty/lun-reg-1",
    title: "Квартира",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: published,
    publishedAt: published,
    metadata: {
      originalUrl: OLX_URL,
      ownerEvidenceLevel: "platform_confirmed",
    },
  };
}

function olxPeer(year: number | undefined): Listing {
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
    metadata: {
      urlToken: TOKEN,
      ...(year !== undefined ? { accountRegistrationYear: year } : {}),
    },
  };
}

describe("LUN→OLX registration year via createCycleOlxSellerVerifier", () => {
  it("rejects same-cycle peer with accountRegistrationYear 2026 without detail fetch", async () => {
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked(), olxPeer(2026)],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        throw new Error("must not fetch when peer year is known 2026");
      },
    });
    const decision = await verify(lunLinked());
    expect(decision.drop).toBe(true);
    expect(decision.requested).toBe(false);
    expect(decision.outcome).toBe("same_cycle_registration_year_excluded");
    expect(decision.evidence).toBe(OLX_SELLER_REGISTRATION_YEAR_2026_REASON);
    expect(fetches).toBe(0);
  });

  it("does not reject same-cycle peer with registration year 2025", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked(), olxPeer(2025)],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        throw new Error("must not fetch when peer year is known non-2026");
      },
    });
    const decision = await verify(lunLinked());
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("same_cycle_resolved");
  });

  it("incomplete peer does not override cached registration-year 2026 rejection", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const checkedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + CONFIRMED_SELLER_CACHE_MS).toISOString();
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', ?, ?, 'seller_registration_year_2026', ?, ?, ?, NULL, NULL)`,
    ).run(TOKEN, OLX_URL, OLX_SELLER_REGISTRATION_YEAR_2026_REASON, checkedAt, expiresAt);

    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [lunLinked(), olxPeer(undefined)],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        throw new Error("cache 2026 must win over incomplete peer");
      },
    });
    const decision = await verify(lunLinked());
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("cache_registration_year_excluded");
    expect(decision.evidence).toBe(OLX_SELLER_REGISTRATION_YEAR_2026_REASON);
    expect(fetches).toBe(0);
  });

  it("incomplete peer without rejecting cache keeps same_cycle_resolved (no detail)", async () => {
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked(), olxPeer(undefined)],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        throw new Error("incomplete peer must not force detail when cache is empty");
      },
    });
    const decision = await verify(lunLinked());
    expect(fetches).toBe(0);
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("same_cycle_resolved");
  });

  it("no peer still detail-fetches and rejects member-since 2026", async () => {
    const ad = {
      ...derivedOracleHousePrivateAd(),
      url: OLX_URL,
      urlPath: `/d/uk/obyavlenie/orenda-ID${TOKEN}.html`,
    };
    const body = derivedOracleOfferDetailHtml(ad, { memberSince: "вересень 2026 р." });
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked()],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        return { status: 200, finalUrl: OLX_URL, bodyText: body };
      },
    });
    const decision = await verify(lunLinked());
    expect(fetches).toBe(1);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_registration_year_excluded");
    expect(decision.evidence).toBe(OLX_SELLER_REGISTRATION_YEAR_2026_REASON);
  });
});

describe("LUN→OLX registration year blocks Telegram delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-reg-year-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  it("does not deliver a linked LUN listing when same-cycle OLX peer is year 2026", async () => {
    fileIndex += 1;
    const sqlitePath = join(dir, `reg-${fileIndex}.sqlite`);
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
        return {
          ok: true,
          dryRun: false,
          attempts: 1,
          chatId: "1",
          messageCount: 1,
        };
      },
      sendText: async () => ({
        ok: true,
        dryRun: false,
        attempts: 1,
        chatId: "1",
        messageCount: 1,
      }),
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
          throw new Error("detail fetch during seed");
        },
      },
      1,
    );

    const lun = lunLinked();
    const olx = olxPeer(2026);
    lunBatch.push(lun);
    olxBatch.push(olx);

    let olxDetailCalls = 0;
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
          olxDetailCalls += 1;
          throw new Error("same-cycle year 2026 must not detail-fetch");
        },
      },
      2,
    );

    expect(sent.filter((item) => item.sourceId === lun.sourceId)).toHaveLength(0);
    expect(report.sentOk).toBe(0);
    expect(report.linkedSellerVerification.sameCycleRegistrationYearExcluded).toBeGreaterThanOrEqual(
      1,
    );
    expect(olxDetailCalls).toBe(0);
    expect(store.hasSeen(lun)).toBe(true);
  });
});
