import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import {
  shouldHoldSellerVerification,
  resolveDueSellerHolds,
  upsertSellerHold,
  hasSellerHold,
  countSellerHolds,
  SELLER_HOLD_MAX_MS,
} from "../src/delivery/seller-verification-hold.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import {
  classifyOlxProfileInventory,
  olxProfileInventoryIncomplete,
  type OlxProfileSnapshot,
} from "../src/sources/olx/olx-seller-profile.ts";
import { applyMigrations } from "../src/storage/migrations.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";

const published = new Date("2026-09-22T09:00:00.000Z");
const now = new Date("2026-09-22T10:00:00.000Z");
const TOKEN = "11fp001";
const OLX_URL = `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${TOKEN}.html`;

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

function memberSince(year: number): string {
  return `<p data-testid="member-since">на OLX з <span>січень ${year} р.</span></p>`;
}

function listingHtml(opts: {
  year?: number;
  sellerType?: string | null;
  company?: string | null;
  isBusiness?: boolean;
}): string {
  const base = derivedOracleOfferDetailHtml({
    id: 11,
    url: OLX_URL,
    title: "Квартира",
    description: "оренда від власника",
    user: {
      name: "Продавець",
      company_name: opts.company ?? null,
      sellerType: opts.sellerType ?? null,
    },
    isBusiness: opts.isBusiness ?? false,
  });
  const withProfile = base.replace(
    "</body>",
    `<a href="/uk/list/user/fpseller/">усі оголошення</a></body>`,
  );
  if (opts.year === undefined) {
    return withProfile;
  }
  return withProfile.replace("</body>", `${memberSince(opts.year)}</body>`);
}

function incompleteMultiPageSnapshot(precise: number, coarse: number): OlxProfileSnapshot {
  const precisePropertyKeys = Array.from({ length: precise }, (_, i) => `львів вул тест ${i + 1}`);
  const coarseLocationKeys = Array.from({ length: coarse }, (_, i) => `львів район ${i + 1}`);
  return {
    acquired: true,
    totalPages: 4,
    totalElements: 40,
    visibleAds: 10,
    realEstateAds: 10,
    precisePropertyKeys,
    coarseLocationKeys,
    propertyKeys: precisePropertyKeys.length > 0 ? precisePropertyKeys : coarseLocationKeys,
    pagesFetched: 1,
  };
}

describe("OLX seller-filter fail-open regressions (classifier)", () => {
  it("does not hard-reject unread pages that only show three coarse locations", () => {
    const snap = incompleteMultiPageSnapshot(0, 3);
    expect(olxProfileInventoryIncomplete(snap)).toBe(true);
    expect(classifyOlxProfileInventory(snap).verdict).toBe("unknown");
    expect(classifyOlxProfileInventory(snap).evidence).toContain("olx_inventory_incomplete=1");
  });

  it("keeps incomplete inventory as unknown when reject thresholds are not met", () => {
    const snap = incompleteMultiPageSnapshot(2, 1);
    expect(olxProfileInventoryIncomplete(snap)).toBe(true);
    expect(classifyOlxProfileInventory(snap).verdict).toBe("unknown");
    expect(classifyOlxProfileInventory(snap).evidence).toMatch(/olx_inventory_incomplete=1/);
  });
});

