import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import type { LinkedSellerDecision } from "../src/delivery/rieltor-detail-seller.ts";
import {
  hasSellerHold,
  resolveDueSellerHolds,
  shouldHoldSellerVerification,
} from "../src/delivery/seller-verification-hold.ts";
import { upsertSellerHold } from "../src/delivery/seller-verification-hold.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { SellerType } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import {
  OWNER_SEARCH_TAG_CONFIRMED,
  OWNER_SEARCH_TAG_UNVERIFIED,
  formatListingTelegramHtml,
} from "../src/outputs/telegram-test.sink.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import type { OlxProfileSnapshot } from "../src/sources/olx/olx-seller-profile.ts";
import { applyMigrations } from "../src/storage/migrations.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";

const published = new Date("2026-09-22T09:00:00.000Z");
const now = new Date("2026-09-22T10:00:00.000Z");

const detailUnknown: LinkedSellerDecision = {
  outcome: "detail_unknown",
  drop: false,
  requested: false,
  evidence: "olx_profile_probe_cap=2",
};

const cacheUnknown: LinkedSellerDecision = {
  outcome: "cache_unknown",
  drop: false,
  requested: false,
  evidence: "cached OLX unknown",
};

function olxUrl(sourceId: string): string {
  return `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${sourceId}.html`;
}

function listingHtml(sourceId: string): string {
  const base = derivedOracleOfferDetailHtml({
    id: 11,
    url: olxUrl(sourceId),
    title: "Квартира",
    description: "оренда від власника",
    user: {
      name: "Продавець",
      company_name: null,
      sellerType: null,
    },
    isBusiness: false,
  });
  return base.replace(
    "</body>",
    `<a href="/uk/list/user/fpseller/">усі оголошення</a><p data-testid="member-since">на OLX з <span>січень 2021 р.</span></p></body>`,
  );
}

function incompleteSnapshot(sourceId: string): OlxProfileSnapshot {
  return {
    acquired: true,
    listingHtml: listingHtml(sourceId),
    totalPages: 2,
    pagesFetched: 1,
    precisePropertyKeys: ["львів вул а 1"],
    totalElements: 10,
    visibleAds: 5,
    realEstateAds: 5,
  };
}

function olxListing(
  sourceId: string,
  meta: Record<string, unknown> = {},
  sellerType: SellerType = "unknown",
): Listing {
  return {
    source: "olx",
    sourceId,
    url: olxUrl(sourceId),
    title: "Квартира",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType,
    discoveredAt: published,
    publishedAt: published,
    metadata: { urlToken: sourceId, ...meta },
  };
}

