import type { Listing } from "../domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../domain/source.ts";
import type { AppConfig } from "../config/env.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { InMemoryListingDedupe } from "./listing-dedupe-memory.ts";
import {
  type TelegramSendResult,
  type TelegramTestSink,
} from "../outputs/telegram-test.sink.ts";

export type TelegramTestCycleReport = {
  cycle: number;
  startedAt: string;
  endedAt: string;
  collectedRaw: number;
  acceptedFiltered: number;
  newAfterDedupe: number;
  sentOk: number;
  sentFailed: number;
  dryRun: boolean;
  chatId: string;
  sourceErrors: Array<{ source: string; errorSafe: string }>;
  sendErrors: string[];
  zeroResult: boolean;
};

export type TelegramTestPipelineDeps = {
  adapters: ListingSourceAdapter[];
  config: AppConfig;
  sink: TelegramTestSink;
  dedupe: InMemoryListingDedupe;
  now?: () => Date;
};

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One collection cycle: inspect enabled adapters → filters → in-memory dedupe → TEST Telegram.
 * Source/send failures are isolated; the cycle always completes a report.
 */
export async function runTelegramTestCycle(
  deps: TelegramTestPipelineDeps,
  cycle = 1,
): Promise<TelegramTestCycleReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const sourceErrors: Array<{ source: string; errorSafe: string }> = [];
  const sendErrors: string[] = [];
  const rawListings: Listing[] = [];

  for (const adapter of deps.adapters) {
    const enabled =
      (adapter.source === "domria" && deps.config.enableDomria) ||
      (adapter.source === "lun" && deps.config.enableLun) ||
      (adapter.source === "olx" && deps.config.enableOlx) ||
      (adapter.source === "rieltor" && deps.config.enableRieltor);
    if (!enabled) {
      continue;
    }
    try {
      const result: SourceFetchResult = await adapter.inspectLatest({
        limit: 10,
        preferOwners: deps.config.ownerOnly,
      });
      rawListings.push(...result.listings);
    } catch (error) {
      sourceErrors.push({ source: adapter.source, errorSafe: safeError(error) });
    }
  }

  const filtered = applyListingFilters(rawListings, deps.config).filter(
    (item) => item.accepted && item.locationMatched,
  );
  const accepted = filtered.map((item) => item.listing);
  const fresh = deps.dedupe.takeNew(accepted);

  let sentOk = 0;
  let sentFailed = 0;
  let dryRun = false;

  for (const listing of fresh) {
    try {
      const result: TelegramSendResult = await deps.sink.sendListing(listing);
      dryRun = result.dryRun;
      if (result.ok) {
        sentOk += 1;
      } else {
        sentFailed += 1;
        if (result.errorSafe) {
          sendErrors.push(result.errorSafe);
        }
      }
    } catch (error) {
      sentFailed += 1;
      sendErrors.push(safeError(error));
    }
  }

  const endedAt = now();
  return {
    cycle,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    collectedRaw: rawListings.length,
    acceptedFiltered: accepted.length,
    newAfterDedupe: fresh.length,
    sentOk,
    sentFailed,
    dryRun,
    chatId: deps.sink.chatId,
    sourceErrors,
    sendErrors,
    zeroResult: fresh.length === 0,
  };
}
