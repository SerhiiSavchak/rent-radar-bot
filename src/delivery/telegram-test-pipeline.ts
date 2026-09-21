import type { Listing } from "../domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../domain/source.ts";
import { usesOwnerOnlySourceFilter, type AppConfig } from "../config/env.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { sellerDecisionBucket } from "../filters/owner-filter.ts";
import {
  classifyListingFreshness,
  defaultMaxPublicationAgeMinutes,
  withFirstSeenAt,
} from "./listing-freshness.ts";
import type {
  ListingDedupe,
  OutboxItem,
  SourceBaseline,
  TelegramOutbox,
} from "./delivery-ports.ts";
import { crossSourceOf, type CrossSourceDecision } from "./cross-source-dedup.ts";
import { annotateListing } from "./listing-annotations.ts";
import { type TelegramSendResult, type TelegramTestSink } from "../outputs/telegram-test.sink.ts";
import { isOlxCollectionEnabled } from "../collection/create-source-adapters.ts";
import { OLX_BROWSER_TRANSPORT } from "../sources/olx/olx-browser.source.ts";
import { logger } from "../utils/logger.ts";

export type TelegramSourceAttempt = {
  source: string;
  enabled: boolean;
  transport: string;
  capability: string;
  ok: boolean;
  listingCount: number;
  sellerAcceptedOwner?: number;
  sellerAcceptedSelfDeclared?: number;
  sellerAcceptedUnknown?: number;
  sellerRejectedIntermediary?: number;
  otherFilterRejected?: number;
  acceptedCount?: number;
  resultKind?: string;
  httpStatus?: number;
  errorSafe?: string;
  baselineEstablished?: boolean;
  baselineSkippedFailure?: boolean;
};

export type TelegramTestCycleReport = {
  cycle: number;
  startedAt: string;
  endedAt: string;
  collectedRaw: number;
  acceptedFiltered: number;
  sellerAcceptedOwner: number;
  sellerAcceptedSelfDeclared: number;
  sellerAcceptedUnknown: number;
  sellerRejectedIntermediary: number;
  otherFilterRejected: number;
  newAfterDedupe: number;
  initialInventoryCount: number;
  newlyObservedCount: number;
  sentOk: number;
  sentFailed: number;
  suppressedOld: number;
  suppressedRefreshedOld: number;
  suppressedUnknownStrict: number;
  suppressedLateDiscovered: number;
  suppressedCrossSourceDuplicate: number;
  crossSourceUncertainKept: number;
  crossSourceEvents: CrossSourceEvent[];
  dryRun: boolean;
  chatId: string;
  deliveryMode: "inventory_seed" | "initial_preview" | "send_new";
  sourceAttempts: TelegramSourceAttempt[];
  sourceErrors: Array<{ source: string; errorSafe: string }>;
  sendErrors: string[];
  zeroResult: boolean;
  zeroEligibleListings: boolean;
  hasSourceFailures: boolean;
  partialCoverage: boolean;
  dedupeSurvivesRestart: boolean;
  baselineSurvivesRestart: boolean;
  restartRebaseline: boolean;
};

export type TelegramTestPipelineDeps = {
  adapters: ListingSourceAdapter[];
  config: AppConfig;
  sink: TelegramTestSink;
  dedupe: ListingDedupe;
  baseline: SourceBaseline;
  outbox?: TelegramOutbox;
  now?: () => Date;
  /**
   * first-run behaviour for sources that do not yet have a baseline:
   * - seed (default): silent baseline, no listing sends
   * - preview: send a small labeled sample ("Початкова добірка")
   */
  firstRunMode?: "seed" | "preview";
  /** Max listings to send in preview mode (default 3). */
  initialPreviewLimit?: number;
  /** Exclude unknown publishedAt (default true). */
  strictNewPublications?: boolean;
};

export type CrossSourceEvent = {
  source: string;
  sourceId: string;
  verdict: CrossSourceDecision["verdict"];
  suppress: boolean;
  reasons: string[];
  matchedSource?: string;
  matchedSourceId?: string;
};

