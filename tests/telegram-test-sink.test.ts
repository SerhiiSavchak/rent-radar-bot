import { describe, expect, it, vi } from "vitest";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { InMemoryListingDedupe } from "../src/delivery/listing-dedupe-memory.ts";
import { InMemorySourceBaseline } from "../src/delivery/source-baseline-memory.ts";
import {
  formatTelegramFinalSummary,
  formatTelegramStartupMessage,
  runTelegramTestCycle,
} from "../src/delivery/telegram-test-pipeline.ts";
import {
  createTelegramTestSinkFromEnv,
  formatListingTelegramHtml,
  redactTelegramSecrets,
  resolveTelegramTestConfig,
  splitTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TelegramTestModeError,
  TelegramTestSink,
} from "../src/outputs/telegram-test.sink.ts";

function sampleListing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "rieltor",
    sourceId: "100",
    url: "https://rieltor.ua/flats-rent/100/",
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
    publishedAt: new Date("2026-09-16T12:00:00.000Z"),
    discoveredAt: new Date("2026-09-16T12:05:00.000Z"),
    ...overrides,
  };
}

function adapter(source: Listing["source"], listings: Listing[]): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => listings,
    inspectLatest: async (): Promise<SourceFetchResult> => ({
      listings,
      transport: "http",
      dataKind: "LIVE DATA",
      resultKind: "ok",
      httpStatus: 200,
      health: {
        source,
        healthy: true,
        checkedAt: new Date(),
        resultKind: "ok",
        httpStatus: 200,
        transport: "http",
      },
    }),
    healthCheck: async () => ({
      source,
      healthy: true,
      checkedAt: new Date(),
    }),
  };
}