function insertVerdict(
  db: DatabaseSync,
  sourceId: string,
  verdict: string,
  evidence: string,
): void {
  const checkedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO external_seller_verifications (
       source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
       checked_at, expires_at, last_http_status, last_error_safe
     ) VALUES ('olx', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(sourceId, olxUrl(sourceId), verdict, evidence, checkedAt, expiresAt);
}

function outboxCount(db: DatabaseSync, sourceId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM telegram_outbox WHERE source = 'olx' AND source_id = ?")
    .get(sourceId) as { n: number };
  return Number(row.n);
}

describe("reject_intermediaries does not hold evaluated unknown", () => {
  it("does not hold detail_unknown or cache_unknown under reject_intermediaries", () => {
    expect(shouldHoldSellerVerification(detailUnknown, "reject_intermediaries")).toBe(false);
    expect(shouldHoldSellerVerification(cacheUnknown, "reject_intermediaries")).toBe(false);
  });

  it("still holds evaluated unknown under owner_only", () => {
    expect(shouldHoldSellerVerification(detailUnknown, "owner_only")).toBe(true);
    expect(shouldHoldSellerVerification(cacheUnknown, "owner_only")).toBe(true);
  });

  it("still holds temporary acquisition failures under reject_intermediaries", () => {
    for (const outcome of [
      "detail_transport_failure",
      "detail_rate_limited",
      "detail_parser_failure",
      "skipped_after_rate_limit",
    ] as const) {
      expect(
        shouldHoldSellerVerification(
          { outcome, drop: false, requested: false },
          "reject_intermediaries",
        ),
      ).toBe(true);
    }
  });

  it("still terminal-rejects explicit intermediary outcomes", () => {
    for (const outcome of [
      "detail_confirmed_agent",
      "detail_registration_year_excluded",
      "detail_inventory_limit",
    ] as const) {
      expect(
        shouldHoldSellerVerification(
          { outcome, drop: true, requested: false },
          "reject_intermediaries",
        ),
      ).toBe(false);
    }
  });

  it("does not keep an existing unknown hold forever under reject_intermediaries", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const listing = olxListing("hold0001", { ownerEvidenceLevel: "private_unknown" });
    upsertSellerHold(db, listing, "hold0001", new Date(now.getTime() - 60_000), "olx");
    const actions = await resolveDueSellerHolds(
      db,
      now,
      async () => detailUnknown,
      "reject_intermediaries",
    );
    expect(actions).toEqual([{ listing, action: "send" }]);
    expect(hasSellerHold(db, "olx", "hold0001")).toBe(false);
    const again = await resolveDueSellerHolds(
      db,
      now,
      async () => detailUnknown,
      "reject_intermediaries",
    );
    expect(again).toEqual([]);
  });

  it("returns cache_unknown from an exhausted probe budget without holding it", async () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    insertVerdict(db, "cachecap1", "unknown", "olx_profile_probe_cap=2");
    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      maxProfileProbes: 0,
      probeProfile: async () => {
        throw new Error("must not probe when the budget is exhausted");
      },
    });
    const decision = await verify(
      olxListing("cachecap1", { ownerEvidenceLevel: "private_unknown" }),
    );
    expect(decision.outcome).toBe("cache_unknown");
    expect(decision.drop).toBe(false);
    expect(shouldHoldSellerVerification(decision, "reject_intermediaries")).toBe(false);
  });
});