function crossSourceEvent(listing: Listing, decision: CrossSourceDecision): CrossSourceEvent {
  return {
    source: listing.source,
    sourceId: listing.sourceId,
    verdict: decision.verdict,
    suppress: decision.suppress,
    reasons: decision.reasons,
    ...(decision.match
      ? { matchedSource: decision.match.source, matchedSourceId: decision.match.sourceId }
      : {}),
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function laterDate(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a.getTime() >= b.getTime() ? a : b;
}

function emptySellerStats() {
  return {
    sellerAcceptedOwner: 0,
    sellerAcceptedSelfDeclared: 0,
    sellerAcceptedUnknown: 0,
    sellerRejectedIntermediary: 0,
    otherFilterRejected: 0,
    acceptedCount: 0,
  };
}

function countSellerDecisions(
  listings: Listing[],
  config: AppConfig,
): ReturnType<typeof emptySellerStats> {
  const stats = emptySellerStats();
  const { maxListingAgeMinutes: _ignoredAge, ...configWithoutAge } = config;
  const filtered = applyListingFilters(listings, configWithoutAge);
  for (const item of filtered) {
    const bucket = sellerDecisionBucket(item.listing);
    if (bucket === "intermediary") {
      stats.sellerRejectedIntermediary += 1;
      continue;
    }
    if (bucket === "owner") {
      stats.sellerAcceptedOwner += 1;
    } else if (bucket === "self_declared") {
      stats.sellerAcceptedSelfDeclared += 1;
    } else {
      stats.sellerAcceptedUnknown += 1;
    }
    if (item.accepted && item.locationMatched) {
      stats.acceptedCount += 1;
    } else {
      stats.otherFilterRejected += 1;
    }
  }
  return stats;
}

function capabilityFor(source: string, enabled: boolean, config: AppConfig): string {
  if (!enabled) {
    return "disabled_by_config";
  }
  if (source === "olx") {
    if (config.enableOlxBrowser) {
      return `${OLX_BROWSER_TRANSPORT} — no HTTP api/v1/offers fallback`;
    }
    return config.enableOlx
      ? "http_adapter_only — on Oracle this is typically CloudFront 403"
      : "disabled — OLX HTTP blocked on Oracle; set ENABLE_OLX_BROWSER=true to use Playwright extract";
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
  if (kind === "rate_limited") {
    return {
      ok: false,
      resultKind: "rate_limited",
      errorSafe: result.health.message ?? `RATE_LIMITED HTTP ${result.httpStatus ?? 429}`,
    };
  }
  if (result.httpStatus === 403 || result.httpStatus === 429) {
    return {
      ok: false,
      resultKind: "transport_blocked",
      errorSafe: `transport_blocked HTTP ${result.httpStatus} via ${result.transport}`,
    };
  }
  if (kind === "ok" && result.listings.length > 0) {
    return { ok: true, resultKind: kind };
  }
  if (kind === "valid_empty") {
    return { ok: true, resultKind: kind };
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

function resolveFirstRunMode(config: AppConfig, override?: "seed" | "preview"): "seed" | "preview" {
  if (override) {
    return override;
  }
  // Legacy FIRST_RUN_MODE=send is treated as preview (never flood unlabeled "new").
  if (config.firstRunMode === "send" || config.firstRunMode === "preview") {
    return "preview";
  }
  return "seed";
}

type DeliveryKind = OutboxItem["deliveryKind"];

async function deliverListing(
  deps: TelegramTestPipelineDeps,
  listing: Listing,
  deliveryKind: DeliveryKind,
  existingId?: number,
): Promise<{ dryRun: boolean; sentOk: number; sentFailed: number; sendErrors: string[] }> {
  const outbox = deps.outbox;
  let id = existingId;
  if (outbox) {
    if (id === undefined) {
      const enqueued = outbox.enqueueIfNew(listing, deliveryKind);
      if (enqueued.duplicate) {
        if (enqueued.status === "sent") {
          deps.dedupe.markSeen(listing);
        }
        return { dryRun: false, sentOk: 0, sentFailed: 0, sendErrors: [] };
      }
      id = enqueued.id;
    }
    if (!outbox.claimForSend(id)) {
      return { dryRun: false, sentOk: 0, sentFailed: 0, sendErrors: [] };
    }
  }

  try {
    const result: TelegramSendResult = await deps.sink.sendListing(listing, { deliveryKind });
    if (result.ok) {
      if (outbox && id !== undefined) {
        outbox.markSent(id);
      }
      deps.dedupe.markSeen(listing);
      return { dryRun: result.dryRun, sentOk: 1, sentFailed: 0, sendErrors: [] };
    }
    if (outbox && id !== undefined) {
      outbox.markFailed(id, result.errorSafe ?? "telegram send failed");
    }
    return {
      dryRun: result.dryRun,
      sentOk: 0,
      sentFailed: 1,
      sendErrors: result.errorSafe ? [result.errorSafe] : [],
    };
  } catch (error) {
    const errorSafe = safeError(error);
    if (outbox && id !== undefined) {
      outbox.markFailed(id, errorSafe);
    }
    return { dryRun: false, sentOk: 0, sentFailed: 1, sendErrors: [errorSafe] };
  }
}

/**
 * One collection cycle with per-source silent baseline + freshness gating.
 * Failed sends do not mark delivered. Failed sources do not erase the last baseline.
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
  const firstRunMode = resolveFirstRunMode(deps.config, deps.firstRunMode);
  const previewLimit = Math.max(
    1,
    deps.initialPreviewLimit ?? deps.config.telegramInitialPreviewLimit ?? 3,
  );
  const strictNewPublications =
    deps.strictNewPublications ?? deps.config.telegramStrictNewPublications ?? true;
  const maxPublicationAgeMinutes = defaultMaxPublicationAgeMinutes(
    deps.config.maxListingAgeMinutes,
  );
  deps.baseline.ensureSellerPolicy?.(deps.config.sellerPolicy, now());
  const policyCutoverAt = deps.baseline.sellerPolicyCutoverAt?.();

  type SourceBucket = {
    source: string;
    ok: boolean;
    listings: Listing[];
    collectedCount: number;
  };
  const buckets: SourceBucket[] = [];
  const sellerTotals = emptySellerStats();

  for (const adapter of deps.adapters) {
    const enabled =
      (adapter.source === "domria" && deps.config.enableDomria) ||
      (adapter.source === "lun" && deps.config.enableLun) ||
      (adapter.source === "olx" && isOlxCollectionEnabled(deps.config)) ||
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
        preferOwners: usesOwnerOnlySourceFilter(deps.config),
      });
      const classified = classifySourceAttempt(result);
      // Do not drop old publishedAt here — baseline must see current inventory.
      // Freshness classifier (not MAX_LISTING_AGE filter) gates what is sent as new.
      const { maxListingAgeMinutes: _ignoredAge, ...configWithoutAge } = deps.config;
      const sellerStats = countSellerDecisions(result.listings, deps.config);
      sellerTotals.sellerAcceptedOwner += sellerStats.sellerAcceptedOwner;
      sellerTotals.sellerAcceptedSelfDeclared += sellerStats.sellerAcceptedSelfDeclared;
      sellerTotals.sellerAcceptedUnknown += sellerStats.sellerAcceptedUnknown;
      sellerTotals.sellerRejectedIntermediary += sellerStats.sellerRejectedIntermediary;
      sellerTotals.otherFilterRejected += sellerStats.otherFilterRejected;
      sellerTotals.acceptedCount += sellerStats.acceptedCount;
      const accepted = applyListingFilters(result.listings, configWithoutAge)
        .filter((item) => item.accepted && item.locationMatched)
        .map((item) => item.listing);

      buckets.push({
        source: adapter.source,
        ok: classified.ok,
        listings: accepted,
        collectedCount: result.listings.length,
      });
      sourceAttempts.push({
        source: adapter.source,
        enabled: true,
        transport: result.transport,
        capability,
        ok: classified.ok,
        listingCount: result.listings.length,
        sellerAcceptedOwner: sellerStats.sellerAcceptedOwner,
        sellerAcceptedSelfDeclared: sellerStats.sellerAcceptedSelfDeclared,
        sellerAcceptedUnknown: sellerStats.sellerAcceptedUnknown,
        sellerRejectedIntermediary: sellerStats.sellerRejectedIntermediary,
        otherFilterRejected: sellerStats.otherFilterRejected,
        acceptedCount: sellerStats.acceptedCount,
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
      buckets.push({ source: adapter.source, ok: false, listings: [], collectedCount: 0 });
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

  let sentOk = 0;
  let sentFailed = 0;
  const dryRun = deps.sink.dryRun === true;
  let initialInventoryCount = 0;
  let newlyObservedCount = 0;
  let suppressedOld = 0;
  let suppressedRefreshedOld = 0;
  let suppressedUnknownStrict = 0;
  let suppressedLateDiscovered = 0;
  let suppressedCrossSourceDuplicate = 0;
  let crossSourceUncertainKept = 0;
  const crossSourceEvents: CrossSourceEvent[] = [];
  const crossSourcePeers: Listing[] = [];
  const crossSource = crossSourceOf(deps.dedupe);
  let newAfterDedupe = 0;
  let collectedRaw = 0;
  let acceptedFiltered = 0;
  let usedPreview = false;
  let usedSeed = false;

  if (deps.outbox) {
    for (const item of deps.outbox.listRetryable(20)) {
      const delivered = await deliverListing(deps, item.listing, item.deliveryKind, item.id);
      sentOk += delivered.sentOk;
      sentFailed += delivered.sentFailed;
      sendErrors.push(...delivered.sendErrors);
    }
  }

  for (const bucket of buckets) {
    collectedRaw += bucket.collectedCount;
    acceptedFiltered += bucket.listings.length;
    const attempt = sourceAttempts.find((s) => s.source === bucket.source && s.enabled);

    if (!bucket.ok) {
      // Failed fetch: do NOT establish baseline (prevents recovery flood).
      if (attempt) {
        attempt.baselineSkippedFailure = true;
      }
      continue;
    }

    if (!deps.baseline.hasBaseline(bucket.source)) {
      const unseen = deps.dedupe
        .filterUnseen(bucket.listings)
        .map((l) => withFirstSeenAt(l, now()));
      initialInventoryCount += unseen.length;
      if (firstRunMode === "preview") {
        usedPreview = true;
        const sample = unseen.slice(0, previewLimit);
        for (const original of sample) {
          const listing = annotateListing(original);
          if (crossSource) {
            const decision = crossSource.assessCrossSource(listing, crossSourcePeers);
            if (decision.suppress) {
              suppressedCrossSourceDuplicate += 1;
              if (crossSourceEvents.length < 30) {
                crossSourceEvents.push(crossSourceEvent(listing, decision));
              }
              continue;
            }
            crossSource.rememberCrossSource(listing);
            crossSourcePeers.push(listing);
          }
          const delivered = await deliverListing(deps, listing, "initial_preview");
          sentOk += delivered.sentOk;
          sentFailed += delivered.sentFailed;
          sendErrors.push(...delivered.sendErrors);
        }
        // Baseline the full successful fetch set even if a preview send failed.
        deps.baseline.establishSilent(bucket.source, unseen, deps.dedupe, now());
      } else {
        usedSeed = true;
        deps.baseline.establishSilent(bucket.source, unseen, deps.dedupe, now());
      }
      if (attempt) {
        attempt.baselineEstablished = true;
      }
      continue;
    }

    // Baseline already exists — only consider unseen + freshness.
    deps.baseline.recordSuccess(bucket.source, now());
    const unseen = deps.dedupe.filterUnseen(bucket.listings).map((l) => withFirstSeenAt(l, now()));
    newAfterDedupe += unseen.length;
    newlyObservedCount += unseen.length;

    for (const original of unseen) {
      const listing = annotateListing(original);
      if (crossSource) {
        const decision = crossSource.assessCrossSource(listing, crossSourcePeers);
        if (decision.verdict !== "unique") {
          const event = crossSourceEvent(listing, decision);
          if (crossSourceEvents.length < 30) {
            crossSourceEvents.push(event);
          }
          logger.info(
            decision.suppress
              ? "dedup.confirmed_cross_source_duplicate"
              : "dedup.uncertain_cross_source_kept",
            event,
          );
        }
        if (decision.suppress) {
          suppressedCrossSourceDuplicate += 1;
          deps.dedupe.markSeen(listing);
          continue;
        }
        if (decision.verdict === "possible_duplicate") {
          crossSourceUncertainKept += 1;
        }
        crossSource.rememberCrossSource(listing);
        crossSourcePeers.push(listing);
      }

      const established = deps.baseline.establishedAt(bucket.source);
      const monitoringStartedAt = laterDate(established, policyCutoverAt);
      const freshness = classifyListingFreshness(listing, {
        maxPublicationAgeMinutes,
        strictNewPublications,
        now: now(),
        ...(monitoringStartedAt ? { monitoringStartedAt } : {}),
      });
      if (!freshness.deliverable) {
        if (freshness.kind === "old_publication") {
          suppressedOld += 1;
        } else if (freshness.kind === "refreshed_old") {
          suppressedRefreshedOld += 1;
        } else if (freshness.kind === "first_noticed") {
          suppressedUnknownStrict += 1;
        } else if (freshness.kind === "late_discovered") {
          suppressedLateDiscovered += 1;
        }
        // Still mark seen so old inventory does not retry forever.
        deps.dedupe.markSeen(listing);
        continue;
      }

      const deliveryKind =
        freshness.kind === "new_publication" || freshness.kind === "first_noticed"
          ? freshness.kind
          : "first_noticed";
      const delivered = await deliverListing(deps, listing, deliveryKind);
      sentOk += delivered.sentOk;
      sentFailed += delivered.sentFailed;
      sendErrors.push(...delivered.sendErrors);
    }
  }

  const deliveryMode: TelegramTestCycleReport["deliveryMode"] = usedPreview
    ? "initial_preview"
    : usedSeed && sentOk === 0 && newlyObservedCount === 0
      ? "inventory_seed"
      : "send_new";

  const endedAt = now();
  const enabledAttempts = sourceAttempts.filter((s) => s.enabled);
  const hasSourceFailures = enabledAttempts.some((s) => !s.ok);
  const partialCoverage =
    enabledAttempts.length > 0 && enabledAttempts.some((s) => s.ok) && hasSourceFailures;

  return {
    cycle,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    collectedRaw,
    acceptedFiltered,
    sellerAcceptedOwner: sellerTotals.sellerAcceptedOwner,
    sellerAcceptedSelfDeclared: sellerTotals.sellerAcceptedSelfDeclared,
    sellerAcceptedUnknown: sellerTotals.sellerAcceptedUnknown,
    sellerRejectedIntermediary: sellerTotals.sellerRejectedIntermediary,
    otherFilterRejected: sellerTotals.otherFilterRejected,
    newAfterDedupe,
    initialInventoryCount,
    newlyObservedCount,
    sentOk,
    sentFailed,
    suppressedOld,
    suppressedRefreshedOld,
    suppressedUnknownStrict,
    suppressedLateDiscovered,
    suppressedCrossSourceDuplicate,
    crossSourceUncertainKept,
    crossSourceEvents,
    dryRun,
    chatId: deps.sink.chatId,
    deliveryMode,
    sourceAttempts,
    sourceErrors,
    sendErrors,
    zeroResult: newlyObservedCount === 0 && sentOk === 0,
    zeroEligibleListings: newlyObservedCount === 0 && sentOk === 0 && !hasSourceFailures,
    hasSourceFailures,
    partialCoverage,
    dedupeSurvivesRestart: deps.baseline.survivesRestart,
    baselineSurvivesRestart: deps.baseline.survivesRestart,
    restartRebaseline: !deps.baseline.survivesRestart,
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
  enableOlxBrowser: boolean;
  ownerOnly: boolean;
  ownerAcceptSelfDeclared: boolean;
  sellerPolicy: "reject_intermediaries" | "owner_only";
  firstRunMode: "seed" | "preview" | "send";
  durable?: boolean;
}): string {
  const mode = input.firstRunMode === "send" ? "preview" : input.firstRunMode;
  const cyclesLabel = input.cycles === 0 ? "unbounded" : String(input.cycles);
  return [
    "🧪 <b>TEST Telegram poll starting</b>",
    `chat_id: ${input.chatId}`,
    `cycles: ${cyclesLabel} · interval_ms: ${input.intervalMs}`,
    `dry_run: ${input.dryRun}`,
    `seller_policy: ${input.sellerPolicy}`,
    `owner_only: ${input.ownerOnly} (ignored unless seller_policy=owner_only)`,
    `owner_accept_self_declared: ${input.ownerAcceptSelfDeclared} (legacy owner_only opt-in)`,
    `first_run_mode: ${mode} (seed = silent per-source baseline; preview = small «Початкова добірка»)`,
    `sources: domria=${input.enableDomria} lun=${input.enableLun} rieltor=${input.enableRieltor} olx_http=${input.enableOlx} olx_browser=${input.enableOlxBrowser}`,
    "Age window is necessary but not sufficient: listings published before the silent baseline are not «Нова публікація».",
    input.durable
      ? "Dedupe, baseline, freshness and Telegram outbox persist in local SQLite. Restart does not silent-rebaseline."
      : "Dedupe + baseline are in-memory only — restart triggers silent re-baseline (no flood of historical inventory as «нове»).",
    "Confirmed intermediaries are rejected. Unknown sellers are labeled «Власник не підтверджено». Self-declared text is labeled as a listing claim, not platform verification.",
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
  durable?: boolean;
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
    "Failed sources never erase the last known baseline.",
    input.durable
      ? "SQLite outbox marks sent only after Telegram confirms success; failed rows stay retryable."
      : "Dedupe/baseline did not survive restart (in-memory).",
  ].join("\n");
}