describe("OLX seller-filter fail-open regressions (verifier outcomes)", () => {
  it("direct OLX unknown/incomplete is deliverable under reject_intermediaries", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      probeProfile: async () => ({
        acquired: true,
        listingHtml: listingHtml({ year: 2024 }),
        totalPages: 3,
        totalElements: 20,
        visibleAds: 8,
        realEstateAds: 8,
        precisePropertyKeys: ["львів вул а 1"],
        coarseLocationKeys: [],
        propertyKeys: ["львів вул а 1"],
        pagesFetched: 1,
      }),
    });
    const decision = await verify(olxListing());
    expect(decision.outcome).toBe("detail_unknown");
    expect(decision.drop).toBe(false);
    expect(shouldHoldSellerVerification(decision, "reject_intermediaries")).toBe(false);
    expect(shouldHoldSellerVerification(decision, "owner_only")).toBe(true);
  });

  it("direct OLX registration year 2026 is a terminal reject", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      probeProfile: async () => ({
        acquired: true,
        listingHtml: listingHtml({ year: 2026 }),
        totalPages: 1,
        totalElements: 1,
        visibleAds: 1,
        realEstateAds: 1,
        precisePropertyKeys: [],
        coarseLocationKeys: ["львів сихівський"],
        propertyKeys: ["львів сихівський"],
        pagesFetched: 1,
      }),
    });
    const decision = await verify(olxListing());
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_registration_year_excluded");
  });

  it("profile timeout / unreadable is holdable unresolved", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      probeProfile: async () => {
        throw new Error("page.goto: Timeout 45000ms exceeded.");
      },
    });
    const decision = await verify(olxListing());
    expect(decision.drop).toBe(false);
    expect(decision.outcome).not.toBe("not_required");
    expect(shouldHoldSellerVerification(decision)).toBe(true);
  });

  it("parser-unreadable snapshot is holdable unresolved", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      probeProfile: async () => ({ acquired: false }),
    });
    const decision = await verify(olxListing());
    expect(decision.drop).toBe(false);
    expect(shouldHoldSellerVerification(decision)).toBe(true);
  });

  it("threshold discovery on a later conceptual page stays terminal inventory reject", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      probeProfile: async () => ({
        acquired: true,
        listingHtml: listingHtml({ year: 2020 }),
        totalPages: 3,
        totalElements: 30,
        visibleAds: 20,
        realEstateAds: 20,
        precisePropertyKeys: [
          "львів вул а 1",
          "львів вул б 2",
          "київ вул в 3",
          "одеса вул г 4",
          "харків вул д 5",
        ],
        pagesFetched: 2,
      }),
    });
    const decision = await verify(olxListing());
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_inventory_limit");
  });

  it("cached unknown is deliverable under reject_intermediaries and held under owner_only", async () => {
    const db = getDb(join(mkdtempSync(join(tmpdir(), "rr-fp-cache-")), "c.sqlite"));
    applyMigrations(db);
    const checkedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', ?, ?, 'unknown', 'cached incomplete', ?, ?, NULL, NULL)`,
    ).run(TOKEN, OLX_URL, checkedAt, expiresAt);

    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      maxProfileProbes: 0,
      probeProfile: async () => {
        throw new Error("must not probe when cap is 0");
      },
    });
    const decision = await verify(olxListing());
    expect(decision.outcome).toBe("cache_unknown");
    expect(decision.drop).toBe(false);
    expect(shouldHoldSellerVerification(decision, "reject_intermediaries")).toBe(false);
    expect(shouldHoldSellerVerification(decision, "owner_only")).toBe(true);
  });

  it("confirmed owner with complete non-reject evidence is eligible (not held)", async () => {
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      probeProfile: async () => ({
        acquired: true,
        listingHtml: listingHtml({ year: 2019, sellerType: "owner" }),
        totalPages: 1,
        totalElements: 1,
        visibleAds: 1,
        realEstateAds: 1,
        precisePropertyKeys: ["львів вул домашня 12"],
        coarseLocationKeys: [],
        propertyKeys: ["львів вул домашня 12"],
        pagesFetched: 1,
      }),
    });
    const decision = await verify(olxListing());
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("detail_confirmed_owner");
    expect(shouldHoldSellerVerification(decision)).toBe(false);
  });
});

describe("OLX seller-filter hold semantics", () => {
  it("drops a temporary failure once the original hold deadline is reached", async () => {
    const db = getDb(join(mkdtempSync(join(tmpdir(), "rr-fp-hold-")), "h.sqlite"));
    applyMigrations(db);
    const listing = olxListing();
    upsertSellerHold(db, listing, TOKEN, now, "olx");
    const past = new Date(now.getTime() + SELLER_HOLD_MAX_MS + 60_000);
    const actions = await resolveDueSellerHolds(db, past, async () => ({
      outcome: "detail_transport_failure",
      drop: false,
      requested: false,
      externalId: TOKEN,
      evidence: "still unreachable",
    }));
    expect(actions).toEqual([{ listing, action: "drop" }]);
    expect(hasSellerHold(db, "olx", TOKEN)).toBe(false);
    expect(countSellerHolds(db)).toBe(0);
    closeDb();
  });
});

