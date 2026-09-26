import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import { CONFIRMED_SELLER_CACHE_MS } from "../src/delivery/rieltor-detail-seller.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import type { TelegramTestSink as TelegramTestSinkType } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

/**
 * Batch 1 regression: terminal linked-seller rejection must markSeen so a
 * cache_confirmed_agent LUN→OLX listing cannot recycle as newAfterDedupe.
 * newAfterDedupe remains a pre-final-gate count (includes the first-cycle reject).
 */

const seededAt = new Date("2026-09-22T08:00:00.000Z");
const published = new Date("2026-09-22T09:00:00.000Z");
const now = new Date("2026-09-22T10:00:00.000Z");

const STUCK_LUN_ID = "4726270418";
const STUCK_OLX_TOKEN = "11le3r";
const STUCK_OLX_URL = `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${STUCK_OLX_TOKEN}.html`;

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

function lunLinkedOlx(sourceId: string, olxUrl: string): Listing {
  return listing({
    source: "lun",
    sourceId,
    url: `https://lun.ua/uk/realty/${sourceId}`,
    metadata: {
      originalUrl: olxUrl,
      aggregatedSite: "olx.ua",
      ownerEvidenceLevel: "private_unknown",
    },
  });
}

function lunPlain(sourceId: string): Listing {
  return listing({
    source: "lun",
    sourceId,
    url: `https://lun.ua/uk/realty/${sourceId}`,
    sellerType: "owner",
    metadata: { ownerEvidenceLevel: "owner_confirmed" },
  });
}

function lunLinkedRieltor(sourceId: string, rieltorId: string): Listing {
  return listing({
    source: "lun",
    sourceId,
    url: `https://lun.ua/uk/realty/${sourceId}`,
    metadata: {
      originalUrl: `https://rieltor.ua/lvov/flats-rent/view/${rieltorId}/`,
      aggregatedSite: "rieltor.ua",
      ownerEvidenceLevel: "private_unknown",
    },
  });
}

