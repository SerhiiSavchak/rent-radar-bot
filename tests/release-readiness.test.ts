import { mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { matchesProductionRuntime, PRODUCTION_RUNTIME_ENV } from "../src/config/production-runtime.ts";
import { createCollectionAdapters } from "../src/collection/create-source-adapters.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter } from "../src/domain/source.ts";
import { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { applyMigrations, SCHEMA_VERSION } from "../src/storage/migrations.ts";
import { resolveReleaseCommit } from "../src/storage/release-commit.ts";
import { backupSqliteDatabase, verifySqliteBackup } from "../src/storage/sqlite-backup.ts";

describe("production runtime", () => {
  afterEach(() => {
    resetConfigCache();
  });

  it("enables DIM.RIA, LUN, and OLX browser, and disables HTTP OLX and RIELTOR", () => {
    const config = loadConfig({ ...PRODUCTION_RUNTIME_ENV });
    expect(matchesProductionRuntime(config)).toBe(true);
    expect(createCollectionAdapters(config).map((adapter) => adapter.source)).toEqual([
      "domria",
      "lun",
      "olx",
    ]);
    const unit = readFileSync("deploy/systemd/rent-radar-telegram.service", "utf8");
    expect(unit).toContain("ExecStart=/usr/bin/env");
    expect(unit).toContain("__NODE_BIN__ --import tsx ./src/scripts/test-telegram-poll.ts");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("KillMode=control-group");
    const poller = readFileSync("src/scripts/test-telegram-poll.ts", "utf8");
    expect(poller).toContain('process.on("SIGTERM"');
    expect(poller).toContain("closeRuntime?.()");
    expect(poller).not.toContain('"unknown"');
  });

  it("refuses the literal unknown commit and accepts a git SHA", () => {
    expect(() => resolveReleaseCommit({ env: { RENT_RADAR_COMMIT: "unknown" }, readGit: () => undefined })).toThrow(
      /unavailable/,
    );
    expect(resolveReleaseCommit({ env: {}, readGit: () => "3f8e91ed452434cd0c71534acfed5814d9013b77" })).toBe(
      "3f8e91ed452434cd0c71534acfed5814d9013b77",
    );
  });
});

describe("schema 11 upgrade and dedup tombstones", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-migrate-11-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  it("keeps seen, sent, and baseline rows from schema 11 and accepts the new seller verdict", () => {
    const path = join(dir, `case-${(fileIndex += 1)}.sqlite`);
    const db = new DatabaseSync(path);
    expect(applyMigrations(db, 11)).toBe(11);
    db.prepare(
      `INSERT INTO seen_listings (
         source, source_id, fingerprint, canonical_url, first_seen_at, last_seen_at
       ) VALUES ('domria', 'kept', 'fp-kept', 'https://dom.ria.com/uk/realty-kept.html', ?, ?)`,
    ).run("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO telegram_outbox (
         source, source_id, fingerprint, listing_json, delivery_kind, status, created_at, sent_at
       ) VALUES ('domria', 'kept', 'fp-kept', '{}', 'new_publication', 'sent', ?, ?)`,
    ).run("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO source_baselines (source, established_at, last_success_at, seed_listing_count)
       VALUES ('domria', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 4)`,
    ).run();
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, checked_at, expires_at
       ) VALUES ('olx', 'ext-1', 'https://www.olx.ua/d/x', 'unknown', ?, ?)`,
    ).run("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");

    expect(applyMigrations(db)).toBe(SCHEMA_VERSION);
    expect(applyMigrations(db)).toBe(SCHEMA_VERSION);
    const seen = db.prepare("SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'kept'").get() as {
      n: number;
    };
    const sent = db.prepare("SELECT status FROM telegram_outbox WHERE source_id = 'kept'").get() as {
      status: string;
    };
    const baseline = db.prepare("SELECT seed_listing_count AS n FROM source_baselines").get() as { n: number };
    expect(Number(seen.n)).toBe(1);
    expect(sent.status).toBe("sent");
    expect(baseline.n).toBe(4);
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, checked_at, expires_at
       ) VALUES ('olx', 'ext-2', 'https://www.olx.ua/d/y', 'seller_inventory_limit', ?, ?)`,
    ).run("2026-09-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z");
    const columns = db.prepare("PRAGMA table_info(seen_listings)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("listing_json");
    expect(columns.map((column) => column.name)).not.toContain("raw_json");

    const backupPath = join(dir, "backup.sqlite");
    db.close();
    backupSqliteDatabase(path, backupPath);
    const checked = verifySqliteBackup(backupPath);
    expect(checked.ok).toBe(true);
    expect(checked.bytes).toBeGreaterThan(0);
    expect(checked.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("does not resend a listing that production already saw before the release", async () => {
    const path = join(dir, `case-${(fileIndex += 1)}.sqlite`);
    const store = new DurableDeliveryStore(getDb(path));
    const published = new Date("2026-08-15T00:00:00.000Z");
    const listing: Listing = {
      source: "domria",
      sourceId: "historical",
      url: "https://dom.ria.com/uk/realty-historical.html",
      title: "Квартира",
      location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
      propertyType: "apartment",
      sellerType: "owner",
      discoveredAt: published,
      publishedAt: published,
      price: { amount: 10000, currency: "UAH", period: "month" },
    };
    store.establishSilent("domria", [listing], store, new Date("2026-09-01T00:00:00.000Z"));
    const adapter: ListingSourceAdapter = {
      source: "domria",
      fetchLatest: async () => [listing],
      inspectLatest: async () => ({
        listings: [listing],
        transport: "test",
        dataKind: "MOCK DATA",
        resultKind: "ok",
        health: { source: "domria", healthy: true, checkedAt: published },
      }),
      healthCheck: async () => ({ source: "domria", healthy: true, checkedAt: published }),
    };
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter],
        config: loadConfig({
          ...PRODUCTION_RUNTIME_ENV,
          ENABLE_LUN: "false",
          ENABLE_OLX_BROWSER: "false",
        }),
        sink: new TelegramTestSink({
          botToken: "123456:test-token",
          chatId: "-100111",
          testMode: true,
          dryRun: false,
          timeoutMs: 1_000,
          maxRetries: 0,
          fetchImpl: async () => {
            throw new Error("historical listing must not be sent");
          },
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-21T12:00:00.000Z"),
      },
      1,
    );
    expect(report.deliveryMode).toBe("send_new");
    expect(report.sentOk).toBe(0);
  });
});
