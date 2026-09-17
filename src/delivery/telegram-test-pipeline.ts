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
  /** First observation batch for this process (inventory), not "new since last cycle". */
  initialInventoryCount: number;
  /** Listings actually offered for Telegram send this cycle. */
  newlyObservedCount: number;
  sentOk: number;
  sentFailed: number;
  dryRun: boolean;
  chatId: string;
  deliveryMode: "inventory_seed" | "send_new" | "send_initial";
  sourceAttempts: TelegramSourceAttempt[];
  sourceErrors: Array<{ source: string; errorSafe: string }>;
  sendErrors: string[];
  zeroResult: boolean;
  /** true when zero new listings AND no source hard-failures */
  zeroEligibleListings: boolean;
  /** true when at least one enabled source failed */
  hasSourceFailures: boolean;
  /** Enabled sources that did not contribute ok/valid_empty this cycle */
  partialCoverage: boolean;
  dedupeSurvivesRestart: false;
};

export type TelegramTestPipelineDeps = {
  adapters: ListingSourceAdapter[];
  config: AppConfig;
  sink: TelegramTestSink;
  dedupe: InMemoryListingDedupe;
  now?: () => Date;
  /**
   * When true (default first cycle of a poll process with FIRST_RUN_MODE=seed):
   * mark accepted listings seen without sending — baseline inventory.
   */
  seedInventory?: boolean;
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
      ? "http_adapter_only — on Oracle this is typically CloudFront 403; browser extract is opt-in and separate"
      : "disabled — OLX HTTP blocked on Oracle; browser extract is opt-in and does not feed Telegram until proven";
  }
  if (source === "domria") {
    return "http_html_or_official_api";
  }
  if (source === "lun" || source === "rieltor") {
    return "http_html";
  }
  return "http";
}

function classifySourceAttempt(result: SourceFetchResult): {
  ok: boolean;
  resultKind: string;
  errorSafe?: string;
} {
  const kind = result.resultKind ?? "unknown";
  if (kind === "ok" && result.listings.length > 0) {
    return { ok: true, resultKind: kind };
  }
  if (kind === "valid_empty") {
    return { ok: true, resultKind: kind };
  }
  if (result.httpStatus === 403 || result.httpStatus === 429) {
    return {
      ok: false,
      resultKind: kind === "http_error" ? "transport_blocked" : kind,
      errorSafe: `transport_blocked HTTP ${result.httpStatus} via ${result.transport}`,
    };
  }
  if (kind === "parser_failure") {
    return {
      ok: false,
      resultKind: kind,
      errorSafe: result.health.message ?? "parser_failure",
    };
  }
  if (kind === "disabled") {
    return { ok: false, resultKind: kind, errorSafe: "disabled" };
  }
  return {
    ok: false,
    resultKind: kind,
    ...(result.health.message ? { errorSafe: safeError(result.health.message) } : {}),
  };
}

