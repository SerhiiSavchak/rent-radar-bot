/**
 * Child-process reproduction for Node.js exit 13.
 * Vitest must not run this file: the parent test spawns it with tsx.
 * A passing run prints RRB_EXIT13 JSON and exits 0. The old httpGet exits 13.
 */
import { loadConfig } from "../../src/config/env.ts";
import { InMemoryListingDedupe } from "../../src/delivery/listing-dedupe-memory.ts";
import { InMemorySourceBaseline } from "../../src/delivery/source-baseline-memory.ts";
import { runTelegramTestCycle } from "../../src/delivery/telegram-test-pipeline.ts";
import type { ListingSource } from "../../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../../src/domain/source.ts";
import { TelegramTestSink } from "../../src/outputs/telegram-test.sink.ts";
import { AppError } from "../../src/utils/errors.ts";
import { httpGet } from "../../src/utils/http.ts";

const mode = process.argv[2] ?? "hang";
let unhandled = 0;
let fetchCalls = 0;
process.on("unhandledRejection", () => {
  unhandled += 1;
});

function report(payload: Record<string, unknown>): void {
  console.log(`RRB_EXIT13 ${JSON.stringify(payload)}`);
}

function emptyResult(source: ListingSource): SourceFetchResult {
  return {
    listings: [],
    transport: "fixture",
    dataKind: "FIXTURE DATA",
    resultKind: "valid_empty",
    health: {
      source,
      healthy: true,
      checkedAt: new Date(),
      resultKind: "valid_empty",
    },
  };
}

function adapter(
  source: ListingSource,
  inspectLatest: ListingSourceAdapter["inspectLatest"],
): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => (await inspectLatest()).listings,
    inspectLatest,
    healthCheck: async () => emptyResult(source).health,
  };
}

async function settleHttp(label: string): Promise<void> {
  try {
    await httpGet("https://lun.example/rent/lviv/flats", { timeoutMs: 150, maxRetries: 0 });
    report({ label, settled: true, code: "OK", fetchCalls, unhandled });
  } catch (error) {
    report({
      label,
      settled: true,
      code: error instanceof AppError ? error.code : "UNEXPECTED",
      name: error instanceof Error ? error.name : "unknown",
      fetchCalls,
      unhandled,
    });
  }
}

async function hang(): Promise<void> {
  globalThis.fetch = () => {
    fetchCalls += 1;
    return new Promise(() => undefined);
  };
  await settleHttp("hang");
}

async function body(): Promise<void> {
  globalThis.fetch = () => {
    fetchCalls += 1;
    return Promise.resolve(
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => undefined);
          },
        }),
      ),
    );
  };
  await settleHttp("body");
}

async function honored(): Promise<void> {
  globalThis.fetch = (_url, init) => {
    fetchCalls += 1;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  };
  await settleHttp("honored");
}

async function cycle(): Promise<void> {
  globalThis.fetch = () => {
    fetchCalls += 1;
    return new Promise(() => undefined);
  };
  const order: string[] = [];
  let telegramCalls = 0;
  const config = loadConfig({
    SELLER_POLICY: "reject_intermediaries",
    ENABLE_DOMRIA: "true",
    ENABLE_LUN: "true",
    ENABLE_OLX: "false",
    ENABLE_OLX_BROWSER: "true",
    ENABLE_RIELTOR: "false",
    PROPERTY_TYPES: "apartment,house",
    TARGET_LAT: "49.8397",
    TARGET_LNG: "24.0297",
    TARGET_RADIUS_KM: "15",
    GEO_UNKNOWN_POLICY: "exclude",
    FIRST_RUN_MODE: "seed",
  });
  const sink = new TelegramTestSink({
    botToken: "123:dry-run-token-not-real",
    chatId: "1",
    testMode: true,
    dryRun: true,
    timeoutMs: 1000,
    maxRetries: 0,
    fetchImpl: () => {
      telegramCalls += 1;
      return Promise.reject(new Error("telegram must not be called"));
    },
  });
  const reportCycle = await runTelegramTestCycle(
    {
      adapters: [
        adapter("domria", async () => {
          order.push("domria");
          return emptyResult("domria");
        }),
        adapter("lun", async () => {
          order.push("lun");
          await httpGet("https://lun.example/rent/lviv/flats", { timeoutMs: 150, maxRetries: 0 });
          order.push("lun-finished");
          return emptyResult("lun");
        }),
        adapter("olx", async () => {
          order.push("olx");
          return emptyResult("olx");
        }),
      ],
      config,
      sink,
      dedupe: new InMemoryListingDedupe(),
      baseline: new InMemorySourceBaseline(),
      now: () => new Date("2026-10-10T06:08:39.000Z"),
      firstRunMode: "seed",
    },
    389,
  );
  const lun = reportCycle.sourceAttempts.find((attempt) => attempt.source === "lun");
  const olx = reportCycle.sourceAttempts.find((attempt) => attempt.source === "olx");
  report({
    label: "cycle",
    settled: true,
    order,
    lunKind: lun?.resultKind ?? null,
    lunOk: lun?.ok ?? null,
    olxOk: olx?.ok ?? null,
    sentOk: reportCycle.sentOk,
    sentFailed: reportCycle.sentFailed,
    hasSourceFailures: reportCycle.hasSourceFailures,
    telegramCalls,
    fetchCalls,
    unhandled,
  });
}

const runners: Record<string, () => Promise<void>> = { hang, body, honored, cycle };
const run = runners[mode];
if (!run) {
  report({ settled: false, error: `unknown mode ${mode}` });
  process.exitCode = 2;
} else {
  await run();
  await new Promise((resolve) => setTimeout(resolve, 50));
  report({ label: `${mode}:drain`, unhandled, fetchCalls });
}
