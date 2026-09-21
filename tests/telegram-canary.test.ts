import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANARY_MESSAGE_MARKER,
  resolveCanaryDatabasePath,
  runTelegramCanary,
  TelegramCanaryError,
} from "../src/delivery/telegram-canary.ts";
import { TelegramTestModeError, TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";

const requiredEnv = {
  TELEGRAM_TEST_MODE: "true",
  TELEGRAM_CANARY: "true",
  TELEGRAM_BOT_TOKEN: "123:canary-token-not-real",
  TELEGRAM_CHAT_ID: "424242",
};

function sink(fetchImpl: typeof fetch, dryRun = false): TelegramTestSink {
  return new TelegramTestSink({
    botToken: requiredEnv.TELEGRAM_BOT_TOKEN,
    chatId: requiredEnv.TELEGRAM_CHAT_ID,
    testMode: true,
    dryRun,
    timeoutMs: 1000,
    maxRetries: 0,
    fetchImpl,
  });
}

describe("Telegram canary guards", () => {
  afterEach(() => {
    closeDb();
  });

  it("refuses when TELEGRAM_TEST_MODE is not exact true", async () => {
    await expect(
      runTelegramCanary({
        env: { ...requiredEnv, TELEGRAM_TEST_MODE: "True" },
        sink: sink(vi.fn() as unknown as typeof fetch),
        db: getDb(join(mkdtempSync(join(tmpdir(), "canary-")), "c.sqlite")),
        databasePath: "c.sqlite",
      }),
    ).rejects.toBeInstanceOf(TelegramTestModeError);
  });

  it("refuses when TELEGRAM_CANARY is missing or not exact true", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "canary-")), "c.sqlite");
    const db = getDb(dbPath);
    await expect(
      runTelegramCanary({
        env: {
          TELEGRAM_TEST_MODE: requiredEnv.TELEGRAM_TEST_MODE,
          TELEGRAM_BOT_TOKEN: requiredEnv.TELEGRAM_BOT_TOKEN,
          TELEGRAM_CHAT_ID: requiredEnv.TELEGRAM_CHAT_ID,
        },
        sink: sink(vi.fn() as unknown as typeof fetch),
        db,
        databasePath: dbPath,
      }),
    ).rejects.toBeInstanceOf(TelegramCanaryError);
    await expect(
      runTelegramCanary({
        env: { ...requiredEnv, TELEGRAM_CANARY: "1" },
        sink: sink(vi.fn() as unknown as typeof fetch),
        db,
        databasePath: dbPath,
      }),
    ).rejects.toBeInstanceOf(TelegramCanaryError);
  });

  it("refuses a canary database that equals the inventory DATABASE_PATH", () => {
    expect(() =>
      resolveCanaryDatabasePath({
        DATABASE_PATH: "./data/rent-radar.sqlite",
        TELEGRAM_CANARY_DATABASE_PATH: "./data/rent-radar.sqlite",
      }),
    ).toThrow(TelegramCanaryError);
  });

  it("defaults to a sibling canary sqlite file, not the inventory DB", () => {
    const inventory = "./data/rent-radar.sqlite";
    expect(resolveCanaryDatabasePath({ DATABASE_PATH: inventory })).toBe(
      join(dirname(inventory), "rent-radar-canary.sqlite"),
    );
    expect(resolveCanaryDatabasePath({ DATABASE_PATH: inventory })).not.toBe(inventory);
  });
});

describe("Telegram canary exactly-once", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-canary-"));

  afterEach(() => {
    closeDb();
  });

  it("sends exactly one marked message and never a listing", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string; chat_id: string };
      expect(body.text).toContain(CANARY_MESSAGE_MARKER);
      expect(body.text).toContain("not a listing");
      expect(body.text).not.toMatch(/dom\.ria|lun\.ua|olx\.ua|rieltor\.ua/i);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const databasePath = join(dir, "first.sqlite");
    const db = getDb(databasePath);
    const first = await runTelegramCanary({
      env: requiredEnv,
      sink: sink(fetchImpl as unknown as typeof fetch),
      db,
      databasePath,
      now: () => new Date("2026-09-20T20:00:00.000Z"),
    });
    expect(first.sent).toBe(true);
    expect(first.alreadySent).toBe(false);
    expect(first.dryRun).toBe(false);
    expect(first.message).toContain(CANARY_MESSAGE_MARKER);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await runTelegramCanary({
      env: requiredEnv,
      sink: sink(fetchImpl as unknown as typeof fetch),
      db,
      databasePath,
    });
    expect(second.sent).toBe(false);
    expect(second.alreadySent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not mark sent when Telegram fails, so a retry remains possible", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const databasePath = join(dir, "fail.sqlite");
    const db = getDb(databasePath);
    const failed = await runTelegramCanary({
      env: requiredEnv,
      sink: sink(fetchImpl as unknown as typeof fetch),
      db,
      databasePath,
    });
    expect(failed.sent).toBe(false);
    expect(failed.alreadySent).toBe(false);
    expect(failed.errorSafe).toBeTruthy();
    expect(failed.errorSafe).not.toContain(requiredEnv.TELEGRAM_BOT_TOKEN);

    const okFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const retry = await runTelegramCanary({
      env: requiredEnv,
      sink: sink(okFetch as unknown as typeof fetch),
      db,
      databasePath,
    });
    expect(retry.sent).toBe(true);
    expect(okFetch).toHaveBeenCalledTimes(1);
  });
});
