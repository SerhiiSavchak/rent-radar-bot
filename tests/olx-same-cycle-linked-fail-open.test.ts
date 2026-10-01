import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import {
  shouldHoldSellerVerification,
  hasSellerHold,
  SELLER_HOLD_MAX_MS,
} from "../src/delivery/seller-verification-hold.ts";
import { CONFIRMED_SELLER_CACHE_MS } from "../src/delivery/rieltor-detail-seller.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import { SELLER_INVENTORY_LIMIT_REASON } from "../src/delivery/seller-profile.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { applyMigrations } from "../src/storage/migrations.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";

const published = new Date("2026-09-22T09:00:00.000Z");
const now = new Date("2026-09-22T10:00:00.000Z");
const TOKEN = "11sc001";
const OLX_URL = `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${TOKEN}.html`;

function lunLinked(meta: Record<string, unknown> = {}): Listing {
  return {
    source: "lun",
    sourceId: "lun-sc-1",
    url: "https://lun.ua/uk/realty/lun-sc-1",
    title: "Квартира",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: published,
    publishedAt: published,
    metadata: {
      originalUrl: OLX_URL,
      ownerEvidenceLevel: "platform_confirmed",
      ...meta,
    },
  };
}

function olxPeer(meta: Record<string, unknown> = {}): Listing {
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

function incompleteHtml(): string {
  return derivedOracleOfferDetailHtml({
    id: 11,
    url: OLX_URL,
    title: "Квартира",
    description: "оренда",
    user: { name: "Продавець", company_name: null, sellerType: null },
    isBusiness: false,
  });
}

function ownerHtml(): string {
  return derivedOracleOfferDetailHtml({
    id: 11,
    url: OLX_URL,
    title: "Квартира",
    description: "оренда",
    user: { name: "Власник", company_name: null, sellerType: "owner" },
    isBusiness: false,
  }).replace(
    "</body>",
    `<p data-testid="member-since">на OLX з <span>січень 2018 р.</span></p></body>`,
  );
}

describe("LUN→OLX same-cycle fail-closed (verifier)", () => {
  it("incomplete peer is detail_unknown and is not held under reject_intermediaries", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked(), olxPeer()],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: incompleteHtml() }),
      probeProfile: async () => ({
        acquired: true,
        totalPages: 2,
        pagesFetched: 1,
        precisePropertyKeys: ["львів вул а 1"],
        totalElements: 10,
        visibleAds: 5,
        realEstateAds: 5,
      }),
    });
    const decision = await verify(lunLinked());
    expect(decision.outcome).toBe("detail_unknown");
    expect(shouldHoldSellerVerification(decision, "reject_intermediaries")).toBe(false);
    expect(shouldHoldSellerVerification(decision, "owner_only")).toBe(true);
  });

  it("same-cycle confirmed intermediary rejects without detail", async () => {
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      peers: [
        lunLinked(),
        {
          ...olxPeer(),
          sellerType: "agent",
          metadata: { urlToken: TOKEN, ownerEvidenceLevel: "intermediary" },
        },
      ],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        throw new Error("must not fetch");
      },
    });
    const decision = await verify(lunLinked());
    expect(fetches).toBe(0);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("same_cycle_confirmed_agent");
  });

  it("same-cycle inventory reject without detail", async () => {
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked(), olxPeer({ distinctPreciseRealEstateProperties: 5 })],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        throw new Error("must not fetch");
      },
    });
    const decision = await verify(lunLinked());
    expect(fetches).toBe(0);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("same_cycle_inventory_limit");
    expect(decision.evidence).toBe(SELLER_INVENTORY_LIMIT_REASON);
  });

  it("incomplete peer + cached confirmed owner allows", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const checkedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + CONFIRMED_SELLER_CACHE_MS).toISOString();
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', ?, ?, 'confirmed_owner', 'cached owner', ?, ?, NULL, NULL)`,
    ).run(TOKEN, OLX_URL, checkedAt, expiresAt);
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [lunLinked(), olxPeer()],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        throw new Error("cache owner must win");
      },
    });
    const decision = await verify(lunLinked());
    expect(fetches).toBe(0);
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("cache_confirmed_owner");
  });

  it("incomplete peer + cached unknown is cache_unknown and not held under reject_intermediaries", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const checkedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', ?, ?, 'unknown', 'cached unknown', ?, ?, NULL, NULL)`,
    ).run(TOKEN, OLX_URL, checkedAt, expiresAt);
    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [lunLinked(), olxPeer()],
      now: () => now,
      timeoutMs: 1000,
      maxProfileProbes: 0,
      fetchPage: async () => {
        throw new Error("cap exhausted — must not fetch");
      },
    });
    const decision = await verify(lunLinked());
    expect(decision.outcome).toBe("cache_unknown");
    expect(shouldHoldSellerVerification(decision, "reject_intermediaries")).toBe(false);
    expect(shouldHoldSellerVerification(decision, "owner_only")).toBe(true);
  });

  it("verification timeout holds", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [lunLinked(), olxPeer()],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        const err = new Error("page.goto: Timeout 45000ms exceeded.");
        err.name = "TimeoutError";
        throw err;
      },
      fetchViaBrowser: async () => {
        throw new Error("browser timeout");
      },
    });
    const decision = await verify(lunLinked());
    expect(decision.drop).toBe(false);
    expect(decision.outcome).not.toBe("same_cycle_resolved");
    expect(shouldHoldSellerVerification(decision)).toBe(true);
  });

  it("unverified peer != confirmed owner peer", async () => {
    const incomplete = await createCycleOlxSellerVerifier({
      peers: [lunLinked(), olxPeer()],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: incompleteHtml() }),
      probeProfile: async () => ({ acquired: false }),
    })(lunLinked());
    const confirmed = await createCycleOlxSellerVerifier({
      peers: [
        lunLinked(),
        {
          ...olxPeer({ ownerEvidenceLevel: "platform_confirmed" }),
          sellerType: "owner",
        },
      ],
      now: () => now,
      timeoutMs: 1000,
      fetchPage: async () => {
        throw new Error("no fetch");
      },
    })(lunLinked());
    expect(incomplete.outcome).not.toBe("same_cycle_resolved");
    expect(shouldHoldSellerVerification(incomplete)).toBe(true);
    expect(confirmed.outcome).toBe("same_cycle_resolved");
    expect(shouldHoldSellerVerification(confirmed)).toBe(false);
  });
});

