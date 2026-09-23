import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { coverageForAcquiredCards } from "../src/delivery/catalog-sample.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing, ListingSource } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import {
  emptyOlxBrowserExtractResult,
  mapOlxBrowserExtractToFetchResult,
} from "../src/sources/olx/olx-browser.source.ts";
import { rieltorCatchupKey } from "../src/sources/rieltor/rieltor-incremental.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { readSourceHealth } from "../src/storage/source-health.ts";

const SEED = "2026-09-22T10:00:00.000Z";
const LATER = "2026-09-22T10:30:00.000Z";
const RECOVERED = "2026-09-22T11:00:00.000Z";

describe("acquired-response cap coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-acquired-cap-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  function configFor(source: ListingSource) {
    resetConfigCache();
    return loadConfig({
      OWNER_ONLY: "true",
      SELLER_POLICY: "reject_intermediaries",
      ENABLE_DOMRIA: source === "domria" ? "true" : "false",
      ENABLE_LUN: source === "lun" ? "true" : "false",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: source === "olx" ? "true" : "false",
      ENABLE_RIELTOR: source === "rieltor" ? "true" : "false",
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

  function listing(source: ListingSource, sourceId: string, publishedAt: string): Listing {
    return {
      source,
      sourceId,
      url: `https://example.test/${source}/${sourceId}`,
      title: "Квартира",
      location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
      propertyType: "apartment",
      sellerType: "owner",
      discoveredAt: new Date(publishedAt),
      publishedAt: new Date(publishedAt),
    };
  }

  function sink(alerts: string[] = []): TelegramTestSink {
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

  function adapter(source: ListingSource, result: SourceFetchResult): ListingSourceAdapter {
    return {
      source,
      fetchLatest: async () => [],
      inspectLatest: async () => result,
      healthCheck: async () => ({ source, healthy: true, checkedAt: new Date() }),
    };
  }

  function complete(source: ListingSource, at: Date, listings: Listing[] = []): SourceFetchResult {
    return {
      listings,
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: listings.length > 0 ? "ok" : "valid_empty",
      httpStatus: 200,
      health: {
        source,
        healthy: true,
        checkedAt: at,
        message: "complete",
      },
    };
  }

  function capped(source: ListingSource, at: Date, listings: Listing[]): SourceFetchResult {
    const coverage = coverageForAcquiredCards(listings.length, true);
    return {
      listings,
      transport: "test",
      dataKind: "MOCK DATA",
      resultKind: "ok",
      httpStatus: 200,
      ...(coverage ? { coverage } : {}),
      health: {
        source,
        healthy: false,
        checkedAt: at,
        message: "cap",
      },
    };
  }

  function baselineSuccess(path: string, source: ListingSource): string | null {
    const row = getDb(path)
      .prepare("SELECT last_success_at FROM source_baselines WHERE source = ?")
      .get(source) as { last_success_at: string } | undefined;
    return row?.last_success_at ?? null;
  }

  async function seed(path: string, source: ListingSource) {
    const store = new DurableDeliveryStore(getDb(path));
    await runTelegramTestCycle(
      {
        adapters: [adapter(source, complete(source, new Date(SEED)))],
        config: configFor(source),
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

  for (const source of ["domria", "lun", "olx"] as const) {
    it(`${source} cap hit keeps the acquired cards processable and records coverage_degraded`, async () => {
      const path = dbPath();
      const store = await seed(path, source);
      const kept = listing(source, "kept-1", LATER);
      const cycle = await runTelegramTestCycle(
        {
          adapters: [adapter(source, capped(source, new Date(LATER), [kept]))],
          config: configFor(source),
          sink: sink(),
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => new Date(LATER),
        },
        1,
      );
      expect(cycle.sentOk).toBe(1);
      const health = readSourceHealth(getDb(path), source);
      expect(health?.status).toBe("coverage_degraded");
      expect(health?.lastErrorSafe).toContain("acquired_response_cap");
      expect(health?.lastErrorSafe).toContain("coverageTruncated=true");
      expect(health?.lastErrorSafe).not.toContain("rieltor_incremental");
      expect(health?.consecutiveFailures).toBe(1);
      expect(health?.lastSuccessAt).toBe(SEED);
      expect(baselineSuccess(path, source)).toBe(SEED);
    });
  }

  it("does not mark coverage degraded when the acquired cap is not hit", async () => {
    const path = dbPath();
    const store = await seed(path, "lun");
    const kept = listing("lun", "under-cap", LATER);
    const cycle = await runTelegramTestCycle(
      {
        adapters: [adapter("lun", complete("lun", new Date(LATER), [kept]))],
        config: configFor("lun"),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(LATER),
      },
      1,
    );
    expect(cycle.sentOk).toBe(1);
    expect(cycle.sourceAttempts.find((item) => item.source === "lun")?.funnel).toMatchObject({
      sent: 1,
      collected: expect.any(Number),
    });
    const health = readSourceHealth(getDb(path), "lun");
    expect(health?.status).toBe("ok");
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.lastSuccessAt).toBe(LATER);
    expect(baselineSuccess(path, "lun")).toBe(LATER);
  });

  it("reaches the existing admin-alert threshold on repeated cap truncation and recovers once", async () => {
    const path = dbPath();
    const alerts: string[] = [];
    const store = await seed(path, "domria");
    const degradedAt = [
      "2026-09-22T10:10:00.000Z",
      "2026-09-22T10:20:00.000Z",
      "2026-09-22T10:30:00.000Z",
      "2026-09-22T10:40:00.000Z",
    ];
    for (const at of degradedAt) {
      await runTelegramTestCycle(
        {
          adapters: [
            adapter(
              "domria",
              capped("domria", new Date(at), [listing("domria", `cap-${at}`, at)]),
            ),
          ],
          config: configFor("domria"),
          sink: sink(alerts),
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => new Date(at),
        },
        1,
      );
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("coverage_degraded");
    expect(readSourceHealth(getDb(path), "domria")?.consecutiveFailures).toBe(4);
    expect(baselineSuccess(path, "domria")).toBe(SEED);

    await runTelegramTestCycle(
      {
        adapters: [adapter("domria", complete("domria", new Date(RECOVERED)))],
        config: configFor("domria"),
        sink: sink(alerts),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(RECOVERED),
      },
      1,
    );
    expect(alerts).toHaveLength(2);
    const health = readSourceHealth(getDb(path), "domria");
    expect(health?.status).toBe("valid_empty");
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.lastSuccessAt).toBe(RECOVERED);
    expect(baselineSuccess(path, "domria")).toBe(RECOVERED);
  });

  it("advances last_success_at only on a later complete poll", async () => {
    const path = dbPath();
    const store = await seed(path, "olx");
    const degraded = await runTelegramTestCycle(
      {
        adapters: [
          adapter("olx", capped("olx", new Date(LATER), [listing("olx", "partial", LATER)])),
        ],
        config: configFor("olx"),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(LATER),
      },
      1,
    );
    expect(degraded.sentOk).toBe(1);
    expect(baselineSuccess(path, "olx")).toBe(SEED);
    expect(readSourceHealth(getDb(path), "olx")?.lastSuccessAt).toBe(SEED);

    await runTelegramTestCycle(
      {
        adapters: [adapter("olx", complete("olx", new Date(RECOVERED)))],
        config: configFor("olx"),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(RECOVERED),
      },
      1,
    );
    expect(baselineSuccess(path, "olx")).toBe(RECOVERED);
    expect(readSourceHealth(getDb(path), "olx")?.lastSuccessAt).toBe(RECOVERED);
    expect(readSourceHealth(getDb(path), "olx")?.status).toBe("valid_empty");
  });

  it("does not change a RIELTOR catch-up cursor when coverage is degraded", async () => {
    const path = dbPath();
    const store = await seed(path, "rieltor");
    const cursor = { target: SEED, resumePage: 4 };
    getDb(path)
      .prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
      .run(rieltorCatchupKey("apartment"), JSON.stringify(cursor));
    const degraded = await runTelegramTestCycle(
      {
        adapters: [
          adapter("rieltor", {
            listings: [listing("rieltor", "13070001", LATER)],
            transport: "test",
            dataKind: "MOCK DATA",
            resultKind: "ok",
            httpStatus: 200,
            coverage: {
              pagesFetched: 3,
              cardsFetched: 60,
              boundaryReached: false,
              coverageTruncated: true,
              catchup: { apartment: cursor, house: null },
            },
            health: {
              source: "rieltor",
              healthy: false,
              checkedAt: new Date(LATER),
              message: "truncated",
            },
          }),
        ],
        config: configFor("rieltor"),
        sink: sink(),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(LATER),
      },
      1,
    );
    expect(degraded.sentOk).toBe(1);
    const stored = getDb(path)
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(rieltorCatchupKey("apartment")) as { value: string };
    expect(JSON.parse(stored.value)).toEqual(cursor);
    expect(baselineSuccess(path, "rieltor")).toBe(SEED);
    expect(readSourceHealth(getDb(path), "rieltor")?.status).toBe("coverage_degraded");
    expect(readSourceHealth(getDb(path), "rieltor")?.lastSuccessAt).toBe(SEED);
  });
});

describe("OLX acquired-card mapping", () => {
  function card(sourceId: string, propertyType: "apartment" | "house"): Listing {
    return {
      source: "olx",
      sourceId,
      url: `https://www.olx.ua/d/uk/obyavlenie/${sourceId}`,
      title: "Оголошення",
      location: { raw: "Львів", city: "Львів" },
      propertyType,
      sellerType: "unknown",
      discoveredAt: new Date(SEED),
    };
  }

  it("marks a trimmed browser extract as truncated coverage and keeps the capped cards", () => {
    const apartments = Array.from({ length: 121 }, (_, index) => card(`a${index + 1}`, "apartment"));
    const houses = [card("h1", "house"), card("h2", "house")];
    const mapped = mapOlxBrowserExtractToFetchResult(
      emptyOlxBrowserExtractResult({
        extractionOk: true,
        accessibilityOk: true,
        listings: [...apartments, ...houses],
      }),
      { startedMs: Date.now() },
    );
    expect(mapped.resultKind).toBe("ok");
    expect(mapped.listings).toHaveLength(122);
    expect(mapped.listings.filter((item) => item.propertyType === "house")).toHaveLength(2);
    expect(mapped.listings.some((item) => item.sourceId === "a121")).toBe(false);
    expect(mapped.coverage?.coverageTruncated).toBe(true);
    expect(mapped.coverage?.boundaryReached).toBe(false);
    expect(mapped.health.healthy).toBe(false);
  });

  it("leaves coverage unset when the acquired page fits under the cap", () => {
    const mapped = mapOlxBrowserExtractToFetchResult(
      emptyOlxBrowserExtractResult({
        extractionOk: true,
        accessibilityOk: true,
        listings: Array.from({ length: 10 }, (_, index) => card(`a${index + 1}`, "apartment")),
      }),
      { startedMs: Date.now() },
    );
    expect(mapped.resultKind).toBe("ok");
    expect(mapped.listings).toHaveLength(10);
    expect(mapped.coverage).toBeUndefined();
    expect(mapped.health.healthy).toBe(true);
  });
});