describe("Telegram TEST mode guard", () => {
  it("refuses when TELEGRAM_TEST_MODE is missing or not exactly true", () => {
    expect(() => resolveTelegramTestConfig({})).toThrow(TelegramTestModeError);
    expect(() => resolveTelegramTestConfig({ TELEGRAM_TEST_MODE: "True" })).toThrow(TelegramTestModeError);
    expect(() => resolveTelegramTestConfig({ TELEGRAM_TEST_MODE: "1" })).toThrow(TelegramTestModeError);
    expect(() =>
      resolveTelegramTestConfig({
        TELEGRAM_TEST_MODE: "true",
        TELEGRAM_BOT_TOKEN: "123:abc",
      }),
    ).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it("accepts exact true with token and chat id", () => {
    const cfg = resolveTelegramTestConfig({
      TELEGRAM_TEST_MODE: "true",
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_CHAT_ID: "999001",
      TELEGRAM_DRY_RUN: "true",
    });
    expect(cfg.testMode).toBe(true);
    expect(cfg.chatId).toBe("999001");
    expect(cfg.dryRun).toBe(true);
  });
});

describe("Telegram token redaction", () => {
  it("redacts raw tokens and bot URL paths", () => {
    const token = "123456:AA-secret-token-value";
    const raw = `https://api.telegram.org/bot${token}/sendMessage failed bot${token}`;
    const redacted = redactTelegramSecrets(raw, token);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("[TELEGRAM_BOT_TOKEN_REDACTED]");
  });
});

describe("Telegram formatting and splitting", () => {
  it("includes source, title, price, city, seller, Kyiv published time, url", () => {
    const listing = sampleListing();
    const text = formatListingTelegramHtml(listing, { deliveryKind: "new_publication" });
    expect(text).toContain("Квартира");
    expect(text).toContain("12 000 грн / місяць");
    expect(text).toContain("Львів, Галицький");
    expect(text).toContain("Власник підтверджений");
    expect(formatListingTelegramHtml(sampleListing({ sellerType: "unknown" }))).toContain(
      "Власник не підтверджений",
    );
    expect(text).not.toContain("Вперше помічено");
    expect(text).not.toContain("firstSeen");
    expect(text).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(text).toContain("https://rieltor.ua/flats-rent/100/");
    expect(text).toContain("RIELTOR");
    expect(text).toContain("TEST");
  });

  it("splits long messages under the Telegram limit", () => {
    const long = `${"line\n".repeat(3000)}end`;
    const chunks = splitTelegramMessage(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    expect(splitTelegramMessage("short").length).toBe(1);
    expect(TELEGRAM_MAX_MESSAGE_LENGTH).toBe(4096);
  });
});

describe("Telegram chat targeting and dry-run", () => {
  it("dry-run formats without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "424242",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await sink.sendListing(sampleListing());
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.chatId).toBe("424242");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports the same dryRun on a silent seed cycle as on the sink", async () => {
    resetConfigCache();
    const config = loadConfig({
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
    });
    const fetchImpl = vi.fn();
    const drySink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "424242",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const report = await runTelegramTestCycle({
      adapters: [adapter("domria", [sampleListing()])],
      config,
      sink: drySink,
      dedupe: new InMemoryListingDedupe(),
      baseline: new InMemorySourceBaseline(),
      firstRunMode: "seed",
    });
    expect(drySink.dryRun).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.deliveryMode).toBe("inventory_seed");
    expect(report.sentOk).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(formatTelegramStartupMessage({
      chatId: drySink.chatId,
      cycles: 2,
      intervalMs: 1000,
      dryRun: drySink.dryRun,
      enableDomria: true,
      enableLun: false,
      enableRieltor: false,
      enableOlx: false,
      enableOlxBrowser: false,
      ownerOnly: true,
      ownerAcceptSelfDeclared: false,
      sellerPolicy: "reject_intermediaries",
      firstRunMode: "seed",
    })).toContain("dry_run: true");
    expect(formatTelegramFinalSummary({
      cyclesAttempted: 2,
      totalSentOk: 0,
      totalSentFailed: 0,
      totalNewAfterDedupe: 0,
      sourceFailureCycles: 0,
      zeroEligibleCycles: 2,
      partialCoverageCycles: 0,
      dryRun: drySink.dryRun,
    })).toContain("dry_run: true");
    resetConfigCache();
  });

  it("never calls Telegram HTTP when dryRun=true even after a deliverable listing appears", async () => {
    resetConfigCache();
    const config = loadConfig({
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
    const fetchImpl = vi.fn();
    const drySink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "424242",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const t0 = new Date("2026-09-17T12:00:00Z");
    const t1 = new Date("2026-09-17T13:00:00Z");
    const seed = sampleListing({
      source: "domria",
      sourceId: "seed-1",
      url: "https://dom.ria.com/uk/realty-seed-1.html",
      publishedAt: new Date("2026-09-16T12:00:00Z"),
    });
    await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [seed])],
        config,
        sink: drySink,
        dedupe,
        baseline,
        now: () => t0,
        firstRunMode: "seed",
      },
      1,
    );
    const neu = sampleListing({
      source: "domria",
      sourceId: "new-1",
      url: "https://dom.ria.com/uk/realty-new-1.html",
      publishedAt: new Date("2026-09-17T12:30:00Z"),
    });
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter("domria", [seed, neu])],
        config,
        sink: drySink,
        dedupe,
        baseline,
        now: () => t1,
        firstRunMode: "seed",
      },
      2,
    );
    expect(report.dryRun).toBe(true);
    expect(report.sentOk).toBe(1);
    expect(report.deliveryMode).toBe("send_new");
    expect(fetchImpl).not.toHaveBeenCalled();
    resetConfigCache();
  });

  it("posts only to the configured chat_id", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const sink = createTelegramTestSinkFromEnv(
      {
        TELEGRAM_TEST_MODE: "true",
        TELEGRAM_BOT_TOKEN: "1:token",
        TELEGRAM_CHAT_ID: "777888",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000, maxRetries: 0 },
    );
    await sink.sendText("hello");
    expect(bodies[0]).toMatchObject({ chat_id: "777888", text: "hello" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("api.telegram.org/bot");
  });

  it("refuses send when testMode flag is false on the sink", async () => {
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "1",
      testMode: false,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    await expect(sink.sendText("x")).rejects.toBeInstanceOf(TelegramTestModeError);
  });
});

