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
 */

import { config as loadDotenv } from "dotenv";
import { getConfig } from "../config/env.ts";
import { InMemoryListingDedupe } from "../delivery/listing-dedupe-memory.ts";
import { InMemorySourceBaseline } from "../delivery/source-baseline-memory.ts";
import { runTelegramTestCycle } from "../delivery/telegram-test-pipeline.ts";
import {
  createTelegramTestSinkFromEnv,
  redactTelegramSecrets,
  TelegramTestModeError,
} from "../outputs/telegram-test.sink.ts";
import { createCollectionAdapters } from "../collection/create-source-adapters.ts";

loadDotenv();

try {
  const config = getConfig();
  const sink = createTelegramTestSinkFromEnv(process.env, {
    timeoutMs: config.sourceTimeoutMs,
    maxRetries: 2,
  });
  const adapters = createCollectionAdapters(config);

  console.log(
    JSON.stringify({
      message: "live:test-telegram.start",
      chatId: sink.chatId,
      dryRun: process.env.TELEGRAM_DRY_RUN === "true",
      ownerOnly: config.ownerOnly,
      firstRunMode: config.firstRunMode,
      enableDomria: config.enableDomria,
      enableLun: config.enableLun,
      enableRieltor: config.enableRieltor,
      enableOlx: config.enableOlx,
      enableOlxBrowser: config.enableOlxBrowser,
      note: "TEST mode. Default silent baseline. Token not logged.",
    }),
  );

  const report = await runTelegramTestCycle({
    adapters,
    config,
    sink,
    dedupe: new InMemoryListingDedupe(),
    baseline: new InMemorySourceBaseline(),
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
    }),
  );
  process.exitCode = error instanceof TelegramTestModeError ? 2 : 1;
}