describe("OLX seller-filter pipeline (direct listings)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-fp-pipe-"));
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
        config: configFor({ FIRST_RUN_MODE: "seed" }),
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

  it("direct OLX unknown sends once and is not held", async () => {
    fileIndex += 1;
    const path = join(dir, `u-${fileIndex}.sqlite`);
    resetConfigCache();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("olx", () => batch)];
    await seed(store, adapters);
    batch.push(olxListing());

    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => ({
          acquired: true,
          listingHtml: listingHtml({ year: 2021 }),
          totalPages: 2,
          totalElements: 12,
          visibleAds: 6,
          realEstateAds: 6,
          precisePropertyKeys: ["львів вул а 1"],
          pagesFetched: 1,
        }),
      },
      2,
    );

    expect(report.linkedSellerVerification.detailUnknown).toBe(1);
    expect(report.sentOk).toBe(1);
    expect(store.hasSeen(olxListing())).toBe(true);
    expect(hasSellerHold(getDb(path), "olx", TOKEN)).toBe(false);
  });

  it("dry-run does not mutate hold/seen/outbox for unresolved direct OLX", async () => {
    fileIndex += 1;
    const path = join(dir, `d-${fileIndex}.sqlite`);
    resetConfigCache();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("olx", () => batch)];
    await seed(store, adapters);
    batch.push(olxListing());
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(true),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => ({ acquired: false }),
      },
      2,
    );
    expect(report.dryRun).toBe(true);
    expect(report.sentOk).toBe(0);
    expect(store.hasSeen(olxListing())).toBe(false);
    expect(hasSellerHold(getDb(path), "olx", TOKEN)).toBe(false);
  });

  it("retry recovery: unresolved then confirmed owner delivers once", async () => {
    fileIndex += 1;
    const path = join(dir, `r-${fileIndex}.sqlite`);
    resetConfigCache();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("olx", () => batch)];
    await seed(store, adapters);
    batch.push(olxListing());

    let phase: "blocked" | "owner" = "blocked";
    const probe = async (): Promise<OlxProfileSnapshot> => {
      if (phase === "blocked") {
        throw new Error("page.goto: Timeout 45000ms exceeded.");
      }
      return {
        acquired: true,
        listingHtml: listingHtml({ year: 2018, sellerType: "owner" }),
        totalPages: 1,
        pagesFetched: 1,
        precisePropertyKeys: ["львів вул а 1"],
        totalElements: 1,
        visibleAds: 1,
        realEstateAds: 1,
      };
    };

    const first = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: probe,
      },
      2,
    );
    expect(first.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "olx", TOKEN)).toBe(true);

    phase = "owner";
    const second = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 10 * 60 * 1000),
        probeOlxProfile: probe,
      },
      3,
    );
    expect(second.sentOk).toBe(1);
    expect(hasSellerHold(getDb(path), "olx", TOKEN)).toBe(false);

    const third = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 20 * 60 * 1000),
        probeOlxProfile: probe,
      },
      4,
    );
    expect(third.sentOk).toBe(0);
  });

  it("retry then inventory reject never sends", async () => {
    fileIndex += 1;
    const path = join(dir, `j-${fileIndex}.sqlite`);
    resetConfigCache();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("olx", () => batch)];
    await seed(store, adapters);
    batch.push(olxListing());

    let phase: "unknown" | "limit" = "unknown";
    const probe = async (): Promise<OlxProfileSnapshot> => {
      if (phase === "unknown") {
        return { acquired: false };
      }
      return {
        acquired: true,
        listingHtml: listingHtml({ year: 2017 }),
        totalPages: 2,
        pagesFetched: 2,
        precisePropertyKeys: [
          "львів вул а 1",
          "львів вул б 2",
          "київ вул в 3",
          "одеса вул г 4",
          "харків вул д 5",
        ],
        totalElements: 20,
        visibleAds: 20,
        realEstateAds: 20,
      };
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
        probeOlxProfile: probe,
      },
      2,
    );
    expect(hasSellerHold(getDb(path), "olx", TOKEN)).toBe(true);

    phase = "limit";
    const second = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 10 * 60 * 1000),
        probeOlxProfile: probe,
      },
      3,
    );
    expect(second.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "olx", TOKEN)).toBe(false);
    expect(store.hasSeen(olxListing())).toBe(true);
  });

  it("unresolved hold survives DB reopen without sending", async () => {
    fileIndex += 1;
    const path = join(dir, `s-${fileIndex}.sqlite`);
    resetConfigCache();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("olx", () => batch)];
    await seed(store, adapters);
    batch.push(olxListing());

    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => ({ acquired: false }),
      },
      2,
    );
    expect(hasSellerHold(getDb(path), "olx", TOKEN)).toBe(true);
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
        now: () => new Date(now.getTime() + 60_000),
        probeOlxProfile: async () => ({ acquired: false }),
      },
      3,
    );
    expect(again.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "olx", TOKEN)).toBe(true);
    expect(reopened.hasSeen(olxListing())).toBe(false);
  });

  it("confirmed owner still delivers", async () => {
    fileIndex += 1;
    const path = join(dir, `o-${fileIndex}.sqlite`);
    resetConfigCache();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter("olx", () => batch)];
    await seed(store, adapters);
    batch.push(olxListing());

    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: async () => ({
          acquired: true,
          listingHtml: listingHtml({ year: 2015, sellerType: "owner" }),
          totalPages: 1,
          pagesFetched: 1,
          precisePropertyKeys: ["львів вул о 1"],
          totalElements: 1,
          visibleAds: 1,
          realEstateAds: 1,
        }),
      },
      2,
    );
    expect(report.sentOk).toBe(1);
  });
});
