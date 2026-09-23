import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { CANARY_META_KEY, runTelegramCanary } from "../src/delivery/telegram-canary.ts";
import {
  channelPauseDelayMs,
  classifyTelegramFailure,
  TELEGRAM_PAUSE_FAILURES_KEY,
  TELEGRAM_PAUSE_UNTIL_KEY,
  transientNextDelayMs,
} from "../src/delivery/telegram-delivery.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import {
  formatListingTelegramHtml,
  formatListingTelegramPlain,
  TelegramTestSink,
} from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

const seededAt = new Date("2026-09-22T08:00:00.000Z");
const published = new Date("2026-09-22T09:00:00.000Z");
const sendAt = new Date("2026-09-22T10:00:00.000Z");

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "domria",
    sourceId: "100",
    url: "https://dom.ria.com/uk/realty-100.html",
    title: "Квартира",
    price: { amount: 12000, currency: "UAH", period: "month" },
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: published,
    publishedAt: published,
    ...overrides,
  };
}

function config(extra: Record<string, string> = {}) {
  resetConfigCache();
  return loadConfig({
    OWNER_ONLY: "true",
    SELLER_POLICY: "reject_intermediaries",
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
    ...extra,
  });
}

function sourceAdapter(
  source: Listing["source"],
  getListings: () => Listing[],
  kind: SourceFetchResult["resultKind"] = "ok",
): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => getListings(),
    inspectLatest: async (): Promise<SourceFetchResult> => {
      const available = getListings();
      const resolved = kind === "ok" && available.length === 0 ? "valid_empty" : (kind ?? "ok");
      const healthy = resolved === "ok" || resolved === "valid_empty";
      return {
        listings: healthy ? available : [],
        transport: "test",
        dataKind: "MOCK DATA",
        resultKind: resolved,
        httpStatus: resolved === "parser_failure" || healthy ? 200 : 503,
        health: {
          source,
          healthy,
          checkedAt: sendAt,
          message: healthy ? "ok" : String(resolved),
        },
      };
    },
    healthCheck: async () => ({ source, healthy: true, checkedAt: sendAt }),
  };
}

function jsonResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, headers ? { status, headers } : { status });
}

