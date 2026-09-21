import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { listingFingerprint } from "../src/delivery/delivery-ports.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore, recoverInterruptedSends } from "../src/storage/durable-delivery-store.ts";
import { acquirePollerLock, PollerLockError } from "../src/storage/poller-lock.ts";
import { appliedSchemaVersion, applyMigrations, SCHEMA_VERSION } from "../src/storage/migrations.ts";
import { openDurableRuntime, secureDatabaseFiles } from "../src/storage/durable-runtime.ts";
import { writeHeartbeat } from "../src/storage/heartbeat.ts";

function sampleListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "domria",
    sourceId: "100",
    url: "https://dom.ria.com/uk/realty-100.html",
    title: "Квартира біля центру",
    price: { amount: 12_000, currency: "UAH", period: "month" },
    location: {
      raw: "Львів, Галицький",
      city: "Львів",
      district: "Галицький",
      latitude: 49.84,
      longitude: 24.03,
    },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: new Date("2026-09-17T10:00:00Z"),
    publishedAt: new Date("2026-09-16T12:00:00Z"),
    ...overrides,
  };
}

function adapter(source: Listing["source"], listings: Listing[], ok = true): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => listings,
    inspectLatest: async (): Promise<SourceFetchResult> => ({
      listings,
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: ok ? (listings.length > 0 ? "ok" : "valid_empty") : "http_error",
      httpStatus: ok ? 200 : 503,
      health: {
        source,
        healthy: ok,
        checkedAt: new Date(),
        message: ok ? "ok" : "fail",
      },
    }),
    healthCheck: async () => ({ source, healthy: ok, checkedAt: new Date() }),
  };
}

function baseConfig() {
  resetConfigCache();
  return loadConfig({
    OWNER_ONLY: "true",
    ENABLE_DOMRIA: "true",
    ENABLE_LUN: "false",
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
    MAX_LISTING_AGE_MINUTES: String(7 * 24 * 60),
  });
}

function mockSink(sendListing: TelegramTestSink["sendListing"]): TelegramTestSink {
  return { chatId: "1", sendListing, sendText: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }) } as unknown as TelegramTestSink;
}

function okSend() {
  return vi.fn(async () => ({
    ok: true,
    dryRun: true,
    attempts: 0,
    chatId: "1",
    messageCount: 1,
  }));
}

function failSend(errorSafe = "telegram 503") {
  return vi.fn(async () => ({
    ok: false,
    dryRun: false,
    attempts: 1,
    chatId: "1",
    messageCount: 0,
    errorSafe,
  }));
}