describe("reject_intermediaries unknown delivery path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-unknown-hold-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function configFor(extra: Record<string, string> = {}) {
    resetConfigCache();
    return loadConfig({
      TELEGRAM_TEST_MODE: "true",
      TELEGRAM_BOT_TOKEN: "1:test",
      TELEGRAM_CHAT_ID: "1",
      ENABLE_OLX: "true",
      ENABLE_OLX_BROWSER: "false",
      ENABLE_LUN: "false",
      ENABLE_DOMRIA: "false",
      ENABLE_RIELTOR: "false",
      SELLER_POLICY: "reject_intermediaries",
      FRESHNESS_MAX_PUBLICATION_AGE_MINUTES: "10080",
      GEO_UNKNOWN_POLICY: "include",
      ...extra,
    });
  }

  function adapter(listings: () => Listing[]): ListingSourceAdapter {
    return {
      source: "olx",
      fetchLatest: async () => listings(),
      inspectLatest: async (): Promise<SourceFetchResult> => {
        const batch = listings();
        return {
          listings: batch,
          transport: "test",
          dataKind: "MOCK DATA",
          resultKind: batch.length > 0 ? "ok" : "valid_empty",
          httpStatus: 200,
          health: { source: "olx", healthy: true, checkedAt: now, message: "ok" },
        };
      },
      healthCheck: async () => ({ source: "olx", healthy: true, checkedAt: now }),
    };
  }

  function recordingSink(sent: Listing[]): TelegramTestSink {
    return {
      chatId: "1",
      dryRun: false,
      sendListing: async (listing: Listing) => {
        sent.push(listing);
        return { ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 };
      },
      sendText: async () => ({
        ok: true,
        dryRun: false,
        attempts: 1,
        chatId: "1",
        messageCount: 1,
      }),
    } as unknown as TelegramTestSink;
  }

  async function seed(
    store: DurableDeliveryStore,
    adapters: ListingSourceAdapter[],
    policy = "reject_intermediaries",
  ) {
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor({ SELLER_POLICY: policy, FIRST_RUN_MODE: "seed" }),
        sink: recordingSink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(published.getTime() - 60_000),
        firstRunMode: "seed",
      },
      1,
    );
  }

  async function deliverUnknown(sourceId: string, meta: Record<string, unknown>) {
    fileIndex += 1;
    const path = join(dir, `d-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    await seed(store, adapters);
    const listing = olxListing(sourceId, meta);
    batch.push(listing);
    const sent: Listing[] = [];
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: recordingSink(sent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => incompleteSnapshot(sourceId),
      },
      2,
    );
    return { path, store, sent, report, listing };
  }

  it("delivers direct OLX private_unknown after detail_unknown without confirming ownership", async () => {
    const { path, store, sent, report, listing } = await deliverUnknown("priv0001", {
      ownerEvidenceLevel: "private_unknown",
    });
    expect(report.linkedSellerVerification.detailUnknown).toBe(1);
    expect(report.sentOk).toBe(1);
    expect(hasSellerHold(getDb(path), "olx", "priv0001")).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.metadata?.ownerEvidenceLevel).toBe("private_unknown");
    const html = formatListingTelegramHtml(sent[0]!);
    expect(html).toContain(OWNER_SEARCH_TAG_UNVERIFIED);
    expect(html).not.toContain(OWNER_SEARCH_TAG_CONFIRMED);
    expect(store.hasSeen(listing)).toBe(true);

    const again = await runTelegramTestCycle(
      {
        adapters: [adapter(() => [listing])],
        config: configFor(),
        sink: recordingSink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 60_000),
        probeOlxProfile: async () => incompleteSnapshot("priv0001"),
      },
      3,
    );
    expect(again.sentOk).toBe(0);
    expect(outboxCount(getDb(path), "priv0001")).toBe(1);
  });

  it("delivers self_declared OLX after detail_unknown", async () => {
    const { path, sent, report } = await deliverUnknown("self0001", {
      ownerEvidenceLevel: "self_declared",
    });
    expect(report.linkedSellerVerification.detailUnknown).toBe(1);
    expect(report.sentOk).toBe(1);
    expect(hasSellerHold(getDb(path), "olx", "self0001")).toBe(false);
    expect(sent[0]?.metadata?.ownerEvidenceLevel).toBe("self_declared");
    expect(formatListingTelegramHtml(sent[0]!)).toContain(OWNER_SEARCH_TAG_UNVERIFIED);
  });

  it("delivers cache_unknown once the probe budget is exhausted", async () => {
    fileIndex += 1;
    const path = join(dir, `c-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    await seed(store, adapters);
    const target = olxListing("cache0001", { ownerEvidenceLevel: "private_unknown" });
    batch.push(
      olxListing("filla0001", { ownerEvidenceLevel: "private_unknown" }),
      olxListing("fillb0001", { ownerEvidenceLevel: "private_unknown" }),
      target,
    );
    insertVerdict(getDb(path), "cache0001", "unknown", "olx_profile_probe_cap=2");
    let probes = 0;
    const sent: Listing[] = [];
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: recordingSink(sent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async (input) => {
          probes += 1;
          const token = input.listingUrl.match(/ID([A-Za-z0-9]+)\.html/i)?.[1] ?? "cache0001";
          return incompleteSnapshot(token);
        },
      },
      2,
    );
    expect(report.linkedSellerVerification.detailUnknown).toBe(2);
    expect(report.linkedSellerVerification.cacheUnknown).toBe(1);
    expect(probes).toBe(2);
    expect(report.sentOk).toBe(3);
    expect(sent.map((item) => item.sourceId)).toContain("cache0001");
    expect(hasSellerHold(getDb(path), "olx", "cache0001")).toBe(false);
    const cached = sent.find((item) => item.sourceId === "cache0001");
    expect(cached?.metadata?.ownerEvidenceLevel).toBe("private_unknown");
    expect(formatListingTelegramHtml(cached!)).toContain(OWNER_SEARCH_TAG_UNVERIFIED);
  });

  it("keeps owner_only + detail_unknown deferred", async () => {
    fileIndex += 1;
    const path = join(dir, `o-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    await seed(store, adapters, "owner_only");
    batch.push(
      olxListing(
        "own00001",
        { ownerEvidenceLevel: "platform_confirmed" },
        "owner",
      ),
    );
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor({ SELLER_POLICY: "owner_only" }),
        sink: recordingSink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => incompleteSnapshot("own00001"),
      },
      2,
    );
    expect(report.linkedSellerVerification.detailUnknown).toBe(1);
    expect(report.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "olx", "own00001")).toBe(true);
    expect(outboxCount(getDb(path), "own00001")).toBe(0);
  });

  it.each([
    ["transport_failure", "trns0001", "detailTransportFailure"],
    ["rate_limited", "rate0001", "detailRateLimited"],
    ["parser_failure", "pars0001", "detailParserFailure"],
  ] as const)("holds cached %s under reject_intermediaries", async (verdict, sourceId, counter) => {
    fileIndex += 1;
    const path = join(dir, `t-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    await seed(store, adapters);
    batch.push(olxListing(sourceId, { ownerEvidenceLevel: "private_unknown" }));
    insertVerdict(getDb(path), sourceId, verdict, verdict);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: recordingSink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => {
          throw new Error("cached temporary failure must not be re-probed");
        },
      },
      2,
    );
    expect(report.linkedSellerVerification[counter]).toBe(1);
    expect(report.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "olx", sourceId)).toBe(true);
    expect(store.hasSeen(olxListing(sourceId))).toBe(false);
  });

  it.each([
    ["confirmed_intermediary", "agent0001", "cacheConfirmedAgent"],
    ["seller_registration_year_2026", "year0001", "cacheRegistrationYearExcluded"],
    ["seller_inventory_limit", "inv00001", "cacheInventoryLimit"],
  ] as const)("terminally rejects cached %s", async (verdict, sourceId, counter) => {
    fileIndex += 1;
    const path = join(dir, `r-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const listing = olxListing(sourceId, { ownerEvidenceLevel: "private_unknown" });
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    await seed(store, adapters);
    batch.push(listing);
    insertVerdict(getDb(path), sourceId, verdict, verdict);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: recordingSink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => {
          throw new Error("terminal cache must not be re-probed");
        },
      },
      2,
    );
    expect(report.linkedSellerVerification[counter]).toBe(1);
    expect(report.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "olx", sourceId)).toBe(false);
    expect(store.hasSeen(listing)).toBe(true);
    expect(outboxCount(getDb(path), sourceId)).toBe(0);
  });

  it("releases a persisted unknown hold through the normal freshness path once", async () => {
    fileIndex += 1;
    const path = join(dir, `h-${fileIndex}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const listing = olxListing("held0001", { ownerEvidenceLevel: "private_unknown" });
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    await seed(store, adapters);
    batch.push(listing);
    upsertSellerHold(getDb(path), listing, "held0001", new Date(now.getTime() - 60_000), "olx");
    const sent: Listing[] = [];
    const first = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: recordingSink(sent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => incompleteSnapshot("held0001"),
      },
      2,
    );
    expect(first.sentOk).toBe(1);
    expect(hasSellerHold(getDb(path), "olx", "held0001")).toBe(false);
    expect(sent[0]?.metadata?.ownerEvidenceLevel).toBe("private_unknown");
    expect(formatListingTelegramHtml(sent[0]!)).toContain(OWNER_SEARCH_TAG_UNVERIFIED);
    expect(outboxCount(getDb(path), "held0001")).toBe(1);

    const second = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: recordingSink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 60_000),
        probeOlxProfile: async () => incompleteSnapshot("held0001"),
      },
      3,
    );
    expect(second.sentOk).toBe(0);
    expect(outboxCount(getDb(path), "held0001")).toBe(1);
  });
});