describe("linked-seller terminal rejection (Batch 1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-link-term-"));
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
      SELLER_PROFILE_LIKELY_POLICY: "reject",
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

  /** Persisting sink (dryRun=false) — real outbox/seen path without network. */
  function persistSink(): TelegramTestSinkType {
    return {
      chatId: "1",
      dryRun: false,
      sendListing: async () => ({
        ok: true,
        dryRun: false,
        attempts: 1,
        chatId: "1",
        messageCount: 1,
      }),
      sendText: async () => ({ ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 }),
    } as unknown as TelegramTestSinkType;
  }

  function seedOlxAgentCache(at: Date = now): void {
    const expires = new Date(at.getTime() + CONFIRMED_SELLER_CACHE_MS).toISOString();
    getDb()
      .prepare(
        `INSERT INTO external_seller_verifications (
           source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
           checked_at, expires_at, last_http_status, last_error_safe
         ) VALUES ('olx', ?, ?, 'confirmed_intermediary', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        STUCK_OLX_TOKEN,
        STUCK_OLX_URL,
        "platform account type = business; seller identity name (agency) = АН Дуплекс",
        at.toISOString(),
        expires,
      );
  }

  async function seed(store: DurableDeliveryStore, adapters: ListingSourceAdapter[]) {
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: persistSink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
        fetchOlxDetail: async () => {
          throw new Error("detail fetch during seed");
        },
        olxDetailGapMs: 0,
      },
      1,
    );
  }

  function outboxCount(sourceId: string): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = ?")
      .get(sourceId) as { n: number };
    return Number(row.n);
  }

  function holdCount(): number {
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM seller_verification_holds").get() as {
      n: number;
    };
    return Number(row.n);
  }

  function decisionStages(sourceId: string): Array<{ stage: string; reason_code: string }> {
    return getDb()
      .prepare(
        `SELECT stage, reason_code FROM listing_decision_trace
         WHERE source = 'lun' AND source_id = ? ORDER BY id`,
      )
      .all(sourceId) as Array<{ stage: string; reason_code: string }>;
  }

  it("rejects cache_confirmed_agent once, does not resend as new, survives DB reopen", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    seedOlxAgentCache();

    const stuck = lunLinkedOlx(STUCK_LUN_ID, STUCK_OLX_URL);
    batch.push(stuck);

    let olxDetailCalls = 0;
    const first = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: persistSink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => {
          olxDetailCalls += 1;
          throw new Error("cache should short-circuit detail");
        },
      },
      2,
    );

    // newAfterDedupe counts pre-final-gate unseen; reject still increments once.
    expect(first.newAfterDedupe).toBe(1);
    expect(first.newlyObservedCount).toBe(1);
    expect(first.sentOk).toBe(0);
    expect(first.linkedSellerVerification.cacheConfirmedAgent).toBe(1);
    expect(olxDetailCalls).toBe(0);
    expect(outboxCount(STUCK_LUN_ID)).toBe(0);
    expect(holdCount()).toBe(0);
    expect(store.hasSeen(stuck)).toBe(true);
    const rejectedIdentity = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM cross_source_identities
         WHERE source = 'lun' AND source_id = ?`,
      )
      .get(STUCK_LUN_ID) as { n: number };
    expect(Number(rejectedIdentity.n)).toBe(0);
    const stages = decisionStages(STUCK_LUN_ID);
    expect(stages.some((s) => s.stage === "rejected_seller" && s.reason_code === "cache_confirmed_agent")).toBe(
      true,
    );
    expect(stages.some((s) => s.stage === "held")).toBe(false);

    const second = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: persistSink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 10 * 60 * 1000),
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => {
          olxDetailCalls += 1;
          throw new Error("must not re-verify");
        },
      },
      3,
    );
    expect(second.newAfterDedupe).toBe(0);
    expect(second.sentOk).toBe(0);
    expect(second.linkedSellerVerification.cacheConfirmedAgent).toBe(0);
    expect(olxDetailCalls).toBe(0);
    expect(outboxCount(STUCK_LUN_ID)).toBe(0);

    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    expect(reopened.hasSeen(stuck)).toBe(true);
    const third = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: persistSink(),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date(now.getTime() + 20 * 60 * 1000),
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => {
          throw new Error("must not re-verify after reopen");
        },
      },
      4,
    );
    expect(third.newAfterDedupe).toBe(0);
    expect(third.sentOk).toBe(0);
    expect(outboxCount(STUCK_LUN_ID)).toBe(0);
  });

  it("still delivers another eligible listing in the same cycle as a terminal reject", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    seedOlxAgentCache();
    const eligible = lunPlain("eligible-owner-1");
    batch.push(lunLinkedOlx(STUCK_LUN_ID, STUCK_OLX_URL), eligible);

    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: persistSink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => {
          throw new Error("cache short-circuit");
        },
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(report.newAfterDedupe).toBe(2);
    expect(outboxCount(STUCK_LUN_ID)).toBe(0);
    expect(outboxCount("eligible-owner-1")).toBe(1);
    expect(store.hasSeen(lunLinkedOlx(STUCK_LUN_ID, STUCK_OLX_URL))).toBe(true);
    expect(store.hasSeen(eligible)).toBe(true);
    const rejectedIdentity = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM cross_source_identities
         WHERE source = 'lun' AND source_id = ?`,
      )
      .get(STUCK_LUN_ID) as { n: number };
    expect(Number(rejectedIdentity.n)).toBe(0);
  });

  it("keeps temporary hold retryable and can deliver later when allowed", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    const held = lunLinkedRieltor("hold-then-owner", "13009999");
    batch.push(held);

    const ownerHtml = `<div class="offer-view-rieltor-position">Власник</div>`;
    let html = "blocked";
    let status = 403;
    const cycle = (at: Date, n: number) =>
      runTelegramTestCycle(
        {
          adapters,
          config: configFor(),
          sink: persistSink(),
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => at,
          rieltorDetailGapMs: 0,
          fetchRieltorDetail: async (url) => ({ status, finalUrl: url, bodyText: html }),
        },
        n,
      );

    const first = await cycle(now, 2);
    expect(first.sentOk).toBe(0);
    expect(first.newAfterDedupe).toBe(1);
    expect(holdCount()).toBe(1);
    expect(store.hasSeen(held)).toBe(false);
    expect(outboxCount("hold-then-owner")).toBe(0);
    const heldStages = decisionStages("hold-then-owner");
    expect(heldStages.some((s) => s.stage === "held")).toBe(true);
    expect(heldStages.some((s) => s.stage === "rejected_seller")).toBe(false);

    // Still deferred on the next poll while 403 persists inside hold window.
    const mid = await cycle(new Date(now.getTime() + 10 * 60 * 1000), 3);
    expect(mid.sentOk).toBe(0);
    expect(holdCount()).toBe(1);
    expect(store.hasSeen(held)).toBe(false);

    html = ownerHtml;
    status = 200;
    const sent = await cycle(new Date(now.getTime() + 15 * 60 * 1000), 4);
    expect(sent.sentOk).toBe(1);
    expect(holdCount()).toBe(0);
    expect(outboxCount("hold-then-owner")).toBe(1);
    expect(store.hasSeen(held)).toBe(true);
  });

  it("does not markSeen terminal linked reject under dry-run", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("lun", () => batch)];
    await seed(store, adapters);
    seedOlxAgentCache();
    const stuck = lunLinkedOlx(STUCK_LUN_ID, STUCK_OLX_URL);
    batch.push(stuck);

    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: true,
          timeoutMs: 1000,
          maxRetries: 0,
          fetchImpl: (async () => {
            throw new Error("no network");
          }) as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async () => {
          throw new Error("cache short-circuit");
        },
      },
      2,
    );
    expect(report.dryRun).toBe(true);
    expect(report.sentOk).toBe(0);
    expect(report.linkedSellerVerification.cacheConfirmedAgent).toBe(1);
    expect(store.hasSeen(stuck)).toBe(false);
    expect(outboxCount(STUCK_LUN_ID)).toBe(0);
    expect(holdCount()).toBe(0);
  });
});