/**
 * One collection cycle: inspect enabled adapters → filters → in-memory dedupe → TEST Telegram.
 * Source/send failures are isolated; the cycle always completes a report.
 * Failed sends do not mark listings delivered.
 * OLX uses the HTTP adapter only when ENABLE_OLX=true — not the Playwright browser extract.
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

  // Caller (poll script) must set seedInventory explicitly for cycle-1 baseline.
  const seedInventory = deps.seedInventory === true;

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
        resultKind: "disabled",
      });
      continue;
    }

    try {
      const result: SourceFetchResult = await adapter.inspectLatest({
        limit: 10,
        preferOwners: deps.config.ownerOnly,
      });
      rawListings.push(...result.listings);
      const classified = classifySourceAttempt(result);
      sourceAttempts.push({
        source: adapter.source,
        enabled: true,
        transport: result.transport,
        capability,
        ok: classified.ok,
        listingCount: result.listings.length,
        resultKind: classified.resultKind,
        ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        ...(classified.errorSafe ? { errorSafe: classified.errorSafe } : {}),
      });
      if (!classified.ok && classified.errorSafe) {
        sourceErrors.push({ source: adapter.source, errorSafe: classified.errorSafe });
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
        resultKind: "parser_failed",
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
  const fresh = deps.dedupe.filterUnseen(accepted);

  let sentOk = 0;
  let sentFailed = 0;
  let dryRun = false;
  let initialInventoryCount = 0;
  let newlyObservedCount = 0;
  const deliveryMode: TelegramTestCycleReport["deliveryMode"] = seedInventory
    ? "inventory_seed"
    : cycle === 1
      ? "send_initial"
      : "send_new";

  if (seedInventory) {
    initialInventoryCount = fresh.length;
    for (const listing of fresh) {
      deps.dedupe.markSeen(listing);
    }
  } else {
    if (cycle === 1) {
      initialInventoryCount = fresh.length;
    } else {
      newlyObservedCount = fresh.length;
    }
    for (const listing of fresh) {
      try {
        const result: TelegramSendResult = await deps.sink.sendListing(listing, {
          observationKind: cycle === 1 ? "initial_inventory" : "newly_observed",
        });
        dryRun = result.dryRun;
        if (result.ok) {
          deps.dedupe.markSeen(listing);
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
  }

  const endedAt = now();
  const enabledAttempts = sourceAttempts.filter((s) => s.enabled);
  const hasSourceFailures = enabledAttempts.some((s) => !s.ok);
  const partialCoverage =
    enabledAttempts.length > 0 && enabledAttempts.some((s) => s.ok) && hasSourceFailures;

  return {
    cycle,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    collectedRaw: rawListings.length,
    acceptedFiltered: accepted.length,
    newAfterDedupe: fresh.length,
    initialInventoryCount,
    newlyObservedCount,
    sentOk,
    sentFailed,
    dryRun,
    chatId: deps.sink.chatId,
    deliveryMode,
    sourceAttempts,
    sourceErrors,
    sendErrors,
    zeroResult: fresh.length === 0,
    zeroEligibleListings: fresh.length === 0 && !hasSourceFailures,
    hasSourceFailures,
    partialCoverage,
    dedupeSurvivesRestart: false,
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
  firstRunMode: "seed" | "send";
}): string {
  return [
    "🧪 <b>TEST Telegram poll starting</b>",
    `chat_id: ${input.chatId}`,
    `cycles: ${input.cycles} · interval_ms: ${input.intervalMs}`,
    `dry_run: ${input.dryRun}`,
    `owner_only: ${input.ownerOnly}`,
    `first_run_mode: ${input.firstRunMode} (seed = cycle-1 inventory without listing sends)`,
    `sources: domria=${input.enableDomria} lun=${input.enableLun} rieltor=${input.enableRieltor} olx_http=${input.enableOlx}`,
    "OLX browser extract is NOT used for Telegram delivery until a live Oracle extraction check passes.",
    "Dedupe is in-memory only — does not survive process restart.",
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
  partialCoverageCycles: number;
  dryRun: boolean;
}): string {
  return [
    "🧪 <b>TEST Telegram poll finished</b>",
    `cycles: ${input.cyclesAttempted}`,
    `new_eligible_listings: ${input.totalNewAfterDedupe}`,
    `sent_ok: ${input.totalSentOk} · sent_failed: ${input.totalSentFailed}`,
    `cycles_with_source_failures: ${input.sourceFailureCycles}`,
    `cycles_with_partial_source_coverage: ${input.partialCoverageCycles}`,
    `cycles_with_zero_eligible_listings: ${input.zeroEligibleCycles}`,
    `dry_run: ${input.dryRun}`,
    "Partial coverage means some enabled sources failed while others returned ok/valid_empty.",
    "disabled / transport_blocked / parser_failed / valid_empty are reported per source — not conflated.",
    "Dedupe did not survive restart (in-memory).",
  ].join("\n");
}
