import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCollectionAdapters } from "../src/collection/create-source-adapters.ts";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb, isProtectedInventoryDatabase, resetDbForTests } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { appliedSchemaVersion, applyMigrations, SCHEMA_VERSION, sqliteMigrationSql } from "../src/storage/migrations.ts";
import {
  normalizeSourceHealthStatus,
  readSourceHealth,
  writeSourceHealth,
} from "../src/storage/source-health.ts";
import {
  runStateCleanupIfDue,
  STATE_CLEANUP_META_KEY,
  STATE_RETENTION,
} from "../src/storage/state-retention.ts";

const DAY = 24 * 60 * 60 * 1000;

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
    discoveredAt: new Date("2026-09-20T10:00:00.000Z"),
    publishedAt: new Date("2026-09-20T09:00:00.000Z"),
    ...overrides,
  };
}

function adapter(
  source: Listing["source"],
  listings: Listing[],
  options: {
    resultKind?: SourceFetchResult["resultKind"];
    httpStatus?: number;
    message?: string;
    throwMessage?: string;
  } = {},
): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => listings,
    inspectLatest: async () => {
      if (options.throwMessage) {
        throw new Error(options.throwMessage);
      }
      const resultKind = options.resultKind ?? (listings.length > 0 ? "ok" : "valid_empty");
      return {
        listings,
        transport: "test",
        dataKind: "MOCK DATA",
        resultKind,
        ...(options.httpStatus !== undefined ? { httpStatus: options.httpStatus } : {}),
        health: {
          source,
          healthy: resultKind === "ok" || resultKind === "valid_empty",
          checkedAt: new Date("2026-09-22T00:00:00.000Z"),
          ...(options.message ? { message: options.message } : {}),
          ...(options.httpStatus !== undefined ? { httpStatus: options.httpStatus } : {}),
        },
      };
    },
    healthCheck: async () => ({ source, healthy: true, checkedAt: new Date("2026-09-22T00:00:00.000Z") }),
  };
}

function testConfig(overrides: Record<string, string> = {}) {
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
    SELLER_POLICY: "reject_intermediaries",
    ...overrides,
  });
}

function sink(sendListing: TelegramTestSink["sendListing"]): TelegramTestSink {
  return {
    chatId: "1",
    dryRun: true,
    sendListing,
    sendText: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }),
  } as unknown as TelegramTestSink;
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

function count(db: DatabaseSync, sql: string, ...args: string[]): number {
  const row = db.prepare(sql).get(...args) as { n: number };
  return Number(row.n);
}

function isoDaysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY).toISOString();
}

function insertSeen(db: DatabaseSync, id: string, lastSeen: string): void {
  const url = `https://dom.ria.com/uk/realty-${id}.html`;
  db.prepare(
    `INSERT INTO seen_listings (
       source, source_id, fingerprint, canonical_url, first_seen_at, last_seen_at
     ) VALUES ('domria', ?, ?, ?, ?, ?)`,
  ).run(id, `fp-${id}`, url, lastSeen, lastSeen);
}

function insertOutbox(
  db: DatabaseSync,
  id: string,
  status: string,
  createdAt: string,
  sentAt: string | null,
): void {
  db.prepare(
    `INSERT INTO telegram_outbox (
       source, source_id, fingerprint, listing_json, delivery_kind, status, attempt_count, created_at, sent_at
     ) VALUES ('domria', ?, ?, '{}', 'new_publication', ?, 1, ?, ?)`,
  ).run(id, `fp-out-${id}`, status, createdAt, sentAt);
}

