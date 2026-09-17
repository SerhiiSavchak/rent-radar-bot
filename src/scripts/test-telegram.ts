/**
 * One-shot TEST Telegram delivery.
 *
 * Requires:
 *   TELEGRAM_TEST_MODE=true
 *   TELEGRAM_BOT_TOKEN=...
 *   TELEGRAM_CHAT_ID=...
 * Optional:
 *   TELEGRAM_DRY_RUN=true
 *
 * Does not use production daemon/DB/scheduler. Does not alter Oracle soak.
 */

import { config as loadDotenv } from "dotenv";
import { getConfig } from "../config/env.ts";
import { InMemoryListingDedupe } from "../delivery/listing-dedupe-memory.ts";
import { runTelegramTestCycle } from "../delivery/telegram-test-pipeline.ts";
import {
  createTelegramTestSinkFromEnv,
  redactTelegramSecrets,
  TelegramTestModeError,
} from "../outputs/telegram-test.sink.ts";
import { DomriaSource } from "../sources/domria/domria.source.ts";
import { LunSource } from "../sources/lun/lun.source.ts";
import { OlxSource } from "../sources/olx/olx.source.ts";
import { RieltorSource } from "../sources/rieltor/rieltor.source.ts";

loadDotenv();

try {
  const config = getConfig();
  const sink = createTelegramTestSinkFromEnv(process.env, {
    timeoutMs: config.sourceTimeoutMs,
    maxRetries: 2,
  });
  const adapters = [new DomriaSource(), new LunSource(), new RieltorSource(), new OlxSource()];

  console.log(
    JSON.stringify({
      message: "live:test-telegram.start",
      chatId: sink.chatId,
      dryRun: process.env.TELEGRAM_DRY_RUN === "true",
      ownerOnly: config.ownerOnly,
      enableDomria: config.enableDomria,
      enableLun: config.enableLun,
      enableRieltor: config.enableRieltor,
      enableOlx: config.enableOlx,
      note: "TEST mode only. No always-on daemon. Token not logged.",
    }),
  );

  const report = await runTelegramTestCycle({
    adapters,
    config,
    sink,
    dedupe: new InMemoryListingDedupe(),
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
