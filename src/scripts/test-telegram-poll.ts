/**
 * TEST Telegram polling with local SQLite durability.
 *
 * Requires TELEGRAM_TEST_MODE=true + TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 *
 * Env:
 *   TELEGRAM_POLL_CYCLES       default 6; 0 = unbounded (systemd)
 *   TELEGRAM_POLL_INTERVAL_MS  default 600000
 *   TELEGRAM_DRY_RUN=true      optional
 *   FIRST_RUN_MODE=seed|preview  (send→preview; default seed = silent baseline)
 *   DATABASE_PATH              local SQLite file
 *   HEARTBEAT_PATH             optional JSON heartbeat file
 *
 * Retention cleanup runs once on startup and then at most once every 24 hours.
 */

import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { getConfig } from "../config/env.ts";
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
import { createCollectionAdapters } from "../collection/create-source-adapters.ts";
import { openDurableRuntime, PollerLockError } from "../storage/durable-runtime.ts";
import { writeHeartbeat } from "../storage/heartbeat.ts";
import { waitMsUntilNextPollStart } from "../delivery/poll-cadence.ts";
import { resolvePollProcessExitCode } from "../delivery/poll-process-exit.ts";
import { readOlxDisplayedPrices } from "../sources/olx/olx-display-price.ts";
import { runStateCleanupIfDue, STATE_RETENTION } from "../storage/state-retention.ts";

loadDotenv();

const rawCycles = process.env.TELEGRAM_POLL_CYCLES;
const unbounded = rawCycles === "0";
const cycles = unbounded ? 0 : Math.max(1, Number(rawCycles ?? "6") || 6);
const intervalMs = Math.max(
  0,
  Number(process.env.TELEGRAM_POLL_INTERVAL_MS ?? String(10 * 60_000)),
);