describe("Telegram 429/5xx handling", () => {
  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limit", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response("{}", { status: 200 });
    });
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "1",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    const result = await sink.sendText("hi");
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("retries on 503 then fails safely without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "1",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    const result = await sink.sendText("hi");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.errorSafe).toBeTruthy();
  });
});

describe("in-memory dedupe + pipeline", () => {
  it("deduplicates by source+id and canonical URL", () => {
    const dedupe = new InMemoryListingDedupe();
    const first = sampleListing({ sourceId: "1", url: "https://www.rieltor.ua/a/1/" });
    expect(dedupe.takeNew([first])).toHaveLength(1);
    expect(
      dedupe.takeNew([sampleListing({ sourceId: "1", url: "https://rieltor.ua/a/1?utm=1" })]),
    ).toHaveLength(0);
  });

  it("zero-result does not send", async () => {
    resetConfigCache();
    const config = loadConfig({
      OWNER_ONLY: "true",
      ENABLE_DOMRIA: "true",
      ENABLE_LUN: "false",
      ENABLE_OLX: "false",
      ENABLE_RIELTOR: "false",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "exclude",
    });
    const sendListing = vi.fn();
    const sink = {
      chatId: "1",
      sendListing,
    } as unknown as TelegramTestSink;

    const report = await runTelegramTestCycle({
      adapters: [adapter("domria", [])],
      config,
      sink,
      dedupe: new InMemoryListingDedupe(),
      baseline: new InMemorySourceBaseline(),
    });
    expect(report.zeroResult).toBe(true);
    expect(report.newAfterDedupe).toBe(0);
    expect(report.zeroEligibleListings || report.hasSourceFailures).toBe(true);
    expect(sendListing).not.toHaveBeenCalled();
    resetConfigCache();
  });

  it("does not treat RIELTOR HTTP 403 as delivery success even if listings were already parsed", async () => {
    resetConfigCache();
    const config = loadConfig({
      OWNER_ONLY: "true",
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "false",
      ENABLE_OLX: "false",
      ENABLE_RIELTOR: "true",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
    });
    const listings = [
      sampleListing({
        sellerType: "owner",
        publishedAt: new Date("2026-09-17T12:00:00Z"),
      }),
    ];
    const blocked: ListingSourceAdapter = {
      source: "rieltor",
      fetchLatest: async () => listings,
      inspectLatest: async (): Promise<SourceFetchResult> => ({
        listings,
        transport: "public HTML catalog cards + optional JSON-LD",
        dataKind: "LIVE DATA",
        resultKind: "ok",
        httpStatus: 403,
        health: {
          source: "rieltor",
          healthy: true,
          checkedAt: new Date(),
          resultKind: "ok",
          httpStatus: 403,
          transport: "public HTML catalog cards + optional JSON-LD",
        },
      }),
      healthCheck: async () => ({ source: "rieltor", healthy: true, checkedAt: new Date() }),
    };
    const sendListing = vi.fn();
    const report = await runTelegramTestCycle({
      adapters: [blocked],
      config,
      sink: { chatId: "55", sendListing } as unknown as TelegramTestSink,
      dedupe: new InMemoryListingDedupe(),
      baseline: new InMemorySourceBaseline(),
    });
    expect(report.sourceErrors.some((item) => item.errorSafe.includes("transport_blocked"))).toBe(
      true,
    );
    expect(report.sourceAttempts.some((item) => item.resultKind === "transport_blocked")).toBe(true);
    expect(sendListing).not.toHaveBeenCalled();
    resetConfigCache();
  });

  it("isolates source failures while silently baselining healthy sources", async () => {
    resetConfigCache();
    const config = loadConfig({
      OWNER_ONLY: "true",
      ENABLE_DOMRIA: "true",
      ENABLE_LUN: "true",
      ENABLE_OLX: "false",
      ENABLE_RIELTOR: "false",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
    });

    const good = sampleListing({
      source: "lun",
      sourceId: "22",
      url: "https://lun.ua/uk/realty/22",
      sellerType: "owner",
      propertyType: "apartment",
      publishedAt: new Date("2026-09-16T12:00:00Z"),
    });
    const failingAdapter: ListingSourceAdapter = {
      source: "domria",
      fetchLatest: async () => [],
      inspectLatest: async () => {
        throw new Error("domria boom");
      },
      healthCheck: async () => ({ source: "domria", healthy: false, checkedAt: new Date() }),
    };

    const sendListing = vi.fn();
    const sink = { chatId: "55", sendListing } as unknown as TelegramTestSink;
    const baseline = new InMemorySourceBaseline();

    const report = await runTelegramTestCycle({
      adapters: [failingAdapter, adapter("lun", [good])],
      config,
      sink,
      dedupe: new InMemoryListingDedupe(),
      baseline,
      firstRunMode: "seed",
    });

    expect(report.sourceErrors.some((e) => e.source === "domria")).toBe(true);
    expect(report.partialCoverage).toBe(true);
    expect(baseline.hasBaseline("lun")).toBe(true);
    expect(baseline.hasBaseline("domria")).toBe(false);
    expect(sendListing).not.toHaveBeenCalled();
    expect(report.chatId).toBe("55");
    resetConfigCache();
  });

  it("does not permanently mark a listing delivered after a failed send", async () => {
    resetConfigCache();
    const config = loadConfig({
      OWNER_ONLY: "true",
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "true",
      ENABLE_OLX: "false",
      ENABLE_RIELTOR: "false",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
    });
    const seed = sampleListing({
      source: "lun",
      sourceId: "seed",
      url: "https://lun.ua/uk/realty/seed",
      sellerType: "owner",
      propertyType: "apartment",
      publishedAt: new Date("2026-09-10T12:00:00Z"),
    });
    const good = sampleListing({
      source: "lun",
      sourceId: "77",
      url: "https://lun.ua/uk/realty/77",
      sellerType: "owner",
      propertyType: "apartment",
      publishedAt: new Date("2026-09-17T12:30:00Z"),
    });
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const t0 = new Date("2026-09-17T12:00:00Z");
    const t1 = new Date("2026-09-17T13:00:00Z");

    await runTelegramTestCycle(
      {
        adapters: [adapter("lun", [seed])],
        config,
        sink: { chatId: "55", sendListing: vi.fn() } as unknown as TelegramTestSink,
        dedupe,
        baseline,
        now: () => t0,
      },
      1,
    );

    const sinkFail = new TelegramTestSink({
      botToken: "1:token",
      chatId: "55",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
    });
    const report1 = await runTelegramTestCycle(
      { adapters: [adapter("lun", [seed, good])], config, sink: sinkFail, dedupe, baseline, now: () => t1 },
      2,
    );
    expect(report1.sentFailed).toBe(1);
    expect(dedupe.hasSeen(good)).toBe(false);

    const sinkOk = new TelegramTestSink({
      botToken: "1:token",
      chatId: "55",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
    });
    const report2 = await runTelegramTestCycle(
      { adapters: [adapter("lun", [seed, good])], config, sink: sinkOk, dedupe, baseline, now: () => t1 },
      3,
    );
    expect(report2.newlyObservedCount).toBe(1);
    expect(report2.sentOk).toBe(1);
    expect(dedupe.hasSeen(good)).toBe(true);
    resetConfigCache();
  });

  it("seeds initial inventory without sending when firstRunMode=seed", async () => {
    resetConfigCache();
    const config = loadConfig({
      OWNER_ONLY: "true",
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "true",
      ENABLE_OLX: "false",
      ENABLE_RIELTOR: "false",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
    });
    const good = sampleListing({
      source: "lun",
      sourceId: "88",
      url: "https://lun.ua/uk/realty/88",
      sellerType: "owner",
      propertyType: "apartment",
      publishedAt: new Date("2025-12-31T15:03:31.000Z"),
    });
    const sendListing = vi.fn();
    const sink = { chatId: "1", sendListing } as unknown as TelegramTestSink;
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const report = await runTelegramTestCycle(
      { adapters: [adapter("lun", [good])], config, sink, dedupe, baseline, firstRunMode: "seed" },
      1,
    );
    expect(report.deliveryMode).toBe("inventory_seed");
    expect(report.initialInventoryCount).toBe(1);
    expect(report.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
    expect(dedupe.hasSeen(good)).toBe(true);
    resetConfigCache();
  });
});
