/**
 * Bounded TEST Telegram polling (not an always-on daemon).
 *
 * Requires TELEGRAM_TEST_MODE=true + TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 *
 * Env:
 *   TELEGRAM_POLL_CYCLES       default 6
 *   TELEGRAM_POLL_INTERVAL_MS  default 600000
 *   TELEGRAM_DRY_RUN=true      optional
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

const cycles = Math.max(1, Number(process.env.TELEGRAM_POLL_CYCLES ?? "6"));
const intervalMs = Math.max(0, Number(process.env.TELEGRAM_POLL_INTERVAL_MS ?? String(10 * 60_000)));

let stop = false;
const onSignal = () => {
  stop = true;
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

try {
  const config = getConfig();
  const sink = createTelegramTestSinkFromEnv(process.env, {
    timeoutMs: config.sourceTimeoutMs,
    maxRetries: 2,
  });
  const adapters = [new DomriaSource(), new LunSource(), new RieltorSource(), new OlxSource()];
  const dedupe = new InMemoryListingDedupe();

  console.log(
    JSON.stringify({
      message: "live:test-telegram:poll.start",
      cycles,
      intervalMs,
      chatId: sink.chatId,
      dryRun: process.env.TELEGRAM_DRY_RUN === "true",
      note: "Bounded poll only. Token not logged.",
    }),
  );

  let exitFail = false;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    if (stop) {
      console.log(JSON.stringify({ message: "live:test-telegram:poll.aborted", cycle }));
      break;
    }
    const report = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink,
        dedupe,
      },
      cycle,
    );
    console.log(JSON.stringify({ message: "live:test-telegram:poll.cycle", ...report }));
    if (report.sentFailed > 0) {
      exitFail = true;
    }
    if (cycle < cycles && !stop && intervalMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), intervalMs);
        const cancel = () => {
          clearTimeout(timer);
          resolve();
        };
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
      });
    }
  }

  console.log(
    JSON.stringify({
      message: "live:test-telegram:poll.done",
      finishedAt: new Date().toISOString(),
      exitFail,
    }),
  );
  process.exitCode = exitFail ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      message: "live:test-telegram:poll.failed",
      error: redactTelegramSecrets(message, process.env.TELEGRAM_BOT_TOKEN),
      testModeRequired: error instanceof TelegramTestModeError,
    }),
  );
  process.exitCode = error instanceof TelegramTestModeError ? 2 : 1;
}