let stop = false;
let closeRuntime: (() => void) | undefined;

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
  const adapters = createCollectionAdapters(config);
  const runtime = openDurableRuntime({
    databasePath: config.databasePath,
    lockHolder: "telegram-poll",
  });
  closeRuntime = () => runtime.close();
  const heartbeatPath =
    process.env.HEARTBEAT_PATH ?? join(dirname(config.databasePath), "heartbeat.json");
  const dryRun = sink.dryRun;

  const startup = formatTelegramStartupMessage({
    chatId: sink.chatId,
    cycles,
    intervalMs,
    dryRun,
    enableDomria: config.enableDomria,
    enableLun: config.enableLun,
    enableRieltor: config.enableRieltor,
    enableOlx: config.enableOlx,
    enableOlxBrowser: config.enableOlxBrowser,
    ownerOnly: config.ownerOnly,
    ownerAcceptSelfDeclared: config.ownerAcceptSelfDeclared,
    sellerPolicy: config.sellerPolicy,
    firstRunMode: config.firstRunMode,
    durable: true,
  });

  console.log(
    JSON.stringify({
      message: "live:test-telegram:poll.start",
      cycles: unbounded ? 0 : cycles,
      unbounded,
      intervalMs,
      chatId: sink.chatId,
      dryRun,
      enableOlx: config.enableOlx,
      enableOlxBrowser: config.enableOlxBrowser,
      firstRunMode: config.firstRunMode,
      schemaVersion: runtime.schemaVersion,
      databasePath: config.databasePath,
      stateCleanupIntervalMs: STATE_RETENTION.cleanupIntervalMs,
      heartbeatPath,
      dedupeSurvivesRestart: true,
      baselineSurvivesRestart: true,
      restartRebaseline: false,
      note: "SQLite baseline/outbox. Per-source silent first-run seed. Token not logged.",
    }),
  );
  writeHeartbeat(heartbeatPath, {
    state: "started",
    pid: process.pid,
    schemaVersion: runtime.schemaVersion,
    unbounded,
    dryRun,
  });
  runtime.lock.heartbeat();

  const startupSend = await sink.sendText(startup);
  if (!startupSend.ok) {
    console.error(
      JSON.stringify({
        message: "live:test-telegram:poll.startup_notify_failed",
        error: startupSend.errorSafe,
      }),
    );
  }

  let operationalFailureObserved = false;
  let totalSentOk = 0;
  let totalSentFailed = 0;
  let totalNewAfterDedupe = 0;
  let sourceFailureCycles = 0;
  let zeroEligibleCycles = 0;
  let partialCoverageCycles = 0;
  let cyclesAttempted = 0;

  for (let cycle = 1; unbounded || cycle <= cycles; cycle += 1) {
    const cycleStartedMs = Date.now();
    if (stop) {
      console.log(JSON.stringify({ message: "live:test-telegram:poll.aborted", cycle }));
      break;
    }
    const cleanup = runStateCleanupIfDue(runtime.db, { databasePath: config.databasePath });
    if (cleanup.ran) {
      console.log(
        JSON.stringify({
          message: "live:test-telegram:poll.cleanup",
          seenRowsRemoved: cleanup.seenRowsRemoved,
          crossSourceIdentitiesRemoved: cleanup.crossSourceIdentitiesRemoved,
          sentOutboxRowsRemoved: cleanup.sentOutboxRowsRemoved,
          diagnosticRowsRemoved: cleanup.diagnosticRowsRemoved,
          durationMs: cleanup.durationMs,
          ...(cleanup.databaseBytes !== undefined ? { databaseBytes: cleanup.databaseBytes } : {}),
          finishedAt: cleanup.finishedAt,
        }),
      );
    }
    const report = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink,
        dedupe: runtime.store,
        baseline: runtime.store,
        outbox: runtime.store,
        enrichDisplayPrices: readOlxDisplayedPrices,
      },
      cycle,
    );
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
    runtime.lock.heartbeat();
    writeHeartbeat(heartbeatPath, {
      state: "cycle",
      pid: process.pid,
      cycle,
      sentOk: report.sentOk,
      sentFailed: report.sentFailed,
      deliveryMode: report.deliveryMode,
      hasSourceFailures: report.hasSourceFailures,
      dryRun: report.dryRun,
    });
    if (report.sentFailed > 0 || report.hasSourceFailures) {
      operationalFailureObserved = true;
    }
    const waitMs = waitMsUntilNextPollStart(Date.now() - cycleStartedMs, intervalMs);
    if ((unbounded || cycle < cycles) && !stop && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), waitMs);
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
    durable: true,
  });
  if (!stop) {
    const summarySend = await sink.sendText(summaryText);
    if (!summarySend.ok) {
      operationalFailureObserved = true;
      console.error(
        JSON.stringify({
          message: "live:test-telegram:poll.summary_notify_failed",
          error: summarySend.errorSafe,
        }),
      );
    }
  }

  writeHeartbeat(heartbeatPath, {
    state: stop ? "stopped" : "done",
    pid: process.pid,
    cyclesAttempted,
    totalSentOk,
    totalSentFailed,
  });
  const processExitCode = resolvePollProcessExitCode({
    unbounded,
    gracefulStopRequested: stop,
    operationalFailureObserved,
  });
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
      dedupeSurvivesRestart: true,
      baselineSurvivesRestart: true,
      restartRebaseline: false,
      dryRun,
      operationalFailureObserved,
      gracefulStopRequested: stop,
      processExitCode,
    }),
  );
  process.exitCode = processExitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      message: "live:test-telegram:poll.failed",
      error: redactTelegramSecrets(message, process.env.TELEGRAM_BOT_TOKEN),
      testModeRequired: error instanceof TelegramTestModeError,
      concurrentPoller: error instanceof PollerLockError,
    }),
  );
  process.exitCode =
    error instanceof TelegramTestModeError ? 2 : error instanceof PollerLockError ? 3 : 1;
} finally {
  closeRuntime?.();
}