describe("LUN→OLX same-cycle pipeline holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-sc-pipe-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function configFor() {
    resetConfigCache();
    return loadConfig({
      TELEGRAM_TEST_MODE: "true",
      TELEGRAM_BOT_TOKEN: "1:test",
      TELEGRAM_CHAT_ID: "1",
      ENABLE_OLX: "true",
      ENABLE_OLX_BROWSER: "false",
      ENABLE_LUN: "true",
      ENABLE_DOMRIA: "false",
      ENABLE_RIELTOR: "false",
      SELLER_POLICY: "reject_intermediaries",
      FRESHNESS_MAX_PUBLICATION_AGE_MINUTES: "10080",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
    });
  }

  function adapter(source: Listing["source"], listings: () => Listing[]): ListingSourceAdapter {
    return {
      source,
      fetchLatest: async () => listings(),
      inspectLatest: async (): Promise<SourceFetchResult> => {
        const batch = listings();
        return {
          listings: batch,
          transport: "test",
          dataKind: "MOCK DATA",
          resultKind: batch.length > 0 ? "ok" : "valid_empty",
          httpStatus: 200,
          health: { source, healthy: true, checkedAt: now, message: "ok" },
        };
      },
      healthCheck: async () => ({ source, healthy: true, checkedAt: now }),
    };
  }

  function sink(dryRun = false): TelegramTestSink {
    return {
      chatId: "1",
      dryRun,
      sendListing: async () => ({
        ok: true,
        dryRun,
        attempts: 1,
        chatId: "1",
        messageCount: 1,
      }),
      sendText: async () => ({
        ok: true,
        dryRun,
        attempts: 1,
        chatId: "1",
        messageCount: 1,
      }),
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
        now: () => new Date(published.getTime() - 60_000),
        firstRunMode: "seed",
      },
      1,
    );
  }

  it("incomplete same-cycle peer delivers the LUN listing under reject_intermediaries", async () => {
    fileIndex += 1;
    const path = join(dir, `h-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("olx", () => olxBatch)];
    await seed(store, adapters);
    lunBatch.push(lunLinked());
    olxBatch.push(olxPeer());

    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: incompleteHtml() }),
        probeOlxProfile: async () => ({
          acquired: true,
          totalPages: 2,
          pagesFetched: 1,
          precisePropertyKeys: ["львів вул а 1"],
          totalElements: 10,
          visibleAds: 5,
          realEstateAds: 5,
        }),
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(store.hasSeen(lunLinked())).toBe(true);
    expect(hasSellerHold(getDb(path), "lun", "lun-sc-1")).toBe(false);
  });

  it("retry recovery: hold then confirmed owner sends once", async () => {
    fileIndex += 1;
    const path = join(dir, `r-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("olx", () => olxBatch)];
    await seed(store, adapters);
    lunBatch.push(lunLinked());
    olxBatch.push(olxPeer());

    let phase: "unknown" | "owner" = "unknown";
    const first = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => ({
          status: 200,
          finalUrl: OLX_URL,
          bodyText: phase === "owner" ? ownerHtml() : incompleteHtml(),
        }),
        probeOlxProfile: async () =>
          phase === "owner"
            ? {
                acquired: true,
                listingHtml: ownerHtml(),
                totalPages: 1,
                pagesFetched: 1,
                precisePropertyKeys: ["львів вул а 1"],
                totalElements: 1,
                visibleAds: 1,
                realEstateAds: 1,
              }
            : { acquired: false },
      },
      2,
    );
    expect(first.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "lun", "lun-sc-1")).toBe(true);

    phase = "owner";
    // Only hold resolution should run — no live batch re-entry.
    lunBatch.length = 0;
    olxBatch.length = 0;
    const second = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 10 * 60 * 1000),
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: ownerHtml() }),
        probeOlxProfile: async () => ({
          acquired: true,
          listingHtml: ownerHtml(),
          totalPages: 1,
          pagesFetched: 1,
          precisePropertyKeys: ["львів вул а 1"],
          totalElements: 1,
          visibleAds: 1,
          realEstateAds: 1,
        }),
      },
      3,
    );
    expect(second.sentOk).toBe(1);
    expect(hasSellerHold(getDb(path), "lun", "lun-sc-1")).toBe(false);

    const third = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 20 * 60 * 1000),
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: ownerHtml() }),
        probeOlxProfile: async () => ({
          acquired: true,
          listingHtml: ownerHtml(),
          totalPages: 1,
          pagesFetched: 1,
          precisePropertyKeys: ["львів вул а 1"],
          totalElements: 1,
          visibleAds: 1,
          realEstateAds: 1,
        }),
      },
      4,
    );
    expect(third.sentOk).toBe(0);
  });

  it("retry rejection: hold then intermediary never sends", async () => {
    fileIndex += 1;
    const path = join(dir, `j-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("olx", () => olxBatch)];
    await seed(store, adapters);
    lunBatch.push(lunLinked());
    olxBatch.push(olxPeer());

    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: incompleteHtml() }),
        probeOlxProfile: async () => ({ acquired: false }),
      },
      2,
    );
    expect(hasSellerHold(getDb(path), "lun", "lun-sc-1")).toBe(true);

    // Strong reject via same-cycle peer on the retry cycle.
    olxBatch.length = 0;
    olxBatch.push({
      ...olxPeer(),
      sellerType: "agent",
      metadata: { urlToken: TOKEN, ownerEvidenceLevel: "intermediary" },
    });
    const second = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 10 * 60 * 1000),
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => {
          throw new Error("same-cycle agent must not detail-fetch");
        },
      },
      3,
    );
    expect(second.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "lun", "lun-sc-1")).toBe(false);
    expect(store.hasSeen(lunLinked())).toBe(true);
  });

  it("restart preserves unresolved hold without auto-send", async () => {
    fileIndex += 1;
    const path = join(dir, `s-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("olx", () => olxBatch)];
    await seed(store, adapters);
    lunBatch.push(lunLinked());
    olxBatch.push(olxPeer());

    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: incompleteHtml() }),
        probeOlxProfile: async () => ({ acquired: false }),
      },
      2,
    );
    expect(hasSellerHold(getDb(path), "lun", "lun-sc-1")).toBe(true);
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
        now: () => new Date(now.getTime() + SELLER_HOLD_MAX_MS + 60_000),
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: incompleteHtml() }),
        probeOlxProfile: async () => ({ acquired: false }),
      },
      3,
    );
    expect(again.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "lun", "lun-sc-1")).toBe(true);
    expect(reopened.hasSeen(lunLinked())).toBe(false);
  });

  it("dry-run defers without hold/seen/outbox mutation", async () => {
    fileIndex += 1;
    const path = join(dir, `d-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("olx", () => olxBatch)];
    await seed(store, adapters);
    lunBatch.push(lunLinked());
    olxBatch.push(olxPeer());

    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(true),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => ({ status: 200, finalUrl: OLX_URL, bodyText: incompleteHtml() }),
        probeOlxProfile: async () => ({ acquired: false }),
      },
      2,
    );
    expect(report.dryRun).toBe(true);
    expect(report.sentOk).toBe(0);
    expect(store.hasSeen(lunLinked())).toBe(false);
    expect(hasSellerHold(getDb(path), "lun", "lun-sc-1")).toBe(false);
  });
});
