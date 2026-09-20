/**
 * Controlled Telegram canary: exactly one marked test message.
 *
 * Never sends listing inventory. Off by default.
 *
 * Requires:
 *   TELEGRAM_TEST_MODE=true
 *   TELEGRAM_CANARY=true
 *   TELEGRAM_BOT_TOKEN=...
 *   TELEGRAM_CHAT_ID=...
 *
 * Uses TELEGRAM_CANARY_DATABASE_PATH (default: sibling rent-radar-canary.sqlite).
 * Refuses if that path equals DATABASE_PATH.
 */

import { config as loadDotenv } from "dotenv";
import { getConfig } from "../config/env.ts";
import {
  resolveCanaryDatabasePath,
  runTelegramCanary,
  TelegramCanaryError,
} from "../delivery/telegram-canary.ts";
import {
  createTelegramTestSinkFromEnv,
  redactTelegramSecrets,
  TelegramTestModeError,
} from "../outputs/telegram-test.sink.ts";
import { openDurableRuntime, PollerLockError } from "../storage/durable-runtime.ts";

loadDotenv();

let closeRuntime: (() => void) | undefined;
const shutdown = () => {
  closeRuntime?.();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  const config = getConfig();
  const databasePath = resolveCanaryDatabasePath(process.env);
  const sink = createTelegramTestSinkFromEnv(process.env, {
    timeoutMs: config.sourceTimeoutMs,
    maxRetries: 2,
  });
  const runtime = openDurableRuntime({
    databasePath,
    lockHolder: `telegram-canary:${process.pid}`,
  });
  closeRuntime = () => runtime.close();

  console.log(
    JSON.stringify({
      message: "live:test-telegram:canary.start",
      chatId: sink.chatId,
      dryRun: sink.dryRun,
      databasePath,
      note: "Single marked canary message. Inventory is not collected. Token not logged.",
    }),
  );

  const report = await runTelegramCanary({
    env: process.env,
    sink,
    db: runtime.db,
    databasePath,
  });

  console.log(
    JSON.stringify({
      message: "live:test-telegram:canary.done",
      sent: report.sent,
      alreadySent: report.alreadySent,
      dryRun: report.dryRun,
      chatId: report.chatId,
      databasePath: report.databasePath,
      marked: report.message.includes("CANARY — Rent Radar TEST"),
      ...(report.errorSafe ? { error: report.errorSafe } : {}),
    }),
  );
  process.exitCode = report.sent || report.alreadySent ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      message: "live:test-telegram:canary.failed",
      error: redactTelegramSecrets(message, process.env.TELEGRAM_BOT_TOKEN),
      testModeRequired: error instanceof TelegramTestModeError,
      canaryRequired: error instanceof TelegramCanaryError,
      concurrentPoller: error instanceof PollerLockError,
    }),
  );
  process.exitCode =
    error instanceof TelegramTestModeError || error instanceof TelegramCanaryError
      ? 2
      : error instanceof PollerLockError
        ? 3
        : 1;
} finally {
  shutdown();
}