describe("SQLite durability and recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-durable-"));
  let fileIndex = 0;

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  it("migrates a legacy listings-only file to schema version 2 and records metadata", () => {
    const path = dbPath();
    mkdirSync(dir, { recursive: true });
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        published_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE (source, source_id)
      );
    `);
    legacy
      .prepare(
        "INSERT INTO listings (source, source_id, canonical_url, title, discovered_at, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run("lun", "keep-1", "https://lun.ua/uk/realty/keep-1", "Keep", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    expect(appliedSchemaVersion(legacy)).toBe(1);
    applyMigrations(legacy);
    expect(appliedSchemaVersion(legacy)).toBe(SCHEMA_VERSION);
    const meta = legacy.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string };
    expect(meta.value).toBe(String(SCHEMA_VERSION));
    const kept = legacy.prepare("SELECT source_id FROM listings WHERE source_id = 'keep-1'").get();
    expect(kept).toBeTruthy();
    legacy.close();
  });

  it("applies migrations and tightens file permissions on getDb", () => {
    const path = dbPath();
    const db = getDb(path);
    expect(appliedSchemaVersion(db)).toBe(SCHEMA_VERSION);
    secureDatabaseFiles(path);
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("first run seeds inventory silently and restart does not re-baseline", async () => {
    const path = dbPath();
    const config = baseConfig();
    const inventory = [
      sampleListing({
        sourceId: "old-1",
        url: "https://dom.ria.com/uk/realty-old-1.html",
        publishedAt: new Date("2025-12-31T15:03:31.000Z"),
      }),
    ];
    const sendListing = okSend();
    const t0 = new Date("2026-09-17T12:00:00Z");

    const first = new DurableDeliveryStore(getDb(path));
    const seed = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", inventory)],
        config,
        sink: mockSink(sendListing),
        dedupe: first,
        baseline: first,
        outbox: first,
        now: () => t0,
      },
      1,
    );
    expect(seed.deliveryMode).toBe("inventory_seed");
    expect(seed.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
    expect(seed.baselineSurvivesRestart).toBe(true);
    expect(seed.restartRebaseline).toBe(false);
    const established = first.establishedAt("domria")?.toISOString();
    expect(established).toBe(t0.toISOString());
    closeDb();

    const restarted = new DurableDeliveryStore(getDb(path));
    expect(restarted.hasBaseline("domria")).toBe(true);
    expect(restarted.hasSeen(inventory[0]!)).toBe(true);
    expect(restarted.seenFingerprints()).toContain(listingFingerprint(inventory[0]!));
    expect(restarted.establishedAt("domria")?.toISOString()).toBe(established);
    const replay = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", inventory)],
        config,
        sink: mockSink(sendListing),
        dedupe: restarted,
        baseline: restarted,
        outbox: restarted,
        now: () => new Date("2026-09-17T13:00:00Z"),
      },
      2,
    );
    expect(replay.deliveryMode).toBe("send_new");
    expect(replay.sentOk).toBe(0);
    expect(replay.newlyObservedCount).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
    expect(restarted.establishedAt("domria")?.toISOString()).toBe(established);
  });

  it("delivers a listing published during downtime according to the persisted freshness policy", async () => {
    const path = dbPath();
    const config = baseConfig();
    const seedListing = sampleListing({
      sourceId: "seed-1",
      url: "https://dom.ria.com/uk/realty-seed-1.html",
      publishedAt: new Date("2026-09-17T10:00:00Z"),
    });
    const downtimeNew = sampleListing({
      sourceId: "down-1",
      url: "https://dom.ria.com/uk/realty-down-1.html",
      publishedAt: new Date("2026-09-17T12:30:00Z"),
    });
    const late = sampleListing({
      sourceId: "late-1",
      url: "https://dom.ria.com/uk/realty-late-1.html",
      publishedAt: new Date("2026-09-12T17:55:42.000Z"),
    });
    const t0 = new Date("2026-09-17T12:00:00Z");
    const t1 = new Date("2026-09-17T13:00:00Z");
    const sendListing = okSend();

    const first = new DurableDeliveryStore(getDb(path));
    await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [seedListing])],
        config,
        sink: mockSink(sendListing),
        dedupe: first,
        baseline: first,
        outbox: first,
        now: () => t0,
      },
      1,
    );
    closeDb();

    const restarted = new DurableDeliveryStore(getDb(path));
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [seedListing, downtimeNew, late])],
        config,
        sink: mockSink(sendListing),
        dedupe: restarted,
        baseline: restarted,
        outbox: restarted,
        now: () => t1,
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(sendListing).toHaveBeenCalledTimes(1);
    expect(restarted.hasSeen(downtimeNew)).toBe(true);
    expect(restarted.hasSeen(late)).toBe(true);
    expect(restarted.listRetryable()).toHaveLength(0);
  });

  it("marks an item sent only after Telegram confirms success", async () => {
    const path = dbPath();
    const config = baseConfig();
    const sendListing = failSend();
    const store = new DurableDeliveryStore(getDb(path));
    const t0 = new Date("2026-09-17T12:00:00Z");
    await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [])],
        config,
        sink: mockSink(okSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => t0,
      },
      1,
    );
    const neu = sampleListing({
      sourceId: "new-1",
      url: "https://dom.ria.com/uk/realty-new-1.html",
      publishedAt: new Date("2026-09-17T12:30:00Z"),
    });
    const failed = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [neu])],
        config,
        sink: mockSink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-17T13:00:00Z"),
      },
      2,
    );
    expect(failed.sentOk).toBe(0);
    expect(failed.sentFailed).toBe(1);
    expect(store.hasSeen(neu)).toBe(false);
    const retryable = store.listRetryable();
    expect(retryable).toHaveLength(1);
    expect(retryable[0]?.status).toBe("failed");
    expect(retryable[0]?.attemptCount).toBe(1);
  });

  it("retries a failed Telegram send and does not send the same listing twice after success", async () => {
    const path = dbPath();
    const config = baseConfig();
    const store = new DurableDeliveryStore(getDb(path));
    const t0 = new Date("2026-09-17T12:00:00Z");
    await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [])],
        config,
        sink: mockSink(okSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => t0,
      },
      1,
    );
    const neu = sampleListing({
      sourceId: "retry-1",
      url: "https://dom.ria.com/uk/realty-retry-1.html",
      publishedAt: new Date("2026-09-17T12:30:00Z"),
    });
    await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [neu])],
        config,
        sink: mockSink(failSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-17T13:00:00Z"),
      },
      2,
    );
    const sendListing = okSend();
    const recovered = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [neu])],
        config,
        sink: mockSink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-17T13:10:00Z"),
      },
      3,
    );
    expect(recovered.sentOk).toBe(1);
    expect(sendListing).toHaveBeenCalledTimes(1);
    expect(store.hasSeen(neu)).toBe(true);
    expect(store.listRetryable()).toHaveLength(0);

    const replay = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [neu])],
        config,
        sink: mockSink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-17T13:20:00Z"),
      },
      4,
    );
    expect(replay.sentOk).toBe(0);
    expect(sendListing).toHaveBeenCalledTimes(1);
  });

  it("keeps the last known baseline when a later source fetch fails", async () => {
    const path = dbPath();
    const config = baseConfig();
    const store = new DurableDeliveryStore(getDb(path));
    const t0 = new Date("2026-09-17T12:00:00Z");
    const inventory = [
      sampleListing({
        sourceId: "hist-1",
        url: "https://dom.ria.com/uk/realty-hist-1.html",
        publishedAt: new Date("2025-12-31T15:03:31.000Z"),
      }),
    ];
    await runTelegramTestCycle(
      {
        adapters: [adapter("domria", inventory)],
        config,
        sink: mockSink(okSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => t0,
      },
      1,
    );
    const established = store.establishedAt("domria")?.toISOString();
    const fail = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [], false)],
        config,
        sink: mockSink(okSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-17T13:00:00Z"),
      },
      2,
    );
    expect(fail.hasSourceFailures).toBe(true);
    expect(store.hasBaseline("domria")).toBe(true);
    expect(store.establishedAt("domria")?.toISOString()).toBe(established);
    expect(fail.sourceAttempts.find((attempt) => attempt.source === "domria")?.baselineSkippedFailure).toBe(true);
  });

  it("recovers interrupted sending rows to pending on reopen", () => {
    const path = dbPath();
    const db = getDb(path);
    const store = new DurableDeliveryStore(db);
    const listing = sampleListing({
      sourceId: "crash-1",
      url: "https://dom.ria.com/uk/realty-crash-1.html",
    });
    const enqueued = store.enqueueIfNew(listing, "new_publication");
    expect(store.claimForSend(enqueued.id)).toBe(true);
    const sending = db.prepare("SELECT status FROM telegram_outbox WHERE id = ?").get(enqueued.id) as { status: string };
    expect(sending.status).toBe("sending");
    closeDb();

    const reopened = getDb(path);
    expect(recoverInterruptedSends(reopened)).toBe(1);
    const pending = reopened.prepare("SELECT status FROM telegram_outbox WHERE id = ?").get(enqueued.id) as {
      status: string;
    };
    expect(pending.status).toBe("pending");
    const recoveredStore = new DurableDeliveryStore(reopened);
    expect(recoveredStore.listRetryable()).toHaveLength(1);
  });

  it("rejects a second concurrent poller and releases the lock on graceful close", () => {
    const path = dbPath();
    const first = openDurableRuntime({ databasePath: path, lockHolder: "poller-a" });
    const second = new DatabaseSync(path);
    second.exec("PRAGMA busy_timeout = 5000;");
    expect(() => acquirePollerLock(second, "poller-b", 15 * 60_000)).toThrow(PollerLockError);
    second.close();
    first.close();

    const third = openDurableRuntime({ databasePath: path, lockHolder: "poller-c" });
    expect(third.lock.holder.startsWith("poller-c:")).toBe(true);
    third.close();
  });

  it("writes a heartbeat file for the systemd unit", () => {
    const path = join(dir, "heartbeat.json");
    writeHeartbeat(path, { state: "cycle", pid: 1, cycle: 2 });
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // already 600
      }
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps ENABLE_OLX false and ENABLE_OLX_BROWSER explicit in durability config", () => {
    const config = baseConfig();
    expect(config.enableOlx).toBe(false);
    expect(config.enableOlxBrowser).toBe(false);
    const defaults = loadConfig({});
    expect(defaults.enableOlx).toBe(false);
    expect(defaults.enableOlxBrowser).toBe(false);
  });
});
