/**
 * One-shot TEST Telegram delivery.
 *
 * Default FIRST_RUN_MODE=seed → silent per-source baseline (no «нове» flood).
 * FIRST_RUN_MODE=preview → small «Початкова добірка» sample only.
 *
 * Requires:
 *   TELEGRAM_TEST_MODE=true
 *   TELEGRAM_BOT_TOKEN=...
 *   TELEGRAM_CHAT_ID=...
 *
 * Durability: local SQLite (DATABASE_PATH). Concurrent oneshot/poll is rejected.
 */

import { config as loadDotenv } from "dotenv";
import { getConfig } from "../config/env.ts";
import { runTelegramTestCycle } from "../delivery/telegram-test-pipeline.ts";
import {
  createTelegramTestSinkFromEnv,
  redactTelegramSecrets,
  TelegramTestModeError,
} from "../outputs/telegram-test.sink.ts";
import { createCollectionAdapters } from "../collection/create-source-adapters.ts";
import { openDurableRuntime, PollerLockError } from "../storage/durable-runtime.ts";

loadDotenv();

let closeRuntime: (() => void) | undefined;

const shutdown = () => {
  closeRuntime?.();
  closeRuntime = undefined;
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  const config = getConfig();
  const sink = createTelegramTestSinkFromEnv(process.env, {
    timeoutMs: config.sourceTimeoutMs,
    maxRetries: 2,
  });
  const adapters = createCollectionAdapters(config);
  const runtime = openDurableRuntime({
    databasePath: config.databasePath,
    lockHolder: "telegram-oneshot",
  });
  closeRuntime = () => runtime.close();

  console.log(
    JSON.stringify({
      message: "live:test-telegram.start",
      chatId: sink.chatId,
      dryRun: sink.dryRun,
      ownerOnly: config.ownerOnly,
      sellerPolicy: config.sellerPolicy,
      firstRunMode: config.firstRunMode,
      enableDomria: config.enableDomria,
      enableLun: config.enableLun,
      enableRieltor: config.enableRieltor,
      enableOlx: config.enableOlx,
      enableOlxBrowser: config.enableOlxBrowser,
      schemaVersion: runtime.schemaVersion,
      dedupeSurvivesRestart: true,
      baselineSurvivesRestart: true,
      restartRebaseline: false,
      note: "TEST mode. SQLite baseline/outbox. Token not logged.",
    }),
  );

  const report = await runTelegramTestCycle({
    adapters,
    config,
    sink,
    dedupe: runtime.store,
    baseline: runtime.store,
    outbox: runtime.store,
  });

  console.log(JSON.stringify({ message: "live:test-telegram.done", ...report }));
  process.exitCode = report.sentFailed > 0 ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      message: "live:test-telegram.failed",
      error: redactTelegramSecrets(message, process.env.TELEGRAM_BOT_TOKEN),
      testModeRequired: error instanceof TelegramTestModeError,
      concurrentPoller: error instanceof PollerLockError,
    }),
  );
  process.exitCode = error instanceof TelegramTestModeError ? 2 : error instanceof PollerLockError ? 3 : 1;
} finally {
  shutdown();
}
