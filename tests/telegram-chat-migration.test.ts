import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { classifyTelegramFailure, readTelegramMigrateToChatId } from "../src/delivery/telegram-delivery.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter } from "../src/domain/source.ts";
import {
  formatListingTelegramHtml,
  TelegramTestSink,
} from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

const MIGRATED = "-100999000111";
const CONFIGURED = "-100111";
const MIGRATION_BODY = JSON.stringify({
  ok: false,
  error_code: 400,
  description: "Bad Request: group chat was upgraded to a supergroup chat",
  parameters: { migrate_to_chat_id: Number(MIGRATED) },
});

describe("telegram error classes", () => {
  it("retries network, 429, 5xx, and chat migration, and keeps unrecoverable 4xx permanent", () => {
    expect(classifyTelegramFailure(undefined, "").reason).toBe("network");
    expect(classifyTelegramFailure(429, "rate").errorClass).toBe("transient");
    expect(classifyTelegramFailure(503, "down").errorClass).toBe("transient");
    expect(classifyTelegramFailure(400, MIGRATION_BODY)).toMatchObject({
      errorClass: "transient",
      reason: "chat_migrated",
    });
    expect(readTelegramMigrateToChatId(MIGRATION_BODY)).toBe(MIGRATED);
    expect(classifyTelegramFailure(400, "Bad Request: message is too long").errorClass).toBe(
      "permanent",
    );
    expect(classifyTelegramFailure(401, "Unauthorized").errorClass).toBe("operator_action");
    expect(classifyTelegramFailure(403, "Forbidden").errorClass).toBe("operator_action");
  });
});

