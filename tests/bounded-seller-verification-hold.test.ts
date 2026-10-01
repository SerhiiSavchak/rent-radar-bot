import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import type { LinkedSellerDecision } from "../src/delivery/rieltor-detail-seller.ts";
import {
  hasSellerHold,
  keepSellerHold,
  resolveDueSellerHolds,
  SELLER_HOLD_MAX_MS,
  upsertSellerHold,
} from "../src/delivery/seller-verification-hold.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import {
  OWNER_SEARCH_TAG_CONFIRMED,
  OWNER_SEARCH_TAG_UNVERIFIED,
  formatListingTelegramHtml,
} from "../src/outputs/telegram-test.sink.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { applyMigrations } from "../src/storage/migrations.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

const published = new Date("2026-09-22T09:00:00.000Z");
const now = new Date("2026-09-22T10:00:00.000Z");
const SOURCE_ID = "holddl01";

function listing(): Listing {
  return {
    source: "olx",
    sourceId: SOURCE_ID,
    url: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${SOURCE_ID}.html`,
    title: "Власник Конотопська",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: published,
    publishedAt: published,
    metadata: { urlToken: SOURCE_ID, ownerEvidenceLevel: "private_unknown" },
  };
}

function decision(outcome: LinkedSellerDecision["outcome"], drop = false): LinkedSellerDecision {
  return { outcome, drop, requested: false, externalId: SOURCE_ID, evidence: outcome };
}

function releaseAtOf(db: DatabaseSync): string {
  const row = db
    .prepare(
      "SELECT release_at AS releaseAt, attempt_count AS attemptCount FROM seller_verification_holds WHERE source = 'olx' AND source_id = ?",
    )
    .get(SOURCE_ID) as { releaseAt: string; attemptCount: number } | undefined;
  if (!row) {
    throw new Error("expected a seller hold");
  }
  return row.releaseAt;
}

function attemptCountOf(db: DatabaseSync): number {
  const row = db
    .prepare(
      "SELECT attempt_count AS attemptCount FROM seller_verification_holds WHERE source = 'olx' AND source_id = ?",
    )
    .get(SOURCE_ID) as { attemptCount: number };
  return Number(row.attemptCount);
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  return db;
}

describe("seller hold deadline is absolute", () => {
  it("keeps a transport failure before the deadline", async () => {
    const db = memoryDb();
    const item = listing();
    upsertSellerHold(db, item, SOURCE_ID, now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + 60_000),
      async () => decision("detail_transport_failure"),
      "reject_intermediaries",
    );
    expect(actions).toEqual([{ listing: item, action: "keep" }]);
    expect(hasSellerHold(db, "olx", SOURCE_ID)).toBe(true);
  });

  it("keeps a parser failure before the deadline", async () => {
    const db = memoryDb();
    const item = listing();
    upsertSellerHold(db, item, SOURCE_ID, now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + 60_000),
      async () => decision("detail_parser_failure"),
      "reject_intermediaries",
    );
    expect(actions).toEqual([{ listing: item, action: "keep" }]);
    expect(hasSellerHold(db, "olx", SOURCE_ID)).toBe(true);
  });

  it("does not move release_at when a hold is kept", () => {
    const db = memoryDb();
    upsertSellerHold(db, listing(), SOURCE_ID, now, "olx");
    const original = releaseAtOf(db);
    keepSellerHold(db, "olx", SOURCE_ID, new Date(now.getTime() + 5 * 60_000));
    expect(releaseAtOf(db)).toBe(original);
    expect(attemptCountOf(db)).toBe(2);
    expect(original).toBe(new Date(now.getTime() + SELLER_HOLD_MAX_MS).toISOString());
  });

  it("does not extend the original deadline across repeated retries", async () => {
    const db = memoryDb();
    const item = listing();
    upsertSellerHold(db, item, SOURCE_ID, now, "olx");
    const original = releaseAtOf(db);
    const first = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + 60_000),
      async () => decision("detail_parser_failure"),
      "reject_intermediaries",
    );
    const second = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + 60_000 + 2_000),
      async () => decision("detail_transport_failure"),
      "reject_intermediaries",
    );
    expect(first[0]?.action).toBe("keep");
    expect(second[0]?.action).toBe("keep");
    expect(releaseAtOf(db)).toBe(original);
    expect(attemptCountOf(db)).toBe(3);
  });

  it("releases a parser or transport failure at the deadline under reject_intermediaries", async () => {
    for (const outcome of ["detail_parser_failure", "detail_transport_failure"] as const) {
      const db = memoryDb();
      const item = listing();
      upsertSellerHold(db, item, SOURCE_ID, now, "olx");
      const actions = await resolveDueSellerHolds(
        db,
        new Date(now.getTime() + SELLER_HOLD_MAX_MS),
        async () => decision(outcome),
        "reject_intermediaries",
      );
      expect(actions, outcome).toEqual([{ listing: item, action: "send" }]);
      expect(hasSellerHold(db, "olx", SOURCE_ID), outcome).toBe(false);
    }
  });

  it("drops an unresolved failure at the deadline under owner_only", async () => {
    const db = memoryDb();
    const item = listing();
    upsertSellerHold(db, item, SOURCE_ID, now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + SELLER_HOLD_MAX_MS),
      async () => decision("detail_parser_failure"),
      "owner_only",
    );
    expect(actions).toEqual([{ listing: item, action: "drop" }]);
    expect(hasSellerHold(db, "olx", SOURCE_ID)).toBe(false);
  });

  it("drops a confirmed intermediary immediately", async () => {
    const db = memoryDb();
    const item = listing();
    upsertSellerHold(db, item, SOURCE_ID, now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + 60_000),
      async () => decision("detail_confirmed_agent", true),
      "reject_intermediaries",
    );
    expect(actions).toEqual([{ listing: item, action: "drop" }]);
    expect(hasSellerHold(db, "olx", SOURCE_ID)).toBe(false);
  });

  it("sends evaluated unknown immediately under reject_intermediaries", async () => {
    for (const outcome of ["detail_unknown", "cache_unknown"] as const) {
      const db = memoryDb();
      const item = listing();
      upsertSellerHold(db, item, SOURCE_ID, now, "olx");
      const actions = await resolveDueSellerHolds(
        db,
        new Date(now.getTime() + 60_000),
        async () => decision(outcome),
        "reject_intermediaries",
      );
      expect(actions, outcome).toEqual([{ listing: item, action: "send" }]);
      expect(hasSellerHold(db, "olx", SOURCE_ID), outcome).toBe(false);
    }
  });

  it("keeps the original release_at after the database is reopened", () => {
    const dir = mkdtempSync(join(tmpdir(), "rent-radar-hold-deadline-"));
    const path = join(dir, "hold.sqlite");
    const db = getDb(path);
    applyMigrations(db);
    upsertSellerHold(db, listing(), SOURCE_ID, now, "olx");
    const original = releaseAtOf(db);
    keepSellerHold(db, "olx", SOURCE_ID, new Date(now.getTime() + 5 * 60_000));
    closeDb();
    const reopened = getDb(path);
    expect(releaseAtOf(reopened)).toBe(original);
    expect(original).toBe(new Date(now.getTime() + SELLER_HOLD_MAX_MS).toISOString());
    closeDb();
  });
});

describe("pipeline releases a temporary OLX failure once the deadline passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-hold-pipe-"));

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
      ENABLE_LUN: "false",
      ENABLE_DOMRIA: "false",
      ENABLE_RIELTOR: "false",
      SELLER_POLICY: "reject_intermediaries",
      FRESHNESS_MAX_PUBLICATION_AGE_MINUTES: "10080",
      GEO_UNKNOWN_POLICY: "include",
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

  function sink(sent: Listing[]): TelegramTestSink {
    return {
      chatId: "1",
      dryRun: false,
      sendListing: async (item: Listing) => {
        sent.push(item);
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

  it("holds a parser failure, then delivers the fresh listing once after the deadline", async () => {
    const path = join(dir, "pipe.sqlite");
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    const item = listing();
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(published.getTime() - 60_000),
        firstRunMode: "seed",
      },
      1,
    );
    batch.push(item);
    const blocked = async () => ({ acquired: false as const });

    const firstSent: Listing[] = [];
    const first = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(firstSent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: blocked,
      },
      2,
    );
    expect(first.sentOk).toBe(0);
    expect(firstSent).toHaveLength(0);
    expect(hasSellerHold(getDb(path), "olx", SOURCE_ID)).toBe(true);

    const beforeDeadline = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + 60_000),
        probeOlxProfile: blocked,
      },
      3,
    );
    expect(beforeDeadline.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "olx", SOURCE_ID)).toBe(true);
    expect(store.hasSeen(item)).toBe(false);

    const releasedSent: Listing[] = [];
    const released = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(releasedSent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + SELLER_HOLD_MAX_MS),
        probeOlxProfile: blocked,
      },
      4,
    );
    expect(released.sentOk).toBe(1);
    expect(hasSellerHold(getDb(path), "olx", SOURCE_ID)).toBe(false);
    expect(store.hasSeen(item)).toBe(true);
    expect(releasedSent[0]?.metadata?.ownerEvidenceLevel).toBe("private_unknown");
    const html = formatListingTelegramHtml(releasedSent[0]!);
    expect(html).toContain(OWNER_SEARCH_TAG_UNVERIFIED);
    expect(html).not.toContain(OWNER_SEARCH_TAG_CONFIRMED);

    const again = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + SELLER_HOLD_MAX_MS + 60_000),
        probeOlxProfile: blocked,
      },
      5,
    );
    expect(again.sentOk).toBe(0);
    const outbox = getDb(path)
      .prepare("SELECT COUNT(*) AS n FROM telegram_outbox WHERE source = 'olx' AND source_id = ?")
      .get(SOURCE_ID) as { n: number };
    expect(Number(outbox.n)).toBe(1);
  });
});
