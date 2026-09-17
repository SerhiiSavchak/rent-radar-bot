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
import {
  formatTelegramFinalSummary,
  formatTelegramStartupMessage,
  runTelegramTestCycle,
} from "../delivery/telegram-test-pipeline.ts";
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
  const dryRun = process.env.TELEGRAM_DRY_RUN === "true";

  const startup = formatTelegramStartupMessage({
    chatId: sink.chatId,
    cycles,
    intervalMs,
    dryRun,
    enableDomria: config.enableDomria,
    enableLun: config.enableLun,
    enableRieltor: config.enableRieltor,
    enableOlx: config.enableOlx,
    ownerOnly: config.ownerOnly,
    firstRunMode: config.firstRunMode,
  });

  console.log(
    JSON.stringify({
      message: "live:test-telegram:poll.start",
      cycles,
      intervalMs,
      chatId: sink.chatId,
      dryRun,
      enableOlx: config.enableOlx,
      firstRunMode: config.firstRunMode,
      dedupeSurvivesRestart: false,
      note: "Bounded poll only. OLX browser extract is opt-in and not a Telegram transport. Token not logged.",
    }),
  );

  const startupSend = await sink.sendText(startup);
  if (!startupSend.ok) {
    console.error(
      JSON.stringify({
        message: "live:test-telegram:poll.startup_notify_failed",
        error: startupSend.errorSafe,
      }),
    );
  }

  let exitFail = false;
  let totalSentOk = 0;
  let totalSentFailed = 0;
  let totalNewAfterDedupe = 0;
  let sourceFailureCycles = 0;
  let zeroEligibleCycles = 0;
  let partialCoverageCycles = 0;
  let cyclesAttempted = 0;
  let inventorySeeded = false;

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    if (stop) {
      console.log(JSON.stringify({ message: "live:test-telegram:poll.aborted", cycle }));
      break;
    }
    const seedInventory = !inventorySeeded && config.firstRunMode === "seed";
    const report = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink,
        dedupe,
        seedInventory,
      },
      cycle,
    );
    if (seedInventory) {
      inventorySeeded = true;
    }
    cyclesAttempted += 1;
    totalSentOk += report.sentOk;
    totalSentFailed += report.sentFailed;
    totalNewAfterDedupe += report.newAfterDedupe;
    if (report.hasSourceFailures) {
      sourceFailureCycles += 1;
    }
    if (report.partialCoverage) {
      partialCoverageCycles += 1;
    }
    if (report.zeroEligibleListings) {
      zeroEligibleCycles += 1;
    }
    console.log(JSON.stringify({ message: "live:test-telegram:poll.cycle", ...report }));
    if (report.sentFailed > 0 || report.hasSourceFailures) {
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

  const summaryText = formatTelegramFinalSummary({
    cyclesAttempted,
    totalSentOk,
    totalSentFailed,
    totalNewAfterDedupe,
    sourceFailureCycles,
    zeroEligibleCycles,
    partialCoverageCycles,
    dryRun,
  });
  const summarySend = await sink.sendText(summaryText);
  if (!summarySend.ok) {
    exitFail = true;
    console.error(
      JSON.stringify({
        message: "live:test-telegram:poll.summary_notify_failed",
        error: summarySend.errorSafe,
      }),
    );
  }

  console.log(
    JSON.stringify({
      message: "live:test-telegram:poll.done",
      finishedAt: new Date().toISOString(),
      cyclesAttempted,
      totalSentOk,
      totalSentFailed,
      totalNewAfterDedupe,
      sourceFailureCycles,
      zeroEligibleCycles,
      partialCoverageCycles,
      dedupeSurvivesRestart: false,
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
