import type { Listing } from "../domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../domain/source.ts";
import type { AppConfig } from "../config/env.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { InMemoryListingDedupe } from "./listing-dedupe-memory.ts";
import { type TelegramSendResult, type TelegramTestSink } from "../outputs/telegram-test.sink.ts";

export type TelegramSourceAttempt = {
  source: string;
  enabled: boolean;
  transport: string;
  /** honest capability note for operators */
  capability: string;
  ok: boolean;
  listingCount: number;
  resultKind?: string;
  httpStatus?: number;
  errorSafe?: string;
};

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
  sourceAttempts: TelegramSourceAttempt[];
  sourceErrors: Array<{ source: string; errorSafe: string }>;
  sendErrors: string[];
  zeroResult: boolean;
  /** true when zero new listings AND no source hard-failures */
  zeroEligibleListings: boolean;
  /** true when at least one enabled source failed */
  hasSourceFailures: boolean;
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

function capabilityFor(source: string, enabled: boolean, config: AppConfig): string {
  if (!enabled) {
    return "disabled_by_config";
  }
  if (source === "olx") {
    return config.enableOlx
      ? "http_adapter_only — on Oracle this is typically CloudFront 403; browser_accessible≠deliverable listings"
      : "disabled — OLX HTTP blocked on Oracle; browser probe is soak-only and does not feed Telegram";
  }
  if (source === "domria") {
    return "http_html_or_official_api";
  }
  if (source === "lun" || source === "rieltor") {
    return "http_html";
  }
  return "http";
}

/**
 * One collection cycle: inspect enabled adapters → filters → in-memory dedupe → TEST Telegram.
 * Source/send failures are isolated; the cycle always completes a report.
 * OLX uses the HTTP adapter only when ENABLE_OLX=true — not the Playwright browser probe.
 */
export async function runTelegramTestCycle(
  deps: TelegramTestPipelineDeps,
  cycle = 1,
): Promise<TelegramTestCycleReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const sourceErrors: Array<{ source: string; errorSafe: string }> = [];
  const sourceAttempts: TelegramSourceAttempt[] = [];
  const sendErrors: string[] = [];
  const rawListings: Listing[] = [];

  for (const adapter of deps.adapters) {
    const enabled =
      (adapter.source === "domria" && deps.config.enableDomria) ||
      (adapter.source === "lun" && deps.config.enableLun) ||
      (adapter.source === "olx" && deps.config.enableOlx) ||
      (adapter.source === "rieltor" && deps.config.enableRieltor);

    const capability = capabilityFor(adapter.source, enabled, deps.config);
    if (!enabled) {
      sourceAttempts.push({
        source: adapter.source,
        enabled: false,
        transport: "n/a",
        capability,
        ok: false,
        listingCount: 0,
      });
      continue;
    }

    try {
      const result: SourceFetchResult = await adapter.inspectLatest({
        limit: 10,
        preferOwners: deps.config.ownerOnly,
      });
      rawListings.push(...result.listings);
      const ok =
        (result.resultKind === "ok" && result.listings.length > 0) || result.resultKind === "valid_empty";
      sourceAttempts.push({
        source: adapter.source,
        enabled: true,
        transport: result.transport,
        capability,
        ok,
        listingCount: result.listings.length,
        ...(result.resultKind !== undefined ? { resultKind: result.resultKind } : {}),
        ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        ...(!ok && result.health.message ? { errorSafe: safeError(result.health.message) } : {}),
      });
      if (!ok && result.httpStatus === 403) {
        sourceErrors.push({
          source: adapter.source,
          errorSafe: `transport_blocked HTTP 403 via ${result.transport}`,
        });
      } else if (!ok && result.health.message) {
        sourceErrors.push({ source: adapter.source, errorSafe: safeError(result.health.message) });
      }
    } catch (error) {
      const errorSafe = safeError(error);
      sourceErrors.push({ source: adapter.source, errorSafe });
      sourceAttempts.push({
        source: adapter.source,
        enabled: true,
        transport: "n/a",
        capability,
        ok: false,
        listingCount: 0,
        errorSafe,
      });
    }
  }

  const filtered = applyListingFilters(rawListings, deps.config).filter(
    (item) => item.accepted && item.locationMatched,
  );
  // Owner-only: never deliver unknown/agent/business as if they were verified owners.
  const accepted = filtered
    .map((item) => item.listing)
    .filter((listing) => !deps.config.ownerOnly || listing.sellerType === "owner");
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
  const hasSourceFailures = sourceAttempts.some((s) => s.enabled && !s.ok);
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
    sourceAttempts,
    sourceErrors,
    sendErrors,
    zeroResult: fresh.length === 0,
    zeroEligibleListings: fresh.length === 0 && !hasSourceFailures,
    hasSourceFailures,
  };
}

export function formatTelegramStartupMessage(input: {
  chatId: string;
  cycles: number;
  intervalMs: number;
  dryRun: boolean;
  enableDomria: boolean;
  enableLun: boolean;
  enableRieltor: boolean;
  enableOlx: boolean;
  ownerOnly: boolean;
}): string {
  return [
    "🧪 <b>TEST Telegram poll starting</b>",
    `chat_id: ${input.chatId}`,
    `cycles: ${input.cycles} · interval_ms: ${input.intervalMs}`,
    `dry_run: ${input.dryRun}`,
    `owner_only: ${input.ownerOnly}`,
    `sources: domria=${input.enableDomria} lun=${input.enableLun} rieltor=${input.enableRieltor} olx_http=${input.enableOlx}`,
    "OLX browser probe is NOT used for Telegram delivery.",
    "Unknown sellers are never labeled as verified owners.",
  ].join("\n");
}

export function formatTelegramFinalSummary(input: {
  cyclesAttempted: number;
  totalSentOk: number;
  totalSentFailed: number;
  totalNewAfterDedupe: number;
  sourceFailureCycles: number;
  zeroEligibleCycles: number;
  dryRun: boolean;
}): string {
  return [
    "🧪 <b>TEST Telegram poll finished</b>",
    `cycles: ${input.cyclesAttempted}`,
    `new_eligible_listings: ${input.totalNewAfterDedupe}`,
    `sent_ok: ${input.totalSentOk} · sent_failed: ${input.totalSentFailed}`,
    `cycles_with_source_failures: ${input.sourceFailureCycles}`,
    `cycles_with_zero_eligible_listings: ${input.zeroEligibleCycles}`,
    `dry_run: ${input.dryRun}`,
    "Source failures are distinct from zero new listings.",
  ].join("\n");
}