function insertIdentity(db: DatabaseSync, id: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO cross_source_identities (
       identity_key, key_class, source, source_id, created_at
     ) VALUES (?, 'own', 'domria', ?, ?)`,
  ).run(`key-${id}`, id, createdAt);
}

describe("persistent source health and retention", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-state-"));
  let fileIndex = 0;

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  it("migrates schema 4 to schema 7 without dropping rows, and a second migrate is a no-op", () => {
    expect(SCHEMA_VERSION).toBe(7);
    const path = dbPath();
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (let version = 1; version <= 4; version += 1) {
      db.exec("BEGIN IMMEDIATE;");
      db.exec(sqliteMigrationSql(version));
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-09-01T00:00:00.000Z",
      );
      db.exec("COMMIT;");
    }
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '4')").run();
    db.prepare(
      `INSERT INTO listings (
         source, source_id, canonical_url, title, discovered_at, first_seen_at, last_seen_at
       ) VALUES ('lun', 'keep-1', 'https://lun.ua/uk/realty/keep-1', 'Keep', ?, ?, ?)`,
    ).run("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO source_baselines (source, established_at, last_success_at, seed_listing_count)
       VALUES ('lun', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('seller_policy', 'reject_intermediaries')`,
    ).run();
    expect(appliedSchemaVersion(db)).toBe(4);

    expect(applyMigrations(db)).toBe(7);
    expect(appliedSchemaVersion(db)).toBe(7);
    const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe("7");
    expect(count(db, "SELECT COUNT(*) AS n FROM listings WHERE source_id = 'keep-1'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM source_baselines WHERE source = 'lun'")).toBe(1);
    expect(
      count(db, "SELECT COUNT(*) AS n FROM schema_meta WHERE key = 'seller_policy'"),
    ).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_health'").get(),
    ).toBeTruthy();
    for (const indexName of [
      "seen_listings_last_seen_idx",
      "telegram_outbox_status_sent_idx",
      "telegram_outbox_source_idx",
      "cross_source_identities_created_idx",
      "cross_source_identities_listing_idx",
    ]) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName),
      ).toBeTruthy();
    }

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_seller_verifications'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_admin_alerts'").get(),
    ).toBeTruthy();
    expect(applyMigrations(db)).toBe(7);
    expect(count(db, "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 5")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 7")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM listings WHERE source_id = 'keep-1'")).toBe(1);
    db.close();
  });

  it("resolves DATABASE_PATH and refuses to reset the default inventory file", () => {
    expect(loadConfig({}).databasePath).toBe("./data/rent-radar.sqlite");
    expect(loadConfig({ DATABASE_PATH: "C:/tmp/rent-radar-custom.sqlite" }).databasePath).toBe(
      "C:/tmp/rent-radar-custom.sqlite",
    );
    expect(isProtectedInventoryDatabase("./data/rent-radar.sqlite")).toBe(true);
    expect(isProtectedInventoryDatabase("data/rent-radar.sqlite")).toBe(true);
    expect(isProtectedInventoryDatabase(dbPath())).toBe(false);
    const before = existsSync(join(process.cwd(), "data", "rent-radar.sqlite"));
    expect(() => resetDbForTests("./data/rent-radar.sqlite")).toThrow(/Refusing to reset/);
    expect(existsSync(join(process.cwd(), "data", "rent-radar.sqlite"))).toBe(before);
  });

  it("normalizes failures without turning them into an empty success", () => {
    expect(
      normalizeSourceHealthStatus({
        source: "lun",
        resultKind: "parser_failure",
        httpStatus: 200,
        listingCount: 1,
        ok: true,
      }),
    ).toBe("parser_failure");
    expect(
      normalizeSourceHealthStatus({
        source: "lun",
        resultKind: "ok",
        httpStatus: 200,
        listingCount: 0,
      }),
    ).toBe("parser_failure");
    expect(
      normalizeSourceHealthStatus({
        source: "lun",
        httpStatus: 200,
        listingCount: 0,
        ok: true,
      }),
    ).toBe("transport_failure");
    expect(
      normalizeSourceHealthStatus({
        source: "rieltor",
        resultKind: "rate_limited",
        httpStatus: 429,
      }),
    ).toBe("rate_limited");
    expect(
      normalizeSourceHealthStatus({
        source: "rieltor",
        resultKind: "transport_blocked",
        httpStatus: 429,
      }),
    ).toBe("rate_limited");
    expect(
      normalizeSourceHealthStatus({
        source: "rieltor",
        resultKind: "transport_blocked",
        httpStatus: 403,
      }),
    ).toBe("transport_failure");
    expect(
      normalizeSourceHealthStatus({
        source: "domria",
        resultKind: "http_error",
        httpStatus: 503,
      }),
    ).toBe("http_error");
    expect(
      normalizeSourceHealthStatus({
        source: "olx",
        resultKind: "parser_failed",
        transport: "stock_playwright_chromium",
      }),
    ).toBe("browser_failure");
    expect(
      normalizeSourceHealthStatus({
        source: "domria",
        resultKind: "parser_failed",
        errorSafe: "socket hang up",
      }),
    ).toBe("transport_failure");
  });

  it("keeps source health across reopen and does not let one source overwrite another", () => {
    const path = dbPath();
    const db = getDb(path);
    const t0 = new Date("2026-09-01T00:00:00.000Z");
    const t1 = new Date("2026-09-01T01:00:00.000Z");
    const t2 = new Date("2026-09-01T02:00:00.000Z");
    const t3 = new Date("2026-09-01T03:00:00.000Z");
    const t4 = new Date("2026-09-01T04:00:00.000Z");
    const t5 = new Date("2026-09-01T05:00:00.000Z");

    writeSourceHealth(db, { source: "lun", resultKind: "ok", listingCount: 4, httpStatus: 200, ok: true }, t0);
    writeSourceHealth(
      db,
      {
        source: "domria",
        resultKind: "parser_failure",
        listingCount: 0,
        httpStatus: 200,
        ok: false,
        errorSafe: "missing cards",
      },
      t1,
    );
    const secondFailure = writeSourceHealth(
      db,
      {
        source: "domria",
        resultKind: "parser_failure",
        listingCount: 0,
        httpStatus: 200,
        ok: false,
        errorSafe: "missing cards",
      },
      t2,
    );
    expect(secondFailure.consecutiveFailures).toBe(2);
    expect(secondFailure.lastSuccessAt).toBeNull();
    expect(secondFailure.lastFailureAt).toBe(t2.toISOString());
    expect(readSourceHealth(db, "lun")?.status).toBe("ok");
    expect(readSourceHealth(db, "lun")?.consecutiveFailures).toBe(0);

    const recovered = writeSourceHealth(
      db,
      { source: "domria", resultKind: "valid_empty", listingCount: 0, httpStatus: 200, ok: true },
      t3,
    );
    expect(recovered.status).toBe("valid_empty");
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastSuccessAt).toBe(t3.toISOString());
    expect(recovered.lastFailureAt).toBe(t2.toISOString());

    const failedAgain = writeSourceHealth(
      db,
      {
        source: "domria",
        resultKind: "http_error",
        listingCount: 0,
        httpStatus: 503,
        ok: false,
        errorSafe: "HTTP 503",
      },
      t4,
    );
    expect(failedAgain.status).toBe("http_error");
    expect(failedAgain.consecutiveFailures).toBe(1);
    expect(failedAgain.lastSuccessAt).toBe(t3.toISOString());
    expect(failedAgain.lastFailureAt).toBe(t4.toISOString());

    const disabled = writeSourceHealth(
      db,
      { source: "domria", resultKind: "disabled", listingCount: 0, ok: false },
      t5,
    );
    expect(disabled.status).toBe("disabled");
    expect(disabled.consecutiveFailures).toBe(1);
    expect(disabled.lastSuccessAt).toBe(t3.toISOString());
    expect(disabled.lastFailureAt).toBe(t4.toISOString());

    const unsafe = writeSourceHealth(
      db,
      {
        source: "rieltor",
        resultKind: "parser_failure",
        listingCount: 0,
        httpStatus: 200,
        ok: false,
        errorSafe:
          "<html><body>bot123456789:abcdefghijklmnop api.telegram.org/bot999:secret</body></html>",
      },
      t1,
    );
    expect(unsafe.status).toBe("parser_failure");
    expect(unsafe.lastErrorSafe).toBe("parser_failure");
    expect(unsafe.lastErrorSafe ?? "").not.toMatch(/<html/i);
    expect(unsafe.lastErrorSafe ?? "").not.toMatch(/abcdefghijklmnop/);

    const leaked = writeSourceHealth(
      db,
      {
        source: "olx",
        resultKind: "http_error",
        httpStatus: 403,
        listingCount: 0,
        ok: false,
        errorSafe: "blocked bot123456789:abcdefghijklmnop",
      },
      t1,
    );
    expect(leaked.lastErrorSafe).toContain("[redacted-bot-token]");
    expect(leaked.lastErrorSafe ?? "").not.toContain("abcdefghijklmnop");

    closeDb();
    const reopened = getDb(path);
    const domria = readSourceHealth(reopened, "domria");
    const lun = readSourceHealth(reopened, "lun");
    expect(domria?.status).toBe("disabled");
    expect(domria?.consecutiveFailures).toBe(1);
    expect(domria?.lastSuccessAt).toBe(t3.toISOString());
    expect(domria?.lastFailureAt).toBe(t4.toISOString());
    expect(lun?.status).toBe("ok");
    expect(lun?.lastSuccessAt).toBe(t0.toISOString());
    expect(lun?.consecutiveFailures).toBe(0);
  });

  it("records ok, valid_empty, and parser_failure from the poll cycle", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const at = new Date("2026-09-22T12:00:00.000Z");
    const sendListing = okSend();
    await runTelegramTestCycle(
      {
        adapters: [
          adapter("domria", [sampleListing()], { resultKind: "ok", httpStatus: 200 }),
          adapter("lun", [], { resultKind: "valid_empty", httpStatus: 200 }),
          adapter("rieltor", [sampleListing({ source: "rieltor", sourceId: "p1", url: "https://rieltor.ua/lvov/flats-rent/view/1/" })], {
            resultKind: "parser_failure",
            httpStatus: 200,
            message: "catalog marker missing",
          }),
        ],
        config: testConfig({ ENABLE_LUN: "true", ENABLE_RIELTOR: "true" }),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => at,
      },
      1,
    );
    const ok = readSourceHealth(getDb(), "domria");
    const empty = readSourceHealth(getDb(), "lun");
    const parser = readSourceHealth(getDb(), "rieltor");
    expect(ok?.status).toBe("ok");
    expect(ok?.lastListingCount).toBe(1);
    expect(ok?.consecutiveFailures).toBe(0);
    expect(ok?.lastSuccessAt).toBe(at.toISOString());
    expect(empty?.status).toBe("valid_empty");
    expect(empty?.consecutiveFailures).toBe(0);
    expect(empty?.lastSuccessAt).toBe(at.toISOString());
    expect(parser?.status).toBe("parser_failure");
    expect(parser?.status).not.toBe("valid_empty");
    expect(parser?.lastHttpStatus).toBe(200);
    expect(parser?.consecutiveFailures).toBe(1);
    expect(parser?.lastSuccessAt).toBeNull();
    expect(store.hasBaseline("rieltor")).toBe(false);
    expect(store.hasBaseline("domria")).toBe(true);
  });

  it("keeps 429, HTTP errors, and blocked transport distinct", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const report = await runTelegramTestCycle(
      {
        adapters: [
          adapter("domria", [], { resultKind: "http_error", httpStatus: 503, message: "HTTP 503" }),
          adapter("rieltor", [], { resultKind: "rate_limited", httpStatus: 429, message: "HTTP 429" }),
          adapter("lun", [], { resultKind: "http_error", httpStatus: 403, message: "HTTP 403" }),
        ],
        config: testConfig({ ENABLE_LUN: "true", ENABLE_RIELTOR: "true" }),
        sink: sink(okSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T12:00:00.000Z"),
      },
      1,
    );
    expect(report.sourceAttempts.find((item) => item.source === "rieltor")?.resultKind).toBe(
      "rate_limited",
    );
    expect(report.sourceAttempts.find((item) => item.source === "lun")?.resultKind).toBe(
      "transport_blocked",
    );
    expect(readSourceHealth(getDb(), "domria")?.status).toBe("http_error");
    expect(readSourceHealth(getDb(), "rieltor")?.status).toBe("rate_limited");
    expect(readSourceHealth(getDb(), "lun")?.status).toBe("transport_failure");
    expect(readSourceHealth(getDb(), "domria")?.lastHttpStatus).toBe(503);
    expect(readSourceHealth(getDb(), "rieltor")?.lastHttpStatus).toBe(429);
  });

  it("stores a disabled source and a thrown OLX browser failure without marking them empty", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    await runTelegramTestCycle(
      {
        adapters: [
          adapter("olx", []),
          adapter("domria", [], { throwMessage: "socket hang up" }),
        ],
        config: testConfig(),
        sink: sink(okSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T12:00:00.000Z"),
      },
      1,
    );
    expect(readSourceHealth(getDb(), "olx")?.status).toBe("disabled");
    expect(readSourceHealth(getDb(), "olx")?.consecutiveFailures).toBe(0);
    expect(readSourceHealth(getDb(), "domria")?.status).toBe("transport_failure");
    expect(readSourceHealth(getDb(), "domria")?.status).not.toBe("parser_failure");
    expect(readSourceHealth(getDb(), "domria")?.lastErrorSafe).toContain("socket hang up");

    closeDb();
    const browserDb = getDb(dbPath());
    const browserStore = new DurableDeliveryStore(browserDb);
    await runTelegramTestCycle(
      {
        adapters: [adapter("olx", [], { throwMessage: "playwright crashed" })],
        config: testConfig({ ENABLE_OLX_BROWSER: "true", ENABLE_DOMRIA: "false" }),
        sink: sink(okSend()),
        dedupe: browserStore,
        baseline: browserStore,
        outbox: browserStore,
        now: () => new Date("2026-09-22T13:00:00.000Z"),
      },
      1,
    );
    const browser = readSourceHealth(browserDb, "olx");
    expect(browser?.status).toBe("browser_failure");
    expect(browser?.lastErrorSafe).toContain("playwright crashed");
    expect(browser?.consecutiveFailures).toBe(1);
    expect(browser?.lastSuccessAt).toBeNull();
  });

  it("replaces a previous ok row with disabled when production omits the adapter", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lunListing = sampleListing({
      source: "lun",
      sourceId: "lun-1",
      url: "https://lun.ua/uk/realty/lun-1",
    });
    const inspectLatest = vi.fn(async (): Promise<SourceFetchResult> => ({
      listings: [lunListing],
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: "ok",
      httpStatus: 200,
      health: {
        source: "lun",
        healthy: true,
        checkedAt: new Date("2026-09-22T12:00:00.000Z"),
        resultKind: "ok",
        httpStatus: 200,
      },
    }));
    const lunAdapter: ListingSourceAdapter = {
      source: "lun",
      fetchLatest: async () => [lunListing],
      inspectLatest,
      healthCheck: async () => ({
        source: "lun",
        healthy: true,
        checkedAt: new Date("2026-09-22T12:00:00.000Z"),
      }),
    };
    const enabledConfig = testConfig({
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "true",
      ENABLE_RIELTOR: "false",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: "false",
    });
    const enabledAdapters = createCollectionAdapters(enabledConfig, { lun: lunAdapter });
    expect(enabledAdapters.map((item) => item.source)).toEqual(["lun"]);
    const checkedAt = new Date("2026-09-22T12:00:00.000Z");
    await runTelegramTestCycle(
      {
        adapters: enabledAdapters,
        config: enabledConfig,
        sink: sink(okSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => checkedAt,
      },
      1,
    );
    expect(inspectLatest).toHaveBeenCalledTimes(1);
    expect(readSourceHealth(getDb(), "lun")?.status).toBe("ok");

    const disabledConfig = testConfig({
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "false",
      ENABLE_RIELTOR: "false",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: "false",
    });
    const disabledAdapters = createCollectionAdapters(disabledConfig, { lun: lunAdapter });
    expect(disabledAdapters).toEqual([]);
    const disabledAt = new Date("2026-09-22T13:00:00.000Z");
    await runTelegramTestCycle(
      {
        adapters: disabledAdapters,
        config: disabledConfig,
        sink: sink(okSend()),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => disabledAt,
      },
      2,
    );
    expect(inspectLatest).toHaveBeenCalledTimes(1);
    const lun = readSourceHealth(getDb(), "lun");
    expect(lun?.status).toBe("disabled");
    expect(lun?.checkedAt).toBe(disabledAt.toISOString());
    expect(lun?.lastSuccessAt).toBe(checkedAt.toISOString());
    expect(readSourceHealth(getDb(), "domria")?.status).toBe("disabled");
    expect(readSourceHealth(getDb(), "rieltor")?.status).toBe("disabled");
    expect(readSourceHealth(getDb(), "olx")?.status).toBe("disabled");
    expect(count(getDb(), "SELECT COUNT(*) AS n FROM source_health WHERE source = 'olx'")).toBe(1);
    expect(count(getDb(), "SELECT COUNT(*) AS n FROM source_health WHERE source = 'lun'")).toBe(1);
  });

  it("increments the failure streak from the poll and keeps the last success after relapse", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const t1 = new Date("2026-09-10T00:00:00.000Z");
    const t2 = new Date("2026-09-10T01:00:00.000Z");
    const t3 = new Date("2026-09-10T02:00:00.000Z");
    const t4 = new Date("2026-09-10T03:00:00.000Z");
    const deps = {
      adapters: [adapter("domria", [], { resultKind: "http_error" as const, httpStatus: 503, message: "down" })],
      config: testConfig(),
      sink: sink(okSend()),
      dedupe: store,
      baseline: store,
      outbox: store,
    };
    await runTelegramTestCycle({ ...deps, now: () => t1 }, 1);
    await runTelegramTestCycle({ ...deps, now: () => t2 }, 2);
    expect(readSourceHealth(getDb(), "domria")?.consecutiveFailures).toBe(2);
    expect(readSourceHealth(getDb(), "domria")?.lastSuccessAt).toBeNull();
    expect(readSourceHealth(getDb(), "domria")?.lastFailureAt).toBe(t2.toISOString());

    await runTelegramTestCycle(
      {
        ...deps,
        adapters: [adapter("domria", [sampleListing()], { resultKind: "ok", httpStatus: 200 })],
        now: () => t3,
      },
      3,
    );
    expect(readSourceHealth(getDb(), "domria")?.status).toBe("ok");
    expect(readSourceHealth(getDb(), "domria")?.consecutiveFailures).toBe(0);
    expect(readSourceHealth(getDb(), "domria")?.lastSuccessAt).toBe(t3.toISOString());
    expect(readSourceHealth(getDb(), "domria")?.lastFailureAt).toBe(t2.toISOString());

    await runTelegramTestCycle({ ...deps, now: () => t4 }, 4);
    expect(readSourceHealth(getDb(), "domria")?.status).toBe("http_error");
    expect(readSourceHealth(getDb(), "domria")?.consecutiveFailures).toBe(1);
    expect(readSourceHealth(getDb(), "domria")?.lastSuccessAt).toBe(t3.toISOString());
    expect(readSourceHealth(getDb(), "domria")?.lastFailureAt).toBe(t4.toISOString());
  });

  it("prunes aged rows, keeps protected rows, and is idempotent", () => {
    expect(STATE_RETENTION.seenInactiveMs).toBe(30 * DAY);
    expect(STATE_RETENTION.crossSourceIdentityMs).toBe(90 * DAY);
    expect(STATE_RETENTION.sentOutboxMs).toBe(30 * DAY);
    expect(STATE_RETENTION.cleanupIntervalMs).toBe(DAY);

    const path = dbPath();
    const db = getDb(path);
    const now = new Date("2026-09-22T00:00:00.000Z");
    const oldSeen = isoDaysBefore(now, 40);
    const recentSeen = isoDaysBefore(now, 2);
    const oldIdentity = isoDaysBefore(now, 100);
    const youngIdentity = isoDaysBefore(now, 10);

    insertSeen(db, "drop-seen", oldSeen);
    insertSeen(db, "keep-seen", recentSeen);
    insertSeen(db, "keep-pending", oldSeen);
    insertSeen(db, "keep-failed", oldSeen);
    insertSeen(db, "keep-sent", oldSeen);
    insertSeen(db, "drop-sent", oldSeen);
    insertIdentity(db, "drop-id", oldIdentity);
    insertIdentity(db, "keep-id", youngIdentity);
    insertIdentity(db, "keep-pending", oldIdentity);
    insertIdentity(db, "keep-sent", oldIdentity);
    insertIdentity(db, "drop-sent", oldIdentity);
    insertOutbox(db, "keep-pending", "pending", oldIdentity, null);
    insertOutbox(db, "keep-failed", "failed", oldIdentity, null);
    insertOutbox(db, "keep-sending", "sending", oldIdentity, null);
    insertOutbox(db, "keep-sent", "sent", recentSeen, recentSeen);
    insertOutbox(db, "drop-sent", "sent", oldSeen, oldSeen);
    db.prepare(
      `INSERT INTO source_baselines (source, established_at, last_success_at, seed_listing_count)
       VALUES ('domria', '2026-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 3)`,
    ).run();
    db.prepare(
      `INSERT INTO poller_lock (id, holder, acquired_at, heartbeat_at, boot_id, pid, starttime)
       VALUES (1, 'holder', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'boot', 1, '1')`,
    ).run();
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES
         ('seller_policy', 'reject_intermediaries'),
         ('seller_policy_applied_at', '2026-02-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO source_health (
         source, status, checked_at, last_success_at, last_failure_at,
         consecutive_failures, last_listing_count, last_http_status, last_error_safe, updated_at
       ) VALUES ('lun', 'ok', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 0, 4, 200, NULL, '2026-01-01T00:00:00.000Z')`,
    ).run();

    const report = runStateCleanupIfDue(db, { now, databasePath: path, force: true });
    expect(report.ran).toBe(true);
    expect(report.seenRowsRemoved).toBe(2);
    expect(report.crossSourceIdentitiesRemoved).toBe(2);
    expect(report.sentOutboxRowsRemoved).toBe(1);
    expect(report.diagnosticRowsRemoved).toBe(0);
    expect(report.databaseBytes).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);

    expect(count(db, "SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'drop-seen'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'drop-sent'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'keep-seen'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'keep-pending'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'keep-failed'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'keep-sent'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source_id = 'drop-id'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source_id = 'drop-sent'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source_id = 'keep-id'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source_id = 'keep-pending'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source_id = 'keep-sent'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = 'drop-sent'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = 'keep-sent' AND status = 'sent'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = 'keep-pending' AND status = 'pending'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = 'keep-failed' AND status = 'failed'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = 'keep-sending' AND status = 'sending'")).toBe(1);
    const baseline = db
      .prepare("SELECT established_at AS establishedAt, seed_listing_count AS seeds FROM source_baselines")
      .get() as { establishedAt: string; seeds: number };
    expect(baseline.establishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(baseline.seeds).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM poller_lock WHERE holder = 'holder'")).toBe(1);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM schema_meta WHERE key = 'seller_policy_applied_at' AND value = '2026-02-01T00:00:00.000Z'",
      ),
    ).toBe(1);
    const health = readSourceHealth(db, "lun");
    expect(health?.status).toBe("ok");
    expect(health?.checkedAt).toBe("2026-01-01T00:00:00.000Z");

    const again = runStateCleanupIfDue(db, { now, databasePath: path, force: true });
    expect(again.ran).toBe(true);
    expect(again.seenRowsRemoved).toBe(0);
    expect(again.crossSourceIdentitiesRemoved).toBe(0);
    expect(again.sentOutboxRowsRemoved).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'keep-pending'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE status = 'pending'")).toBe(1);
  });

  it("skips cleanup until the stored interval has elapsed", () => {
    const path = dbPath();
    const db = getDb(path);
    const start = new Date("2026-09-22T00:00:00.000Z");
    insertOutbox(db, "old-a", "sent", isoDaysBefore(start, 40), isoDaysBefore(start, 40));
    const first = runStateCleanupIfDue(db, { now: start, databasePath: path });
    expect(first.ran).toBe(true);
    expect(first.sentOutboxRowsRemoved).toBe(1);
    const stored = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(STATE_CLEANUP_META_KEY) as {
      value: string;
    };
    expect(stored.value).toBe(start.toISOString());

    insertOutbox(db, "old-b", "sent", isoDaysBefore(start, 40), isoDaysBefore(start, 40));
    const skipped = runStateCleanupIfDue(db, {
      now: new Date(start.getTime() + STATE_RETENTION.cleanupIntervalMs - 1000),
      databasePath: path,
    });
    expect(skipped.ran).toBe(false);
    expect(skipped.reason).toBe("not_due");
    expect(skipped.sentOutboxRowsRemoved).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = 'old-b'")).toBe(1);

    const due = runStateCleanupIfDue(db, {
      now: new Date(start.getTime() + STATE_RETENTION.cleanupIntervalMs + 1000),
      databasePath: path,
    });
    expect(due.ran).toBe(true);
    expect(due.sentOutboxRowsRemoved).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = 'old-b'")).toBe(0);
    const repeat = runStateCleanupIfDue(db, {
      now: new Date(start.getTime() + STATE_RETENTION.cleanupIntervalMs + 1000),
      databasePath: path,
    });
    expect(repeat.ran).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("refreshes last_seen for a listing that is still in a successful poll", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const listing = sampleListing({
      sourceId: "obs-1",
      url: "https://dom.ria.com/uk/realty-obs-1.html",
      publishedAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    store.establishSilent("domria", [], store, new Date("2026-09-01T00:00:00.000Z"));
    store.markSeen(listing);
    getDb()
      .prepare("UPDATE seen_listings SET last_seen_at = ? WHERE source_id = ?")
      .run("2026-01-01T00:00:00.000Z", "obs-1");
    const sendListing = okSend();
    const observedAt = new Date("2026-09-22T00:00:00.000Z");
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [listing])],
        config: testConfig(),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => observedAt,
      },
      2,
    );
    expect(report.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
    const row = getDb()
      .prepare("SELECT last_seen_at AS lastSeenAt FROM seen_listings WHERE source_id = 'obs-1'")
      .get() as { lastSeenAt: string };
    expect(row.lastSeenAt).toBe(observedAt.toISOString());
  });

  it("does not flood a seeded catalog after cleanup removes inactive seen rows", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const listing = sampleListing({
      sourceId: "old-1",
      url: "https://dom.ria.com/uk/realty-old-1.html",
      publishedAt: new Date("2025-12-31T00:00:00.000Z"),
    });
    const sendListing = okSend();
    const seededAt = new Date("2026-09-17T12:00:00.000Z");
    const seed = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [listing])],
        config: testConfig(),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
      },
      1,
    );
    expect(seed.deliveryMode).toBe("inventory_seed");
    expect(seed.sentOk).toBe(0);
    const established = store.establishedAt("domria")?.toISOString();
    const cleanup = runStateCleanupIfDue(getDb(), {
      now: new Date(Date.now() + 40 * DAY),
      databasePath: path,
      force: true,
    });
    expect(cleanup.seenRowsRemoved).toBeGreaterThan(0);
    expect(store.establishedAt("domria")?.toISOString()).toBe(established);
    const replay = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [listing])],
        config: testConfig(),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(Date.now() + 40 * DAY),
      },
      2,
    );
    expect(replay.deliveryMode).toBe("send_new");
    expect(replay.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
    expect(store.establishedAt("domria")?.toISOString()).toBe(established);
  });

  it("does not resend a recently delivered listing after cleanup", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const published = new Date();
    const listing = sampleListing({
      sourceId: "fresh-1",
      url: "https://dom.ria.com/uk/realty-fresh-1.html",
      publishedAt: published,
    });
    store.establishSilent("domria", [], store, new Date(published.getTime() - 2 * DAY));
    const sendListing = okSend();
    const first = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [listing])],
        config: testConfig(),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => published,
      },
      1,
    );
    expect(first.sentOk).toBe(1);
    expect(sendListing).toHaveBeenCalledTimes(1);
    const cleanupNow = new Date(Date.now() + DAY);
    const cleanup = runStateCleanupIfDue(getDb(), {
      now: cleanupNow,
      databasePath: path,
      force: true,
    });
    expect(cleanup.sentOutboxRowsRemoved).toBe(0);
    sendListing.mockClear();
    const replay = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [listing])],
        config: testConfig(),
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => cleanupNow,
      },
      2,
    );
    expect(replay.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
    expect(
      count(getDb(), "SELECT COUNT(*) AS n FROM telegram_outbox WHERE status = 'sent'"),
    ).toBe(1);
  });

  it("retries a failed Telegram row after cleanup and reopen", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const published = new Date("2026-09-22T12:00:00.000Z");
    const listing = sampleListing({
      sourceId: "retry-1",
      url: "https://dom.ria.com/uk/realty-retry-1.html",
      publishedAt: published,
    });
    store.establishSilent("domria", [], store, new Date("2026-09-01T00:00:00.000Z"));
    const failing = failSend();
    const failed = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [listing])],
        config: testConfig(),
        sink: sink(failing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => published,
      },
      1,
    );
    expect(failed.sentFailed).toBe(1);
    const cleanup = runStateCleanupIfDue(getDb(), {
      now: new Date(Date.now() + 100 * DAY),
      databasePath: path,
      force: true,
    });
    expect(cleanup.sentOutboxRowsRemoved).toBe(0);
    const status = getDb().prepare("SELECT status FROM telegram_outbox").get() as { status: string };
    expect(status.status).toBe("failed");
    closeDb();

    const reopened = new DurableDeliveryStore(getDb(path));
    expect(reopened.listRetryable(50, new Date("2026-09-22T13:00:00.000Z"))).toHaveLength(1);
    expect(reopened.hasBaseline("domria")).toBe(true);
    const sendListing = okSend();
    const recovered = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [listing])],
        config: testConfig(),
        sink: sink(sendListing),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T13:00:00.000Z"),
      },
      2,
    );
    expect(recovered.sentOk).toBe(1);
    expect(sendListing).toHaveBeenCalledTimes(1);
    const sent = getDb().prepare("SELECT status FROM telegram_outbox").get() as { status: string };
    expect(sent.status).toBe("sent");
  });

  it("keeps cross-source suppression for an undelivered keeper after cleanup", () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const lun = sampleListing({
      source: "lun",
      sourceId: "4721",
      url: "https://lun.ua/uk/realty/4721",
      metadata: {
        originalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-kvartiry-ID11gWHG.html?utm_source=lun",
        aggregatedSite: "olx.ua",
        ownerEvidenceLevel: "private_unknown",
      },
    });
    const olx = sampleListing({
      source: "olx",
      sourceId: "934944232",
      url: "https://www.olx.ua/d/obyavlenie/orenda-kvartiry-ID11gWHG.html",
      sellerType: "unknown",
    });
    const queued = store.enqueueIfNew(lun, "new_publication");
    expect(queued.duplicate).toBe(false);
    expect(store.assessCrossSource(olx).suppress).toBe(true);
    getDb()
      .prepare("UPDATE cross_source_identities SET created_at = ? WHERE source = 'lun'")
      .run("2026-01-01T00:00:00.000Z");
    getDb()
      .prepare("UPDATE telegram_outbox SET created_at = ? WHERE source = 'lun'")
      .run("2026-01-01T00:00:00.000Z");
    insertIdentity(getDb(), "stale-other", "2026-01-01T00:00:00.000Z");
    const report = runStateCleanupIfDue(getDb(), {
      now: new Date("2026-09-22T00:00:00.000Z"),
      databasePath: path,
      force: true,
    });
    expect(report.crossSourceIdentitiesRemoved).toBe(1);
    expect(report.sentOutboxRowsRemoved).toBe(0);
    expect(count(getDb(), "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source = 'lun'")).toBeGreaterThan(
      0,
    );
    expect(store.assessCrossSource(olx).suppress).toBe(true);
    expect(store.listRetryable()).toHaveLength(1);
    expect(store.listRetryable()[0]?.status).toBe("pending");
  });
});