describe("telegram delivery hardening", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-tg-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  async function seed(store: DurableDeliveryStore, adapters: ListingSourceAdapter[]) {
    await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: true,
          timeoutMs: 1000,
          maxRetries: 0,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
      },
      1,
    );
  }

  it("classifies transient and permanent Telegram failures", () => {
    expect(classifyTelegramFailure(undefined, "").errorClass).toBe("transient");
    expect(classifyTelegramFailure(500, "down").errorClass).toBe("transient");
    expect(classifyTelegramFailure(429, "rate").errorClass).toBe("transient");
    expect(classifyTelegramFailure(403, "Forbidden: bot was blocked")).toMatchObject({
      errorClass: "operator_action",
      reason: "forbidden",
    });
    expect(classifyTelegramFailure(400, "Bad Request: chat not found")).toMatchObject({
      errorClass: "operator_action",
      reason: "chat_not_found",
    });
    expect(classifyTelegramFailure(401, "Unauthorized")).toMatchObject({
      errorClass: "operator_action",
      reason: "unauthorized",
    });
    expect(channelPauseDelayMs(1)).toBe(10 * 60 * 1000);
    expect(channelPauseDelayMs(2)).toBe(20 * 60 * 1000);
    expect(channelPauseDelayMs(8)).toBe(6 * 60 * 60 * 1000);
    expect(classifyTelegramFailure(400, "Bad Request: can't parse entities").parseError).toBe(true);
    expect(classifyTelegramFailure(400, "Bad Request: message is too long").errorClass).toBe(
      "permanent",
    );
    expect(transientNextDelayMs(1, 3_600_000)).toBe(3_600_000);
    expect(transientNextDelayMs(1, 0)).toBe(2 * 60 * 1000);
  });

  it("marks a successful send sent and does not resend it after restart", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [sourceAdapter("domria", () => batch)];
    await seed(store, adapters);
    batch.push(listing());
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return jsonResponse(200, "{}");
    });
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "listing",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(calls).toBe(1);
    const row = getDb().prepare("SELECT status FROM telegram_outbox").get() as { status: string };
    expect(row.status).toBe("sent");
    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    const again = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink,
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T11:00:00.000Z"),
      },
      3,
    );
    expect(again.sentOk).toBe(0);
    expect(calls).toBe(1);
    expect(reopened.listRetryable()).toHaveLength(0);
  });

  it("keeps network and 500 failures retryable, and delays a 429 without hammering", async () => {
    const cases = [
      {
        name: "network",
        fetch: async () => {
          throw new Error("socket hang up");
        },
        status: undefined as number | undefined,
      },
      {
        name: "500",
        fetch: async () => jsonResponse(500, "down"),
        status: 500,
      },
    ];
    for (const item of cases) {
      const path = dbPath();
      const store = new DurableDeliveryStore(getDb(path));
      const batch: Listing[] = [];
      const adapters = [sourceAdapter("domria", () => batch)];
      await seed(store, adapters);
      batch.push(
        listing({ sourceId: item.name, url: `https://dom.ria.com/uk/realty-${item.name}.html` }),
      );
      const report = await runTelegramTestCycle(
        {
          adapters,
          config: config(),
          sink: new TelegramTestSink({
            botToken: "1:token",
            chatId: "listing",
            testMode: true,
            dryRun: false,
            timeoutMs: 1000,
            maxRetries: 0,
            fetchImpl: item.fetch as unknown as typeof fetch,
          }),
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => sendAt,
        },
        2,
      );
      expect(report.sentFailed, item.name).toBe(1);
      const row = getDb()
        .prepare(
          "SELECT status, error_class AS errorClass FROM telegram_outbox WHERE source_id = ?",
        )
        .get(item.name) as { status: string; errorClass: string };
      expect(row.status, item.name).toBe("failed");
      expect(row.errorClass, item.name).toBe("transient");
      expect(store.listRetryable(20, sendAt), item.name).toHaveLength(0);
      expect(
        store.listRetryable(20, new Date(sendAt.getTime() + 3 * 60 * 1000)),
        item.name,
      ).toHaveLength(1);
      closeDb();
      const reopened = new DurableDeliveryStore(getDb(path));
      expect(reopened.listRetryable(20, new Date(sendAt.getTime() + 3 * 60 * 1000))).toHaveLength(
        1,
      );
      closeDb();
    }

    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [sourceAdapter("domria", () => batch)];
    await seed(store, adapters);
    batch.push(listing({ sourceId: "rate", url: "https://dom.ria.com/uk/realty-rate.html" }));
    let calls = 0;
    await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: false,
          timeoutMs: 1000,
          maxRetries: 2,
          sleep: async () => undefined,
          fetchImpl: (async () => {
            calls += 1;
            return jsonResponse(429, JSON.stringify({ parameters: { retry_after: 3600 } }));
          }) as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      2,
    );
    expect(calls).toBe(1);
    const scheduled = getDb()
      .prepare(
        "SELECT next_attempt_at AS nextAttemptAt, error_class AS errorClass FROM telegram_outbox",
      )
      .get() as { nextAttemptAt: string; errorClass: string };
    expect(scheduled.errorClass).toBe("transient");
    expect(Date.parse(scheduled.nextAttemptAt) - sendAt.getTime()).toBeGreaterThanOrEqual(
      3_600_000,
    );
    const early = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: false,
          timeoutMs: 1000,
          maxRetries: 2,
          fetchImpl: (async () => {
            calls += 1;
            return jsonResponse(200, "{}");
          }) as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(sendAt.getTime() + 10 * 60 * 1000),
      },
      3,
    );
    expect(early.sentOk).toBe(0);
    expect(calls).toBe(1);
  });

  it("recovers a sending row and leaves a sent row alone", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const item = listing({ sourceId: "crash", url: "https://dom.ria.com/uk/realty-crash.html" });
    const enqueued = store.enqueueIfNew(item, "new_publication");
    expect(store.claimForSend(enqueued.id)).toBe(true);
    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    const pending = getDb().prepare("SELECT status FROM telegram_outbox").get() as {
      status: string;
    };
    expect(pending.status).toBe("pending");
    expect(reopened.listRetryable(20, sendAt)).toHaveLength(1);
    const sent = listing({ sourceId: "done", url: "https://dom.ria.com/uk/realty-done.html" });
    const done = reopened.enqueueIfNew(sent, "new_publication");
    expect(reopened.claimForSend(done.id, sendAt)).toBe(true);
    reopened.markSent(done.id, sendAt);
    closeDb();
    const again = new DurableDeliveryStore(getDb(path));
    const rows = getDb()
      .prepare("SELECT source_id AS sourceId, status FROM telegram_outbox ORDER BY id")
      .all() as Array<{ sourceId: string; status: string }>;
    expect(rows).toEqual([
      { sourceId: "crash", status: "pending" },
      { sourceId: "done", status: "sent" },
    ]);
    expect(again.listRetryable(20, sendAt).map((row) => row.sourceId)).toEqual(["crash"]);
  });

  it("does not let one failed row erase itself or block another listing", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [sourceAdapter("domria", () => batch)];
    await seed(store, adapters);
    batch.push(
      listing({ sourceId: "a", url: "https://dom.ria.com/uk/realty-a.html" }),
      listing({ sourceId: "b", url: "https://dom.ria.com/uk/realty-b.html" }),
    );
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      if (body.text.includes("realty-a")) {
        return jsonResponse(400, "Bad Request: message is too long");
      }
      return jsonResponse(200, "{}");
    });
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: false,
          timeoutMs: 1000,
          maxRetries: 0,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(report.sentFailed).toBe(1);
    const rows = getDb()
      .prepare(
        "SELECT source_id AS sourceId, status, error_class AS errorClass FROM telegram_outbox ORDER BY source_id",
      )
      .all() as Array<{ sourceId: string; status: string; errorClass: string | null }>;
    expect(rows).toEqual([
      { sourceId: "a", status: "failed", errorClass: "permanent" },
      { sourceId: "b", status: "sent", errorClass: null },
    ]);
    expect(store.listRetryable(20, new Date(sendAt.getTime() + 24 * 60 * 60 * 1000))).toHaveLength(
      0,
    );
    expect(meta(TELEGRAM_PAUSE_UNTIL_KEY)).toBeUndefined();
  });

  it("falls back from a parse error to plain text and keeps the row sent", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [sourceAdapter("domria", () => batch)];
    await seed(store, adapters);
    batch.push(
      listing({
        title: "<b>bad</b>",
        sourceId: "html",
        url: "https://dom.ria.com/uk/realty-html.html",
      }),
    );
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.parse_mode === "HTML") {
        return jsonResponse(400, "Bad Request: can't parse entities");
      }
      return jsonResponse(200, "{}");
    });
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: false,
          timeoutMs: 1000,
          maxRetries: 0,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.parse_mode).toBe("HTML");
    expect(bodies[1]?.parse_mode).toBeUndefined();
    expect(String(bodies[1]?.text)).toContain("https://dom.ria.com/uk/realty-html.html");
    const row = getDb().prepare("SELECT status FROM telegram_outbox").get() as { status: string };
    expect(row.status).toBe("sent");
  });

  it("renders missing fields, escapes HTML, and keeps an oversized message inside the limit", () => {
    const sparse = listing({
      title: "Квартира",
      price: undefined,
      location: { raw: "A <b>tag</b> & more" },
      publishedAt: undefined,
      sellerType: "unknown",
    });
    const text = formatListingTelegramHtml(sparse);
    expect(text).toContain("Ціна не вказана");
    expect(text).toContain("Власник не підтверджений");
    expect(text).toContain("DIM.RIA");
    expect(text).toContain(sparse.url);
    expect(text).toContain("&lt;b&gt;tag&lt;/b&gt;");
    expect(text).toContain("&amp;");
    expect(text).not.toContain("<b>tag</b>");
    expect(text).not.toContain("Вперше помічено");
    const huge = formatListingTelegramHtml(listing({ location: { raw: "x".repeat(8000) } }));
    expect(huge.length).toBeLessThanOrEqual(4096);
    expect(huge).toContain(listing().url);
    expect(formatListingTelegramPlain(sparse)).not.toContain("<b>");
  });

  it("alerts once at the failure threshold, survives restart, and recovers once", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const adapters = [sourceAdapter("domria", () => [], "parser_failure")];
    const appConfig = config({ ADMIN_TELEGRAM_CHAT_ID: "admin" });
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "listing",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: (async () => jsonResponse(200, "{}")) as unknown as typeof fetch,
    });
    const first = await runTelegramTestCycle(
      {
        adapters,
        config: appConfig,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      1,
    );
    expect(first.adminAlertsSent).toBe(0);
    await runTelegramTestCycle(
      {
        adapters,
        config: appConfig,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T10:10:00.000Z"),
      },
      2,
    );
    const third = await runTelegramTestCycle(
      {
        adapters,
        config: appConfig,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T10:20:00.000Z"),
      },
      3,
    );
    expect(third.adminAlertsSent).toBe(1);
    const fourth = await runTelegramTestCycle(
      {
        adapters,
        config: appConfig,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T10:30:00.000Z"),
      },
      4,
    );
    expect(fourth.adminAlertsSent).toBe(0);
    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    const afterRestart = await runTelegramTestCycle(
      {
        adapters,
        config: appConfig,
        sink,
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T10:40:00.000Z"),
      },
      5,
    );
    expect(afterRestart.adminAlertsSent).toBe(0);
    const healthy = [sourceAdapter("domria", () => [], "valid_empty")];
    const recovered = await runTelegramTestCycle(
      {
        adapters: healthy,
        config: appConfig,
        sink,
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T10:50:00.000Z"),
      },
      6,
    );
    expect(recovered.adminAlertsSent).toBe(1);
    const stillHealthy = await runTelegramTestCycle(
      {
        adapters: healthy,
        config: appConfig,
        sink,
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-22T11:00:00.000Z"),
      },
      7,
    );
    expect(stillHealthy.adminAlertsSent).toBe(0);
  });

  it("does not alert for one failure, a disabled source, or valid_empty", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const appConfig = config({ ADMIN_TELEGRAM_CHAT_ID: "admin", ENABLE_LUN: "false" });
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "listing",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    const one = await runTelegramTestCycle(
      {
        adapters: [sourceAdapter("domria", () => [], "parser_failure")],
        config: appConfig,
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      1,
    );
    expect(one.adminAlertsSent).toBe(0);
    const empty = await runTelegramTestCycle(
      {
        adapters: [sourceAdapter("domria", () => [], "valid_empty")],
        config: config({ ADMIN_TELEGRAM_CHAT_ID: "admin" }),
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T10:10:00.000Z"),
      },
      2,
    );
    expect(empty.adminAlertsSent).toBe(0);
    const disabled = await runTelegramTestCycle(
      {
        adapters: [],
        config: config({ ADMIN_TELEGRAM_CHAT_ID: "admin", ENABLE_DOMRIA: "false" }),
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T10:20:00.000Z"),
      },
      3,
    );
    expect(disabled.adminAlertsSent).toBe(0);
  });

  it("keeps delivering a listing when the admin alert cannot be sent", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const appConfig = config({ ADMIN_TELEGRAM_CHAT_ID: "admin", ENABLE_LUN: "true" });
    const failing = [sourceAdapter("domria", () => [], "parser_failure")];
    const quiet = new TelegramTestSink({
      botToken: "1:token",
      chatId: "listing",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    for (const minute of [0, 10, 20]) {
      await runTelegramTestCycle(
        {
          adapters: failing,
          config: appConfig,
          sink: quiet,
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => new Date(sendAt.getTime() + minute * 60 * 1000),
        },
        minute / 10 + 1,
      );
    }
    getDb().prepare("DELETE FROM source_admin_alerts").run();
    const lunBatch: Listing[] = [];
    const adapters = [
      sourceAdapter("domria", () => [], "parser_failure"),
      sourceAdapter("lun", () => lunBatch),
    ];
    await runTelegramTestCycle(
      {
        adapters: [sourceAdapter("lun", () => [])],
        config: appConfig,
        sink: quiet,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
      },
      4,
    );
    getDb().prepare("DELETE FROM source_admin_alerts").run();
    lunBatch.push(
      listing({
        source: "lun",
        sourceId: "live",
        url: "https://lun.ua/uk/realty/live",
      }),
    );
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { chat_id: string };
      if (body.chat_id === "admin") {
        throw new Error("admin chat down");
      }
      return jsonResponse(200, "{}");
    });
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: appConfig,
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: false,
          timeoutMs: 1000,
          maxRetries: 0,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T11:00:00.000Z"),
      },
      5,
    );
    expect(report.sentOk).toBe(1);
    expect(report.adminAlertErrors.length).toBeGreaterThan(0);
    const health = getDb()
      .prepare("SELECT status FROM source_health WHERE source = 'domria'")
      .get() as { status: string };
    expect(health.status).toBe("parser_failure");
  });

  it("does not send historical inventory on a silent seed", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const fetchImpl = vi.fn();
    const report = await runTelegramTestCycle(
      {
        adapters: [sourceAdapter("domria", () => [listing()])],
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: false,
          timeoutMs: 1000,
          maxRetries: 0,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
      },
      1,
    );
    expect(report.sentOk).toBe(0);
    expect(report.deliveryMode).toBe("inventory_seed");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM telegram_outbox").get()).toEqual({ n: 0 });
  });

  it("does not persist delivery, seen, or identity for a dry-run listing", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [sourceAdapter("domria", () => batch)];
    await seed(store, adapters);
    const item = listing();
    batch.push(item);
    const fetchImpl = vi.fn();
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: true,
          timeoutMs: 1000,
          maxRetries: 0,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(report.dryRun).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.hasSeen(item)).toBe(false);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM telegram_outbox").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM cross_source_identities").get()).toEqual({
      n: 0,
    });
  });

  it("leaves an existing retry row unchanged during dry-run", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const item = listing();
    const adapters = [sourceAdapter("domria", () => [])];
    await seed(store, adapters);
    const enqueued = store.enqueueIfNew(item, "new_publication");
    expect(store.claimForSend(enqueued.id, sendAt)).toBe(true);
    store.markFailed(enqueued.id, "telegram 503", sendAt, { errorClass: "transient" });
    const before = outboxRow(item.sourceId);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: true,
          timeoutMs: 1000,
          maxRetries: 0,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(sendAt.getTime() + 3 * 60 * 1000),
      },
      2,
    );
    expect(report.dryRun).toBe(true);
    expect(outboxRow(item.sourceId)).toEqual(before);
    expect(store.hasSeen(item)).toBe(false);
  });

  it("does not consume the canary marker or an admin incident during dry-run", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const db = getDb(path);
    const dry = new TelegramTestSink({
      botToken: "1:token",
      chatId: "listing",
      testMode: true,
      dryRun: true,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    const preview = await runTelegramCanary({
      env: {
        TELEGRAM_TEST_MODE: "true",
        TELEGRAM_CANARY: "true",
        TELEGRAM_BOT_TOKEN: "1:token",
        TELEGRAM_CHAT_ID: "listing",
      },
      sink: dry,
      db,
      databasePath: path,
      now: () => sendAt,
    });
    expect(preview.sent).toBe(false);
    expect(preview.alreadySent).toBe(false);
    expect(meta(CANARY_META_KEY)).toBeUndefined();

    const appConfig = config({ ADMIN_TELEGRAM_CHAT_ID: "admin" });
    const failing = [sourceAdapter("domria", () => [], "parser_failure")];
    for (const minute of [0, 10, 20]) {
      await runTelegramTestCycle(
        {
          adapters: failing,
          config: appConfig,
          sink: dry,
          dedupe: store,
          baseline: store,
          outbox: store,
          now: () => new Date(sendAt.getTime() + minute * 60 * 1000),
        },
        minute / 10 + 1,
      );
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_admin_alerts").get()).toEqual({ n: 0 });
    const fetchImpl = vi.fn(async () => jsonResponse(200, "{}"));
    const live = new TelegramTestSink({
      botToken: "1:token",
      chatId: "listing",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const incident = await runTelegramTestCycle(
      {
        adapters: failing,
        config: appConfig,
        sink: live,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T10:40:00.000Z"),
      },
      4,
    );
    expect(incident.adminAlertsSent).toBe(1);
    expect(alertOpen("domria")).toBe(1);

    const healthy = [sourceAdapter("domria", () => [], "valid_empty")];
    const dryRecovery = await runTelegramTestCycle(
      {
        adapters: healthy,
        config: appConfig,
        sink: dry,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T10:50:00.000Z"),
      },
      5,
    );
    expect(dryRecovery.adminAlertsSent).toBe(0);
    expect(alertOpen("domria")).toBe(1);
    const recovery = await runTelegramTestCycle(
      {
        adapters: healthy,
        config: appConfig,
        sink: live,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-22T11:00:00.000Z"),
      },
      6,
    );
    expect(recovery.adminAlertsSent).toBe(1);
    expect(alertOpen("domria")).toBe(0);

    const sent = await runTelegramCanary({
      env: {
        TELEGRAM_TEST_MODE: "true",
        TELEGRAM_CANARY: "true",
        TELEGRAM_BOT_TOKEN: "1:token",
        TELEGRAM_CHAT_ID: "listing",
      },
      sink: live,
      db,
      databasePath: path,
      now: () => sendAt,
    });
    expect(sent.sent).toBe(true);
    expect(meta(CANARY_META_KEY)).toBe(sendAt.toISOString());
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("pauses the channel on operator-action failures and still queues new listings", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [sourceAdapter("domria", () => batch)];
    await seed(store, adapters);
    batch.push(
      listing({ sourceId: "blocked", url: "https://dom.ria.com/uk/realty-blocked.html" }),
      listing({ sourceId: "later", url: "https://dom.ria.com/uk/realty-later.html" }),
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, JSON.stringify({ ok: false, description: "Unauthorized" })),
    );
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "listing",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const failed = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      2,
    );
    expect(failed.sentOk).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outboxRow("blocked")).toMatchObject({ status: "failed", errorClass: "operator_action" });
    expect(outboxRow("later")).toMatchObject({ status: "pending", errorClass: null });
    expect(store.hasSeen(batch[0]!)).toBe(false);
    expect(store.hasSeen(batch[1]!)).toBe(false);
    const until = meta(TELEGRAM_PAUSE_UNTIL_KEY);
    expect(Date.parse(String(until)) - sendAt.getTime()).toBe(channelPauseDelayMs(1));
    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    expect(reopened.telegramPauseActive(new Date(sendAt.getTime() + 60 * 1000))).toBe(true);
    expect(meta(TELEGRAM_PAUSE_UNTIL_KEY)).toBe(until);

    const during = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink,
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date(sendAt.getTime() + 5 * 60 * 1000),
      },
      3,
    );
    expect(during.sentOk).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outboxRow("later")?.status).toBe("pending");
    const health = getDb()
      .prepare("SELECT status FROM source_health WHERE source = 'domria'")
      .get() as { status: string };
    expect(health.status).toBe("ok");
  });

  it("probes once after the pause and clears it only when Telegram accepts", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const adapters = [sourceAdapter("domria", () => [])];
    await seed(store, adapters);
    const first = listing({ sourceId: "probe", url: "https://dom.ria.com/uk/realty-probe.html" });
    const second = listing({ sourceId: "next", url: "https://dom.ria.com/uk/realty-next.html" });
    store.enqueueIfNew(first, "new_publication");
    store.enqueueIfNew(second, "new_publication");
    store.noteOperatorChannelFailure(new Date(sendAt.getTime() - 60_000), "forbidden");
    getDb()
      .prepare("UPDATE schema_meta SET value = ? WHERE key = ?")
      .run(new Date(sendAt.getTime() - 1000).toISOString(), TELEGRAM_PAUSE_UNTIL_KEY);
    let permit = false;
    const fetchImpl = vi.fn(async () => {
      if (!permit) {
        return jsonResponse(403, "Forbidden: bot was blocked by the user");
      }
      return jsonResponse(200, "{}");
    });
    const sink = new TelegramTestSink({
      botToken: "1:token",
      chatId: "listing",
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const probe = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      2,
    );
    expect(probe.sentFailed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outboxRow("probe")).toMatchObject({ status: "failed", errorClass: "operator_action" });
    expect(outboxRow("next")?.status).toBe("pending");
    expect(meta(TELEGRAM_PAUSE_FAILURES_KEY)).toBe("2");
    expect(Date.parse(String(meta(TELEGRAM_PAUSE_UNTIL_KEY))) - sendAt.getTime()).toBe(
      channelPauseDelayMs(2),
    );

    permit = true;
    getDb()
      .prepare("UPDATE schema_meta SET value = ? WHERE key = ?")
      .run(new Date(sendAt.getTime() + 20 * 60 * 1000 - 1000).toISOString(), TELEGRAM_PAUSE_UNTIL_KEY);
    const recovered = await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(sendAt.getTime() + 20 * 60 * 1000),
      },
      3,
    );
    expect(recovered.sentOk).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(meta(TELEGRAM_PAUSE_UNTIL_KEY)).toBeUndefined();
    expect(outboxRow("probe")?.status).toBe("sent");
    expect(outboxRow("next")?.status).toBe("sent");
  });

  it("keeps a chat-not-found failure on the same channel pause", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batch: Listing[] = [];
    const adapters = [sourceAdapter("domria", () => batch)];
    await seed(store, adapters);
    batch.push(listing({ sourceId: "missing-chat", url: "https://dom.ria.com/uk/realty-chat.html" }));
    const fetchImpl = vi.fn(async () => jsonResponse(400, "Bad Request: chat not found"));
    await runTelegramTestCycle(
      {
        adapters,
        config: config(),
        sink: new TelegramTestSink({
          botToken: "1:token",
          chatId: "listing",
          testMode: true,
          dryRun: false,
          timeoutMs: 1000,
          maxRetries: 0,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => sendAt,
      },
      2,
    );
    expect(outboxRow("missing-chat")).toMatchObject({
      status: "failed",
      errorClass: "operator_action",
    });
    expect(store.telegramPauseActive(sendAt)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function meta(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function alertOpen(source: string): number {
  const row = getDb()
    .prepare("SELECT incident_open AS incidentOpen FROM source_admin_alerts WHERE source = ?")
    .get(source) as { incidentOpen: number } | undefined;
  return row?.incidentOpen ?? 0;
}

function outboxRow(sourceId: string):
  | {
      status: string;
      errorClass: string | null;
      attemptCount: number;
      nextAttemptAt: string | null;
    }
  | undefined {
  return getDb()
    .prepare(
      `SELECT status, error_class AS errorClass, attempt_count AS attemptCount,
              next_attempt_at AS nextAttemptAt
       FROM telegram_outbox WHERE source_id = ?`,
    )
    .get(sourceId) as
    | {
        status: string;
        errorClass: string | null;
        attemptCount: number;
        nextAttemptAt: string | null;
      }
    | undefined;
}