describe("telegram chat migration delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-migrate-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  function listing(sourceId: string, publishedAt: Date): Listing {
    return {
      source: "domria",
      sourceId,
      url: `https://dom.ria.com/uk/realty-${sourceId}.html`,
      title: "Квартира <центр>",
      price: { amount: 15000, currency: "UAH", period: "month" },
      location: { raw: "Львів, вул. Зелена", city: "Львів", latitude: 49.84, longitude: 24.03 },
      propertyType: "apartment",
      sellerType: "owner",
      sellerEvidence: ["platform owner"],
      discoveredAt: publishedAt,
      publishedAt,
      metadata: { ownerEvidenceLevel: "confirmed" },
    };
  }

  function config() {
    return loadConfig({
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
      GEO_UNKNOWN_POLICY: "exclude",
      FIRST_RUN_MODE: "seed",
      TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
    });
  }

  function adapter(items: Listing[]): ListingSourceAdapter {
    return {
      source: "domria",
      fetchLatest: async () => items,
      inspectLatest: async () => ({
        listings: items,
        transport: "test",
        dataKind: "MOCK DATA",
        resultKind: "ok",
        health: { source: "domria", healthy: true, checkedAt: new Date("2026-09-21T00:00:00.000Z") },
      }),
      healthCheck: async () => ({
        source: "domria",
        healthy: true,
        checkedAt: new Date("2026-09-21T00:00:00.000Z"),
      }),
    };
  }

  function sink(responses: Array<{ status: number; body: string }>, chatIds: string[]) {
    let n = 0;
    return new TelegramTestSink({
      botToken: "123456:test-token",
      chatId: CONFIGURED,
      testMode: true,
      dryRun: false,
      timeoutMs: 1000,
      maxRetries: 1,
      sleep: async () => undefined,
      fetchImpl: async (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as { chat_id: string };
        chatIds.push(String(payload.chat_id));
        const response = responses[Math.min(n, responses.length - 1)]!;
        n += 1;
        return new Response(response.body, { status: response.status });
      },
    });
  }

  it("keeps a confirmed owner tag off OLX Private and still formats a sparse card", () => {
    const html = formatListingTelegramHtml({
      source: "olx",
      sourceId: "1",
      url: "https://www.olx.ua/d/uk/obyavlenie/a-ID1.html",
      title: "Оренда",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "unknown",
      discoveredAt: new Date("2026-09-21T00:00:00.000Z"),
      metadata: { ownerEvidenceLevel: "private_unknown" },
    });
    expect(html).toContain("OLX");
    expect(html).toContain("Оренда");
    expect(html).toContain("#OWNER_UNVERIFIED");
    expect(html).not.toContain("#OWNER_CONFIRMED");
    expect(html).toContain("https://www.olx.ua/d/uk/obyavlenie/a-ID1.html");
  });

  it("retries the same outbox row on the migrated chat and marks it sent only after success", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const chatIds: string[] = [];
    const telegram = sink(
      [
        { status: 400, body: MIGRATION_BODY },
        { status: 200, body: "{}" },
      ],
      chatIds,
    );
    telegram.setChatMigrationHandler((chatId) => store.rememberTelegramChatId(chatId));
    const old = listing("old", new Date("2026-09-01T00:00:00.000Z"));
    const fresh = listing("fresh", new Date("2026-09-21T11:00:00.000Z"));
    const seed = await runTelegramTestCycle(
      {
        adapters: [adapter([old])],
        config: config(),
        sink: telegram,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-20T12:00:00.000Z"),
      },
      1,
    );
    expect(seed.sentOk).toBe(0);
    expect(chatIds).toHaveLength(0);

    const sent = await runTelegramTestCycle(
      {
        adapters: [adapter([old, fresh])],
        config: config(),
        sink: telegram,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-21T12:00:00.000Z"),
      },
      2,
    );
    expect(sent.sentOk).toBe(1);
    expect(chatIds).toEqual([CONFIGURED, MIGRATED]);
    expect(store.readTelegramChatId()).toBe(MIGRATED);
    const rows = getDb().prepare("SELECT status FROM telegram_outbox").all() as Array<{ status: string }>;
    expect(rows).toEqual([{ status: "sent" }]);
  });

  it("keeps the migrated row retryable when the redirected send fails, including across restart", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const chatIds: string[] = [];
    const failing = sink(
      [
        { status: 400, body: MIGRATION_BODY },
        { status: 503, body: "unavailable" },
      ],
      chatIds,
    );
    failing.setChatMigrationHandler((chatId) => store.rememberTelegramChatId(chatId));
    store.establishSilent("domria", [], store, new Date("2026-09-20T12:00:00.000Z"));
    const fresh = listing("fresh", new Date("2026-09-21T12:00:00.000Z"));
    const first = await runTelegramTestCycle(
      {
        adapters: [adapter([fresh])],
        config: config(),
        sink: failing,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date("2026-09-21T12:00:00.000Z"),
      },
      1,
    );
    expect(first.sentOk).toBe(0);
    expect(first.sentFailed).toBe(1);
    expect(store.readTelegramChatId()).toBe(MIGRATED);
    const pending = getDb().prepare("SELECT id, status, error_class AS errorClass FROM telegram_outbox").all() as Array<{
      id: number;
      status: string;
      errorClass: string;
    }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("failed");
    expect(pending[0]?.errorClass).toBe("transient");

    closeDb();
    const reopened = new DurableDeliveryStore(getDb(path));
    expect(reopened.readTelegramChatId()).toBe(MIGRATED);
    const retryIds: string[] = [];
    const recovering = sink([{ status: 200, body: "{}" }], retryIds);
    recovering.useChatId(reopened.readTelegramChatId() ?? CONFIGURED);
    const second = await runTelegramTestCycle(
      {
        adapters: [adapter([fresh])],
        config: config(),
        sink: recovering,
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date("2026-09-21T12:05:00.000Z"),
      },
      2,
    );
    expect(second.sentOk).toBe(1);
    expect(retryIds).toEqual([MIGRATED]);
    const rows = getDb().prepare("SELECT status FROM telegram_outbox").all() as Array<{ status: string }>;
    expect(rows).toEqual([{ status: "sent" }]);
  });
});
