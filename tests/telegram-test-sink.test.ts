import { describe, expect, it, vi } from "vitest";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { InMemoryListingDedupe } from "../src/delivery/listing-dedupe-memory.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
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
  it("includes source, title, price, city, seller, published time, url", () => {
    const text = formatListingTelegramHtml(sampleListing());
    expect(text).toContain("Квартира");
    expect(text).toContain("12000");
    expect(text).toContain("Львів");
    expect(text).toContain("owner (platform-verified)");
    expect(formatListingTelegramHtml(sampleListing({ sellerType: "unknown" }))).toContain(
      "unknown (not verified ownership)",
    );
    expect(text).toContain("2026-09-16T12:00:00.000Z");
    expect(text).toContain("https://rieltor.ua/flats-rent/100/");
    expect(text).toContain("rieltor");
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
    });
    expect(report.zeroResult).toBe(true);
    expect(report.newAfterDedupe).toBe(0);
    expect(report.zeroEligibleListings || report.hasSourceFailures).toBe(true);
    expect(sendListing).not.toHaveBeenCalled();
    resetConfigCache();
  });

  it("isolates source and send failures", async () => {
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
    });

    const good = sampleListing({
      source: "lun",
      sourceId: "22",
      url: "https://lun.ua/uk/realty/22",
      sellerType: "owner",
      propertyType: "apartment",
    });
    const failingAdapter: ListingSourceAdapter = {
      source: "domria",
      fetchLatest: async () => [],
      inspectLatest: async () => {
        throw new Error("domria boom");
      },
      healthCheck: async () => ({ source: "domria", healthy: false, checkedAt: new Date() }),
    };

    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "55",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
    });

    const report = await runTelegramTestCycle({
      adapters: [failingAdapter, adapter("lun", [good])],
      config,
      sink,
      dedupe: new InMemoryListingDedupe(),
      seedInventory: false,
    });

    expect(report.sourceErrors.some((e) => e.source === "domria")).toBe(true);
    expect(report.newAfterDedupe).toBe(1);
    expect(report.sentFailed).toBe(1);
    expect(report.partialCoverage).toBe(true);
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
      FIRST_RUN_MODE: "send",
    });
    const good = sampleListing({
      source: "lun",
      sourceId: "77",
      url: "https://lun.ua/uk/realty/77",
      sellerType: "owner",
      propertyType: "apartment",
    });
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "55",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
    });
    const dedupe = new InMemoryListingDedupe();
    const report1 = await runTelegramTestCycle(
      { adapters: [adapter("lun", [good])], config, sink, dedupe, seedInventory: false },
      1,
    );
    expect(report1.sentFailed).toBe(1);
    expect(dedupe.hasSeen(good)).toBe(false);

    const sinkOk = new TelegramTestSink({
      botToken: "1:token",
      chatId: "55",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    const report2 = await runTelegramTestCycle(
      { adapters: [adapter("lun", [good])], config, sink: sinkOk, dedupe, seedInventory: false },
      2,
    );
    expect(report2.newlyObservedCount).toBe(1);
    expect(report2.sentOk).toBe(1);
    expect(dedupe.hasSeen(good)).toBe(true);
    resetConfigCache();
  });

  it("seeds initial inventory without sending when seedInventory=true", async () => {
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
    });
    const good = sampleListing({
      source: "lun",
      sourceId: "88",
      url: "https://lun.ua/uk/realty/88",
      sellerType: "owner",
      propertyType: "apartment",
    });
    const sendListing = vi.fn();
    const sink = { chatId: "1", sendListing } as unknown as TelegramTestSink;
    const dedupe = new InMemoryListingDedupe();
    const report = await runTelegramTestCycle(
      { adapters: [adapter("lun", [good])], config, sink, dedupe, seedInventory: true },
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
