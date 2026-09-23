import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { FetchListingsOptions, ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import {
  assessRieltorWalk,
  planRieltorCategoryFetch,
  type RieltorCatchupState,
} from "../src/sources/rieltor/rieltor-incremental.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { applyMigrations, sqliteMigrationSql } from "../src/storage/migrations.ts";
import { readSourceHealth } from "../src/storage/source-health.ts";

const PAGE = 20;
const newestMs = Date.parse("2026-09-22T12:00:00.000Z");
const target = "2026-09-22T10:00:00.000Z";

function card(index: number, publishedAt?: string) {
  return {
    id: `c${index}`,
    ...(publishedAt ? { publishedAt } : {}),
  };
}

/** 120 newest-first cards, one minute apart. The time boundary sits on page 6. */
function catalogCard(index: number): { id: string; publishedAt: string } {
  return {
    id: `c${index}`,
    publishedAt: new Date(newestMs - index * 60 * 1000).toISOString(),
  };
}

function pageCards(page: number): Array<{ id: string; publishedAt?: string }> {
  return Array.from({ length: PAGE }, (_, offset) => catalogCard((page - 1) * PAGE + offset));
}

describe("RIELTOR incremental catch-up", () => {
  it("seeds only page 1 when there is no baseline and no watermark", () => {
    const plan = planRieltorCategoryFetch({});
    expect(plan.mode).toBe("seed");
    expect(plan.pages).toEqual([1]);
    const assessed = assessRieltorWalk({
      mode: plan.mode,
      plannedPages: plan.pages,
      fetchedPages: [1],
      crossed: false,
      failed: false,
      catalogEnded: false,
      newest: catalogCard(0).publishedAt,
    });
    expect(assessed.boundaryReached).toBe(true);
    expect(assessed.coverageTruncated).toBe(false);
    expect(assessed.committed).toBe(catalogCard(0).publishedAt);
    expect(assessed.catchup).toBeNull();
  });

  it("bootstraps an existing baseline from the monitoring target instead of page 1", () => {
    const plan = planRieltorCategoryFetch({ bootstrapTarget: target });
    expect(plan.mode).toBe("catchup");
    expect(plan.pages).toEqual([1, 2, 3]);
    expect(plan.stopAt).toBe("2026-09-22T09:30:00.000Z");
    const assessed = assessRieltorWalk({
      mode: plan.mode,
      plannedPages: plan.pages,
      fetchedPages: plan.pages,
      crossed: false,
      failed: false,
      catalogEnded: false,
      newest: catalogCard(0).publishedAt,
      catchupTarget: target,
    });
    expect(assessed.committed).toBeUndefined();
    expect(assessed.boundaryReached).toBe(false);
    expect(assessed.catchup).toEqual({ target, resumePage: 4 });
  });

  it("walks a backlog longer than three pages across polls, including after reopen", () => {
    let committed: string | undefined;
    let catchup: RieltorCatchupState | undefined;
    const cycles: number[][] = [];
    const collected = new Set<string>();
    for (let cycle = 0; cycle < 8 && (cycle === 0 || catchup || !committed); cycle += 1) {
      const stored = catchup ? JSON.parse(JSON.stringify(catchup)) as RieltorCatchupState : undefined;
      const plan = planRieltorCategoryFetch({
        ...(committed ? { committedBoundary: committed } : {}),
        ...(stored ? { catchup: stored } : {}),
        ...(!committed && !stored ? { bootstrapTarget: target } : {}),
      });
      expect(plan.pages[0]).toBe(1);
      const fetchedPages: number[] = [];
      let crossed = false;
      let catalogEnded = false;
      const stop = plan.stopAt ? Date.parse(plan.stopAt) : undefined;
      for (const page of plan.pages) {
        const slice = page === 1 && cycle > 0
          ? [card(90001, new Date(newestMs + 60_000).toISOString()), ...pageCards(1)]
          : pageCards(page);
        if (slice.length === 0) {
          catalogEnded = true;
          break;
        }
        fetchedPages.push(page);
        for (const item of slice) {
          collected.add(item.id);
          if (item.publishedAt && stop !== undefined && Date.parse(item.publishedAt) <= stop) {
            crossed = true;
            break;
          }
        }
        if (crossed) {
          break;
        }
      }
      cycles.push(fetchedPages);
      const assessed = assessRieltorWalk({
        mode: plan.mode,
        plannedPages: plan.pages,
        fetchedPages,
        crossed,
        failed: false,
        catalogEnded,
        newest: catalogCard(0).publishedAt,
        ...(plan.catchupTarget ? { catchupTarget: plan.catchupTarget } : {}),
        ...(committed ? { previousCommitted: committed } : {}),
      });
      if (assessed.committed) {
        committed = assessed.committed;
      }
      catchup = assessed.catchup ?? undefined;
      if (cycle === 0) {
        expect(fetchedPages).toEqual([1, 2, 3]);
        expect(committed).toBeUndefined();
        expect(catchup?.resumePage).toBe(4);
      }
    }
    expect(Math.max(...(cycles[1] ?? []))).toBeGreaterThan(3);
    expect(cycles.some((pages) => pages.includes(5))).toBe(true);
    expect(cycles.some((pages) => pages.includes(6))).toBe(true);
    expect(catchup).toBeUndefined();
    expect(committed).toBe(catalogCard(0).publishedAt);
    expect(collected.has("c90001")).toBe(true);
    expect(collected.has(catalogCard(100).id)).toBe(true);
  });

  it("keeps the old boundary when a later catch-up page fails", () => {
    const previous = "2026-09-22T08:00:00.000Z";
    const assessed = assessRieltorWalk({
      mode: "catchup",
      plannedPages: [1, 3, 4],
      fetchedPages: [1, 3],
      crossed: false,
      failed: true,
      catalogEnded: false,
      newest: catalogCard(0).publishedAt,
      catchupTarget: previous,
      previousCommitted: previous,
    });
    expect(assessed.committed).toBeUndefined();
    expect(assessed.boundaryReached).toBe(false);
    expect(assessed.catchup).toEqual({ target: previous, resumePage: 4 });
  });

  it("does not treat a missing publication time as the boundary", () => {
    const stop = Date.parse("2026-09-22T09:30:00.000Z");
    const cards = [
      card(0, catalogCard(0).publishedAt),
      card(1),
      card(2, "2026-09-22T11:00:00.000Z"),
    ];
    let crossed = false;
    for (const item of cards) {
      if (item.publishedAt && Date.parse(item.publishedAt) <= stop) {
        crossed = true;
      }
    }
    expect(crossed).toBe(false);
    const assessed = assessRieltorWalk({
      mode: "catchup",
      plannedPages: [1, 2, 3],
      fetchedPages: [1, 2, 3],
      crossed,
      failed: false,
      catalogEnded: false,
      newest: catalogCard(0).publishedAt,
      catchupTarget: target,
    });
    expect(assessed.boundaryReached).toBe(false);
    expect(assessed.coverageTruncated).toBe(true);
    expect(assessed.committed).toBeUndefined();
    expect(assessed.catchup?.resumePage).toBe(4);
  });
});

describe("RIELTOR coverage health and upgrade bootstrap", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-rieltor-catchup-"));
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
      ENABLE_LUN: "false",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: "false",
      ENABLE_RIELTOR: "true",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
      TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
      ADMIN_TELEGRAM_CHAT_ID: "admin",
      ...flags,
    });
  }

  function freshListing(): Listing {
    return {
      source: "rieltor",
      sourceId: "13070001",
      url: "https://rieltor.ua/lvov/flats-rent/view/13070001/",
      title: "Квартира",
      location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
      propertyType: "apartment",
      sellerType: "owner",
      discoveredAt: new Date("2026-09-22T10:05:00.000Z"),
      publishedAt: new Date("2026-09-22T10:30:00.000Z"),
    };
  }

  function sink(alerts: string[]): TelegramTestSink {
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
      sendText: async (text: string) => {
        alerts.push(text);
        return { ok: true, dryRun: false, attempts: 1, chatId: "admin", messageCount: 1 };
      },
    } as unknown as TelegramTestSink;
  }

  function adapter(
    respond: (options?: FetchListingsOptions) => SourceFetchResult,
    seen: FetchListingsOptions[] = [],
  ): ListingSourceAdapter {
    return {
      source: "rieltor",
      fetchLatest: async () => [],
      inspectLatest: async (options) => {
        if (options) {
          seen.push(options);
        }
        return respond(options);
      },
      healthCheck: async () => ({ source: "rieltor", healthy: true, checkedAt: new Date() }),
    };
  }

  function emptyComplete(now: Date): SourceFetchResult {
    return {
      listings: [],
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: "valid_empty",
      httpStatus: 200,
      coverage: {
        pagesFetched: 1,
        cardsFetched: 0,
        boundaryReached: true,
        coverageTruncated: false,
      },
      health: { source: "rieltor", healthy: true, checkedAt: now, message: "ok" },
    };
  }

  it("does not flood a brand-new database and does not invent a bootstrap target", async () => {
    const seen: FetchListingsOptions[] = [];
    const now = new Date("2026-09-22T10:00:00.000Z");
    const listings = [freshListing()];
    const store = new DurableDeliveryStore(getDb(dbPath()));
    const report = await runTelegramTestCycle(
      {
        adapters: [
          adapter((options) => {
            expect(options?.rieltorBootstrapTarget).toBeUndefined();
            return {
              listings,
              transport: "test",
              dataKind: "MOCK DATA",
              resultKind: "ok",
              httpStatus: 200,
              coverage: {
                pagesFetched: 1,
                cardsFetched: 1,
                boundaryReached: true,
                coverageTruncated: false,
                committedBoundary: {
                  apartment: "2026-09-22T10:05:00.000Z",
                  house: "2026-09-22T10:05:00.000Z",
                },
              },
              health: { source: "rieltor", healthy: true, checkedAt: now, message: "ok" },
            };
          }, seen),
        ],
        config: configFor(),
        sink: sink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
      },
      1,
    );
    expect(seen[0]?.rieltorBootstrapTarget).toBeUndefined();
    expect(report.sentOk).toBe(0);
    expect(readSourceHealth(getDb(), "rieltor")?.status).toBe("ok");
  });

  it("bootstraps an existing schema baseline into a resumable catch-up", async () => {
    const path = dbPath();
    const db = getDb(path);
    db.prepare(
      `INSERT INTO source_baselines (source, established_at, last_success_at, seed_listing_count)
       VALUES ('rieltor', ?, ?, 10)`,
    ).run("2026-09-22T08:00:00.000Z", "2026-09-22T09:50:00.000Z");
    const seen: FetchListingsOptions[] = [];
    const store = new DurableDeliveryStore(db);
    const now = new Date("2026-09-22T10:30:00.000Z");
    await runTelegramTestCycle(
      {
        adapters: [
          adapter((options) => ({
            listings: [freshListing()],
            transport: "test",
            dataKind: "MOCK DATA",
            resultKind: "ok",
            httpStatus: 200,
            coverage: {
              pagesFetched: 3,
              cardsFetched: 60,
              boundaryReached: false,
              coverageTruncated: true,
              catchup: {
                apartment: {
                  target: options?.rieltorBootstrapTarget?.toISOString() ?? "",
                  resumePage: 4,
                },
                house: {
                  target: options?.rieltorBootstrapTarget?.toISOString() ?? "",
                  resumePage: 4,
                },
              },
            },
            health: { source: "rieltor", healthy: false, checkedAt: now, message: "degraded" },
          }), seen),
        ],
        config: configFor(),
        sink: sink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
      },
      2,
    );
    expect(seen[0]?.rieltorBootstrapTarget?.toISOString()).toBe("2026-09-22T08:00:00.000Z");
    expect(seen[0]?.publicationWatermarks).toBeUndefined();
    const cursor = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'rieltor_incremental_catchup_apartment'")
      .get() as { value: string };
    expect(JSON.parse(cursor.value)).toEqual({
      target: "2026-09-22T08:00:00.000Z",
      resumePage: 4,
    });
    expect(
      db.prepare("SELECT value FROM schema_meta WHERE key = 'rieltor_incremental_boundary_apartment'").get(),
    ).toBeUndefined();
    expect(readSourceHealth(db, "rieltor")?.status).toBe("coverage_degraded");
    const outbox = db.prepare("SELECT COUNT(*) AS n FROM telegram_outbox").get() as { n: number };
    expect(outbox.n).toBe(1);
    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    const again: FetchListingsOptions[] = [];
    await runTelegramTestCycle(
      {
        adapters: [
          adapter(() => ({
            listings: [],
            transport: "test",
            dataKind: "MOCK DATA",
            resultKind: "valid_empty",
            httpStatus: 200,
            coverage: {
              pagesFetched: 3,
              cardsFetched: 40,
              boundaryReached: false,
              coverageTruncated: true,
              catchup: {
                apartment: { target: "2026-09-22T08:00:00.000Z", resumePage: 5 },
              },
            },
            health: { source: "rieltor", healthy: false, checkedAt: now, message: "degraded" },
          }), again),
        ],
        config: configFor(),
        sink: sink([]),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T10:40:00.000Z"),
      },
      3,
    );
    expect(again[0]?.rieltorCatchup?.apartment?.resumePage).toBe(4);
    expect(again[0]?.publicationWatermarks).toBeUndefined();
  });

  it("alerts once for repeated coverage degradation, keeps the incident across reopen, and recovers once", async () => {
    const path = dbPath();
    const alerts: string[] = [];
    const store = new DurableDeliveryStore(getDb(path));
    const seedAt = new Date("2026-09-22T10:00:00.000Z");
    await runTelegramTestCycle(
      {
        adapters: [adapter(() => emptyComplete(seedAt))],
        config: configFor(),
        sink: sink(alerts),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seedAt,
      },
      1,
    );
    const degraded = (at: Date, listings: Listing[] = []): SourceFetchResult => ({
      listings,
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: listings.length > 0 ? "ok" : "valid_empty",
      httpStatus: 200,
      coverage: {
        pagesFetched: 3,
        cardsFetched: listings.length,
        boundaryReached: false,
        coverageTruncated: true,
        catchup: {
          apartment: { target: "2026-09-22T08:00:00.000Z", resumePage: 4 },
        },
      },
      health: { source: "rieltor", healthy: false, checkedAt: at, message: "degraded" },
    });
    const runAt = async (at: Date, listings: Listing[] = []) =>
      runTelegramTestCycle(
        {
          adapters: [adapter(() => degraded(at, listings))],
          config: configFor(),
          sink: sink(alerts),
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => at,
        },
        2,
      );
    const delivered = await runAt(new Date("2026-09-22T10:30:00.000Z"), [freshListing()]);
    expect(delivered.sentOk).toBe(1);
    expect(readSourceHealth(getDb(), "rieltor")?.status).toBe("coverage_degraded");
    expect(readSourceHealth(getDb(), "rieltor")?.status).not.toBe("ok");
    expect(alerts).toHaveLength(0);
    await runAt(new Date("2026-09-22T10:20:00.000Z"));
    const third = await runAt(new Date("2026-09-22T10:30:00.000Z"));
    expect(third.adminAlertsSent).toBe(1);
    expect(alerts[0]).toContain("coverage_degraded");
    const fourth = await runAt(new Date("2026-09-22T10:40:00.000Z"));
    expect(fourth.adminAlertsSent).toBe(0);
    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    const incident = getDb()
      .prepare("SELECT incident_open AS open FROM source_admin_alerts WHERE source = 'rieltor'")
      .get() as { open: number };
    expect(incident.open).toBe(1);
    const afterRestart = await runTelegramTestCycle(
      {
        adapters: [adapter(() => degraded(new Date("2026-09-22T10:50:00.000Z")))],
        config: configFor(),
        sink: sink(alerts),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T10:50:00.000Z"),
      },
      6,
    );
    expect(afterRestart.adminAlertsSent).toBe(0);
    const recovered = await runTelegramTestCycle(
      {
        adapters: [adapter(() => emptyComplete(new Date("2026-09-22T11:00:00.000Z")))],
        config: configFor(),
        sink: sink(alerts),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T11:00:00.000Z"),
      },
      7,
    );
    expect(recovered.adminAlertsSent).toBe(1);
    expect(alerts.at(-1)).toContain("recovered");
    expect(readSourceHealth(getDb(), "rieltor")?.status).toBe("valid_empty");
    const again = await runTelegramTestCycle(
      {
        adapters: [adapter(() => emptyComplete(new Date("2026-09-22T11:10:00.000Z")))],
        config: configFor(),
        sink: sink(alerts),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T11:10:00.000Z"),
      },
      8,
    );
    expect(again.adminAlertsSent).toBe(0);
  });

  it("migrates a populated schema 7 database without dropping operational rows", () => {
    const path = dbPath();
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (let version = 1; version <= 7; version += 1) {
      db.exec("BEGIN IMMEDIATE;");
      db.exec(sqliteMigrationSql(version));
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-09-22T00:00:00.000Z",
      );
      db.exec("COMMIT;");
    }
    const at = "2026-09-22T09:00:00.000Z";
    db.prepare(
      `INSERT INTO source_baselines (source, established_at, last_success_at, seed_listing_count)
       VALUES ('rieltor', ?, ?, 4)`,
    ).run(at, at);
    db.prepare(
      `INSERT INTO seen_listings (
         source, source_id, fingerprint, canonical_url, first_seen_at, last_seen_at
       ) VALUES ('rieltor', 'keep-seen', 'fp-1', 'https://rieltor.ua/lvov/flats-rent/view/1/', ?, ?)`,
    ).run(at, at);
    db.prepare(
      `INSERT INTO telegram_outbox (
         source, source_id, fingerprint, listing_json, delivery_kind, status, created_at
       ) VALUES ('rieltor', 'keep-out', 'fp-out', '{}', 'new_publication', 'sent', ?)`,
    ).run(at);
    db.prepare(
      `INSERT INTO source_health (
         source, status, checked_at, consecutive_failures, updated_at
       ) VALUES ('rieltor', 'ok', ?, 0, ?)`,
    ).run(at, at);
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, checked_at, expires_at
       ) VALUES ('rieltor', '9', 'https://rieltor.ua/lvov/flats-rent/view/9/', 'confirmed_owner', ?, ?)`,
    ).run(at, "2026-10-22T00:00:00.000Z");
    db.prepare(
      `INSERT INTO cross_source_identities (identity_key, key_class, source, source_id, created_at)
       VALUES ('rieltor:9', 'listing', 'rieltor', '9', ?)`,
    ).run(at);
    expect(() =>
      db.prepare(
        `INSERT INTO source_health (
           source, status, checked_at, consecutive_failures, updated_at
         ) VALUES ('lun', 'coverage_degraded', ?, 1, ?)`,
      ).run(at, at),
    ).toThrow();

    expect(applyMigrations(db)).toBe(9);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM source_baselines").get() as { n: number }).n,
    ).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM seen_listings").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM telegram_outbox").get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare("SELECT status FROM source_health WHERE source = 'rieltor'").get() as { status: string })
        .status,
    ).toBe("ok");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM external_seller_verifications").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM cross_source_identities").get() as { n: number }).n,
    ).toBe(1);
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seller_verification_holds'",
      ).get(),
    ).toBeTruthy();
    db.prepare(
      `INSERT INTO source_health (
         source, status, checked_at, consecutive_failures, updated_at
       ) VALUES ('lun', 'coverage_degraded', ?, 1, ?)`,
    ).run(at, at);
    expect(readSourceHealth(db, "lun")?.status).toBe("coverage_degraded");
    db.close();
  });
});
