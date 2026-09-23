import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { rememberOlxProfileProbe } from "../src/delivery/seller-profile.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import type { OlxProfileSnapshot } from "../src/sources/olx/olx-seller-profile.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

const SEED = "2026-09-24T10:00:00.000Z";
const LATER = "2026-09-24T10:20:00.000Z";
const AFTER = "2026-09-24T10:40:00.000Z";

const nadia: OlxProfileSnapshot = {
  acquired: true,
  totalPages: 1,
  totalElements: 6,
  visibleAds: 6,
  realEstateAds: 2,
};
const mixed: OlxProfileSnapshot = {
  acquired: true,
  totalPages: 2,
  totalElements: 15,
  visibleAds: 15,
  realEstateAds: 1,
};
const tkachuk: OlxProfileSnapshot = {
  acquired: true,
  totalPages: 2,
  totalElements: 13,
  visibleAds: 13,
  realEstateAds: 13,
};

describe("OLX profile probe budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-olx-profile-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  function config() {
    resetConfigCache();
    return loadConfig({
      OWNER_ONLY: "false",
      SELLER_POLICY: "reject_intermediaries",
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "false",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: "true",
      ENABLE_RIELTOR: "false",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
      TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
      ADMIN_TELEGRAM_CHAT_ID: "admin",
    });
  }

  function listing(
    sourceId: string,
    sellerId: string,
    publishedAt: string,
    owner = false,
  ): Listing {
    return {
      source: "olx",
      sourceId,
      url: `https://www.olx.ua/d/uk/obyavlenie/${sourceId}.html`,
      title: "Квартира",
      location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
      propertyType: "apartment",
      sellerType: owner ? "owner" : "unknown",
      discoveredAt: new Date(publishedAt),
      publishedAt: new Date(publishedAt),
      metadata: {
        olxUserId: sellerId,
        ...(owner ? { ownerEvidenceLevel: "platform_confirmed" } : {}),
      },
    };
  }

  function sink(): TelegramTestSink {
    return {
      chatId: "admin",
      dryRun: false,
      sendListing: async () => ({
        ok: true,
        dryRun: false,
        attempts: 1,
        chatId: "admin",
        messageCount: 1,
      }),
      sendText: async () => ({
        ok: true,
        dryRun: false,
        attempts: 1,
        chatId: "admin",
        messageCount: 1,
      }),
    } as unknown as TelegramTestSink;
  }

  function adapter(result: SourceFetchResult): ListingSourceAdapter {
    return {
      source: "olx",
      fetchLatest: async () => [],
      inspectLatest: async () => result,
      healthCheck: async () => ({ source: "olx", healthy: true, checkedAt: new Date() }),
    };
  }

  function fetched(at: Date, listings: Listing[]): SourceFetchResult {
    return {
      listings,
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: listings.length > 0 ? "ok" : "valid_empty",
      httpStatus: 200,
      health: { source: "olx", healthy: true, checkedAt: at, message: "complete" },
    };
  }

  async function seed(path: string): Promise<DurableDeliveryStore> {
    const store = new DurableDeliveryStore(getDb(path));
    await runTelegramTestCycle(
      {
        adapters: [adapter(fetched(new Date(SEED), []))],
        config: config(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(SEED),
      },
      1,
    );
    return store;
  }

  function pendingKeys(path: string): string[] {
    return (
      getDb(path)
        .prepare("SELECT key FROM schema_meta WHERE key LIKE 'olx_profile_pending:%' ORDER BY key")
        .all() as Array<{ key: string }>
    ).map((row) => row.key);
  }

  function outboxCount(path: string, sourceId: string): number {
    const row = getDb(path)
      .prepare(
        "SELECT COUNT(*) AS count FROM telegram_outbox WHERE source = 'olx' AND source_id = ?",
      )
      .get(sourceId) as { count: number };
    return Number(row.count);
  }

  it("defers the fifth uncached seller and reads it on the next poll after it leaves the catalog", async () => {
    const path = dbPath();
    const store = await seed(path);
    const probed: string[] = [];
    const cards = [1, 2, 3, 4, 5].map((index) =>
      listing(`card-${index}`, `seller-${index}`, LATER),
    );
    const first = await runTelegramTestCycle(
      {
        adapters: [adapter(fetched(new Date(LATER), cards))],
        config: config(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(LATER),
        probeOlxSellerProfile: async (item) => {
          probed.push(item.sourceId);
          return nadia;
        },
      },
      2,
    );
    expect(probed).toEqual(["card-1", "card-2", "card-3", "card-4"]);
    expect(first.sentOk).toBe(4);
    expect(store.hasSeen(cards[4]!)).toBe(false);
    expect(outboxCount(path, "card-5")).toBe(0);
    expect(pendingKeys(path)).toEqual(["olx_profile_pending:card-5"]);
    expect(
      first.sourceAttempts.find((item) => item.source === "olx")?.funnel?.profile_probe_deferred,
    ).toBe(1);

    const second = await runTelegramTestCycle(
      {
        adapters: [adapter(fetched(new Date(AFTER), []))],
        config: config(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(AFTER),
        probeOlxSellerProfile: async (item) => {
          probed.push(item.sourceId);
          return nadia;
        },
      },
      3,
    );
    expect(probed).toEqual(["card-1", "card-2", "card-3", "card-4", "card-5"]);
    expect(second.sentOk).toBe(1);
    expect(store.hasSeen(cards[4]!)).toBe(true);
    expect(pendingKeys(path)).toEqual([]);
  });

  it("uses the cache before opening a browser and probes again after each TTL", async () => {
    const path = dbPath();
    const store = await seed(path);
    const db = getDb(path);
    rememberOlxProfileProbe(
      db,
      "fresh-likely",
      tkachuk,
      new Date(Date.parse(LATER) - 60 * 60 * 1000),
    );
    rememberOlxProfileProbe(
      db,
      "fresh-unknown",
      nadia,
      new Date(Date.parse(LATER) - 10 * 60 * 1000),
    );
    rememberOlxProfileProbe(
      db,
      "stale-unknown",
      nadia,
      new Date(Date.parse(LATER) - 50 * 60 * 1000),
    );
    rememberOlxProfileProbe(
      db,
      "stale-likely",
      tkachuk,
      new Date(Date.parse(LATER) - 13 * 60 * 60 * 1000),
    );
    const probed: string[] = [];
    const cards = [
      listing("fresh-likely-card", "fresh-likely", LATER),
      listing("fresh-unknown-card", "fresh-unknown", LATER),
      listing("stale-unknown-card", "stale-unknown", LATER),
      listing("stale-likely-card", "stale-likely", LATER),
    ];
    const cycle = await runTelegramTestCycle(
      {
        adapters: [adapter(fetched(new Date(LATER), cards))],
        config: config(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(LATER),
        probeOlxSellerProfile: async (item) => {
          probed.push(String(item.metadata?.olxUserId));
          return item.metadata?.olxUserId === "stale-likely" ? tkachuk : nadia;
        },
      },
      2,
    );
    expect(probed.sort()).toEqual(["stale-likely", "stale-unknown"]);
    expect(cycle.sentOk).toBe(2);
    expect(outboxCount(path, "fresh-likely-card")).toBe(0);
    expect(store.hasSeen(cards[3]!)).toBe(true);
  });

  it("sends a mixed inventory, a Nadia-like profile, a failed read, and a confirmed owner", async () => {
    const path = dbPath();
    const store = await seed(path);
    const probed: string[] = [];
    const cards = [
      listing("mixed", "mixed-seller", LATER),
      listing("nadia", "nadia-seller", LATER),
      listing("offline", "offline-seller", LATER),
      listing("owner", "owner-seller", LATER, true),
      listing("tkachuk", "tkachuk-seller", LATER),
    ];
    const cycle = await runTelegramTestCycle(
      {
        adapters: [adapter(fetched(new Date(LATER), cards))],
        config: config(),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(LATER),
        probeOlxSellerProfile: async (item) => {
          const sellerId = String(item.metadata?.olxUserId);
          probed.push(sellerId);
          if (sellerId === "mixed-seller") {
            return mixed;
          }
          if (sellerId === "offline-seller" || sellerId === "owner-seller") {
            return { acquired: false };
          }
          if (sellerId === "tkachuk-seller") {
            return tkachuk;
          }
          return nadia;
        },
      },
      2,
    );
    expect(probed).toEqual(["mixed-seller", "nadia-seller", "offline-seller", "tkachuk-seller"]);
    expect(cycle.sentOk).toBe(4);
    expect(store.hasSeen(cards[4]!)).toBe(true);
    expect(store.hasSeen(cards[3]!)).toBe(true);
  });
});
