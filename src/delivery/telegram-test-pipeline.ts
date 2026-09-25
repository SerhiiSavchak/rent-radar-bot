import type { Listing, ListingSource } from "../domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../domain/source.ts";
import { usesOwnerOnlySourceFilter, type AppConfig } from "../config/env.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { sellerDecisionBucket } from "../filters/owner-filter.ts";
import {
  classifyListingFreshness,
  defaultMaxPublicationAgeMinutes,
  withFirstSeenAt,
} from "./listing-freshness.ts";
import {
  hasSellerHold,
  deleteSellerHold,
  resolveDueSellerHolds,
  shouldHoldSellerVerification,
  upsertSellerHold,
} from "./seller-verification-hold.ts";
import { applySellerProfileGate } from "./seller-profile.ts";
import type { SellerProfilePolicies } from "./seller-profile.ts";
import {
  formatRieltorCoverage,
  parseRieltorCatchup,
  rieltorCatchupKey,
  rieltorPublicationBoundaryKey,
  serializeRieltorCatchup,
  type RieltorCategoryName,
} from "../sources/rieltor/rieltor-incremental.ts";
import {
  olxCategoryToCoverageKey,
  olxPublicationBoundaryKey,
  type OlxBrowserCategoryName,
} from "../sources/olx/olx-browser.coverage.ts";
import {
  DOMRIA_ACQUIRED_IDS_KEY,
  mergeDomriaAcquiredIds,
  parseDomriaAcquiredIds,
} from "../sources/domria/domria-newest.ts";
import type {
  ListingDedupe,
  OutboxItem,
  SourceBaseline,
  TelegramOutbox,
} from "./delivery-ports.ts";
import {
  confirmedIntermediaryRelation,
  crossSourceOf,
  type CrossSourceDecision,
} from "./cross-source-dedup.ts";
import { annotateListing } from "./listing-annotations.ts";
import {
  ListingDecisionTraceBuffer,
  type ListingDecisionTraceFlushReport,
} from "./listing-decision-trace.ts";
import {
  canonicalRieltorDetailTarget,
  createCycleRieltorSellerVerifier,
  emptyLinkedSellerVerification,
  type LinkedSellerDecision,
  type LinkedSellerVerificationCounts,
  type RieltorDetailPage,
} from "./rieltor-detail-seller.ts";
import {
  canonicalOlxDetailTarget,
  createCycleOlxSellerVerifier,
} from "./olx-detail-seller.ts";
import { dispatchSourceAdminAlerts } from "./source-admin-alerts.ts";
import { DurableDeliveryStore } from "../storage/durable-delivery-store.ts";
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
  /**
   * Raw collected sourceIds this cycle (capped). Lets a missing Telegram listing
   * be checked against search coverage without archiving full listing payloads.
   * When `collectedSourceIdsComplete` is false, absence from this array is not
   * proof the listing was never collected.
   */
  collectedSourceIds?: string[];
  collectedSourceIdsTotal?: number;
  collectedSourceIdsComplete?: boolean;
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

/** Cap raw id samples in cycle logs — enough to prove presence when complete. */
export const COLLECTED_SOURCE_ID_LOG_CAP = 120;

export type CollectedSourceIdsSample = {
  ids: string[];
  totalUnique: number;
  complete: boolean;
};

export function collectedSourceIdsForLog(
  listings: Array<Pick<Listing, "sourceId">>,
  cap: number = COLLECTED_SOURCE_ID_LOG_CAP,
): CollectedSourceIdsSample {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const listing of listings) {
    const id = listing.sourceId?.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (ids.length < cap) {
      ids.push(id);
    }
  }
  return {
    ids,
    totalUnique: seen.size,
    complete: seen.size <= cap,
  };
}

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
  /** Heuristic multi-address inventory classified this cycle (not confirmed intermediary). */
  profileLikelyIntermediary: number;
  /** Young-account signal classified this cycle when a source supplied a creation date. */
  profileHighRisk: number;
  /** Dropped only when an explicit profile reject policy is enabled. */
  profileRejected: number;
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
  linkedSellerVerification: LinkedSellerVerificationCounts;
  linkedSellerEvents: LinkedSellerEvent[];
  dryRun: boolean;
  chatId: string;
  deliveryMode: "inventory_seed" | "initial_preview" | "send_new";
  sourceAttempts: TelegramSourceAttempt[];
  sourceErrors: Array<{ source: string; errorSafe: string }>;
  sendErrors: string[];
  adminAlertsSent: number;
  adminAlertErrors: string[];
  zeroResult: boolean;
  zeroEligibleListings: boolean;
  hasSourceFailures: boolean;
  partialCoverage: boolean;
  /** Bounded listing-decision trace flush; truncated traces are not complete proof. */
  decisionTrace?: ListingDecisionTraceFlushReport;
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
  /** Test double. Production uses one non-retried HTTPS GET of the rebuilt RIELTOR detail URL. */
  fetchRieltorDetail?: (url: string, timeoutMs: number) => Promise<RieltorDetailPage>;
  rieltorDetailGapMs?: number;
  /** Test double for exact LUN→OLX original-source seller checks. */
  fetchOlxDetail?: (url: string, timeoutMs: number) => Promise<RieltorDetailPage>;
  olxDetailGapMs?: number;
  /** Test double for bounded public OLX seller profile inventory after linked unknown. */
  probeOlxProfile?: (input: {
    listingUrl: string;
    listingHtml?: string;
    profilePath?: string;
    timeoutMs: number;
  }) => Promise<import("../sources/olx/olx-seller-profile.ts").OlxProfileSnapshot>;
  /**
   * Optional. The poller reads OLX listing-page display prices for cards about
   * to be sent. Tests omit this so they do not open a browser.
   */
  enrichDisplayPrices?: (listings: Listing[]) => Promise<void>;
};

export type LinkedSellerEvent = {
  source: string;
  sourceId: string;
  outcome: string;
  externalId?: string;
  evidence?: string;
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

function retractAcceptedSeller(
  listing: Listing,
  attempts: TelegramSourceAttempt[],
  totals: ReturnType<typeof emptySellerStats>,
): void {
  const attempt = attempts.find((item) => item.source === listing.source && item.enabled);
  const decision = sellerDecisionBucket(listing);
  if (decision === "owner") {
    totals.sellerAcceptedOwner -= 1;
    if (attempt?.sellerAcceptedOwner !== undefined) {
      attempt.sellerAcceptedOwner -= 1;
    }
  } else if (decision === "self_declared") {
    totals.sellerAcceptedSelfDeclared -= 1;
    if (attempt?.sellerAcceptedSelfDeclared !== undefined) {
      attempt.sellerAcceptedSelfDeclared -= 1;
    }
  } else if (decision === "unknown") {
    totals.sellerAcceptedUnknown -= 1;
    if (attempt?.sellerAcceptedUnknown !== undefined) {
      attempt.sellerAcceptedUnknown -= 1;
    }
  }
  totals.sellerRejectedIntermediary += 1;
  totals.acceptedCount -= 1;
  if (attempt) {
    attempt.sellerRejectedIntermediary = (attempt.sellerRejectedIntermediary ?? 0) + 1;
    if (attempt.acceptedCount !== undefined) {
      attempt.acceptedCount -= 1;
    }
  }
}

function dropListingsWithConfirmedIntermediaryPeer(
  buckets: Array<{ source: string; ok: boolean; listings: Listing[] }>,
  attempts: TelegramSourceAttempt[],
  totals: ReturnType<typeof emptySellerStats>,
  fetched: Listing[],
  linked: LinkedSellerVerificationCounts,
  events: LinkedSellerEvent[],
): void {
  for (const bucket of buckets) {
    if (!bucket.ok) {
      continue;
    }
    const kept: Listing[] = [];
    for (const listing of bucket.listings) {
      const relation = confirmedIntermediaryRelation(listing, fetched);
      if (!relation) {
        kept.push(listing);
        continue;
      }
      retractAcceptedSeller(listing, attempts, totals);
      linked.sameCycleConfirmedAgent += 1;
      if (events.length < 30) {
        events.push({
          source: listing.source,
          sourceId: listing.sourceId,
          outcome: "same_cycle_confirmed_agent",
          externalId: relation.sourceId,
          evidence: `same-cycle ${relation.source} listing is a confirmed intermediary`,
        });
      }
    }
    bucket.listings = kept;
  }
}

function noteLinkedSeller(
  listing: Listing,
  decision: LinkedSellerDecision,
  linked: LinkedSellerVerificationCounts,
  events: LinkedSellerEvent[],
): void {
  if (decision.requested) {
    linked.detailRequests += 1;
  }
  switch (decision.outcome) {
    case "same_cycle_confirmed_agent":
      linked.sameCycleConfirmedAgent += 1;
      break;
    case "same_cycle_resolved":
      linked.sameCycleResolved += 1;
      break;
    case "cache_confirmed_agent":
      linked.cacheConfirmedAgent += 1;
      break;
    case "cache_confirmed_owner":
      linked.cacheConfirmedOwner += 1;
      break;
    case "cache_unknown":
      linked.cacheUnknown += 1;
      break;
    case "detail_confirmed_agent":
      linked.detailConfirmedAgent += 1;
      break;
    case "detail_confirmed_owner":
      linked.detailConfirmedOwner += 1;
      break;
    case "detail_profile_likely":
      linked.detailProfileLikely += 1;
      break;
    case "detail_unknown":
      linked.detailUnknown += 1;
      break;
    case "detail_rate_limited":
      linked.detailRateLimited += 1;
      break;
    case "detail_transport_failure":
      linked.detailTransportFailure += 1;
      break;
    case "detail_parser_failure":
      linked.detailParserFailure += 1;
      break;
    case "skipped_after_rate_limit":
      linked.skippedAfterRateLimit += 1;
      break;
    case "not_required":
      linked.notRequired += 1;
      break;
    default:
      break;
  }
  if (decision.outcome !== "not_required" && events.length < 30) {
    events.push({
      source: listing.source,
      sourceId: listing.sourceId,
      outcome: decision.outcome,
      ...(decision.externalId ? { externalId: decision.externalId } : {}),
      ...(decision.evidence ? { evidence: decision.evidence } : {}),
    });
  }
}

function countSellerDecisions(
  listings: Listing[],
  config: AppConfig,
  trace?: ListingDecisionTraceBuffer,
): ReturnType<typeof emptySellerStats> {
  const stats = emptySellerStats();
  const { maxListingAgeMinutes: _ignoredAge, ...configWithoutAge } = config;
  const filtered = applyListingFilters(listings, configWithoutAge);
  for (const item of filtered) {
    const bucket = sellerDecisionBucket(item.listing);
    if (bucket === "intermediary") {
      stats.sellerRejectedIntermediary += 1;
      trace?.record(
        item.listing.source,
        item.listing.sourceId,
        "rejected_seller",
        "intermediary",
      );
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
    } else if (!item.locationMatched) {
      stats.otherFilterRejected += 1;
      trace?.record(item.listing.source, item.listing.sourceId, "rejected_geo", item.locationReason);
    } else {
      stats.otherFilterRejected += 1;
      trace?.record(
        item.listing.source,
        item.listing.sourceId,
        "rejected_other",
        item.sellerRejectionReason ?? "filter",
      );
    }
  }
  return stats;
}

const CANONICAL_HEALTH_SOURCES = [
  "domria",
  "lun",
  "rieltor",
  "olx",
] as const satisfies readonly ListingSource[];

function canonicalSourceEnabled(source: ListingSource, config: AppConfig): boolean {
  if (source === "domria") {
    return config.enableDomria;
  }
  if (source === "lun") {
    return config.enableLun;
  }
  if (source === "rieltor") {
    return config.enableRieltor;
  }
  return isOlxCollectionEnabled(config);
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

function coverageDiagnostic(coverage: NonNullable<SourceFetchResult["coverage"]>): string {
  const rieltorWalk =
    coverage.catchup !== undefined ||
    coverage.committedBoundary !== undefined ||
    coverage.oldestObservedPublication !== undefined ||
    coverage.newestObservedPublication !== undefined;
  if (rieltorWalk) {
    return formatRieltorCoverage(coverage);
  }
  return [
    "acquired_response_cap",
    `cardsFetched=${coverage.cardsFetched}`,
    `boundaryReached=${coverage.boundaryReached}`,
    `coverageTruncated=${coverage.coverageTruncated}`,
  ].join(" ");
}

function classifySourceAttempt(result: SourceFetchResult): {
  ok: boolean;
  processable: boolean;
  resultKind: string;
  errorSafe?: string;
} {
  const kind = result.resultKind ?? "unknown";
  if (kind === "rate_limited") {
    return {
      ok: false,
      processable: false,
      resultKind: "rate_limited",
      errorSafe: result.health.message ?? `RATE_LIMITED HTTP ${result.httpStatus ?? 429}`,
    };
  }
  if (result.httpStatus === 403 || result.httpStatus === 429) {
    return {
      ok: false,
      processable: false,
      resultKind: "transport_blocked",
      errorSafe: `transport_blocked HTTP ${result.httpStatus} via ${result.transport}`,
    };
  }
  if (kind === "parser_failure") {
    return {
      ok: false,
      processable: false,
      resultKind: kind,
      errorSafe: result.health.message ?? "parser_failure",
    };
  }
  if (
    result.coverage?.coverageTruncated &&
    ((kind === "ok" && result.listings.length > 0) || kind === "valid_empty" || kind === "ok")
  ) {
    return {
      ok: false,
      processable: true,
      resultKind: "coverage_degraded",
      errorSafe: coverageDiagnostic(result.coverage),
    };
  }
  if ((kind === "ok" && result.listings.length > 0) || kind === "valid_empty") {
    return { ok: true, processable: true, resultKind: kind };
  }
  if (kind === "disabled") {
    return { ok: false, processable: false, resultKind: kind, errorSafe: "disabled" };
  }
  return {
    ok: false,
    processable: false,
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

type DeliveryOutcome = {
  dryRun: boolean;
  sentOk: number;
  sentFailed: number;
  sendErrors: string[];
  pauseChannel: boolean;
};

function idleDelivery(dryRun: boolean): DeliveryOutcome {
  return { dryRun, sentOk: 0, sentFailed: 0, sendErrors: [], pauseChannel: false };
}

async function attachDisplayPrices(
  deps: TelegramTestPipelineDeps,
  listings: Listing[],
): Promise<void> {
  const enrich = deps.enrichDisplayPrices;
  if (!enrich) {
    return;
  }
  const targets = listings.filter((listing) => listing.source === "olx").slice(0, 8);
  if (targets.length === 0) {
    return;
  }
  try {
    await enrich(targets);
  } catch {
    // A missed listing page keeps the catalog price already stored on the listing.
  }
}

async function deliverListing(
  deps: TelegramTestPipelineDeps,
  listing: Listing,
  deliveryKind: DeliveryKind,
  existingId?: number,
  mode: "send" | "queue" = "send",
): Promise<DeliveryOutcome> {
  if (deps.sink.dryRun === true) {
    try {
      await deps.sink.sendListing(listing, { deliveryKind });
    } catch (error) {
      return { ...idleDelivery(true), sendErrors: [safeError(error)] };
    }
    return { dryRun: true, sentOk: 1, sentFailed: 0, sendErrors: [], pauseChannel: false };
  }

  const outbox = deps.outbox;
  const at = (deps.now ?? (() => new Date()))();
  const store = outbox instanceof DurableDeliveryStore ? outbox : undefined;
  if (mode === "queue") {
    if (!outbox || existingId !== undefined) {
      return idleDelivery(false);
    }
    const enqueued = outbox.enqueueIfNew(listing, deliveryKind);
    if (enqueued.duplicate && enqueued.status === "sent") {
      deps.dedupe.markSeen(listing);
    }
    return idleDelivery(false);
  }

  let id = existingId;
  if (outbox) {
    if (id === undefined) {
      const enqueued = outbox.enqueueIfNew(listing, deliveryKind);
      if (enqueued.duplicate) {
        if (enqueued.status === "sent") {
          deps.dedupe.markSeen(listing);
        }
        return idleDelivery(false);
      }
      id = enqueued.id;
    }
    // The outbox row exists. Identity may suppress a twin only from here on.
    crossSourceOf(deps.dedupe)?.rememberCrossSource(listing);
    if (!outbox.claimForSend(id)) {
      return idleDelivery(false);
    }
  }

  try {
    const result: TelegramSendResult = await deps.sink.sendListing(listing, { deliveryKind });
    if (result.ok) {
      if (outbox && id !== undefined) {
        outbox.markSent(id);
      }
      store?.clearTelegramPause();
      deps.dedupe.markSeen(listing);
      return { dryRun: result.dryRun, sentOk: 1, sentFailed: 0, sendErrors: [], pauseChannel: false };
    }
    const errorClass = result.errorClass ?? "transient";
    const pauseChannel = errorClass === "operator_action";
    const pause = pauseChannel
      ? store?.noteOperatorChannelFailure(at, result.failureReason ?? "operator_action")
      : undefined;
    const retryAfterMs = pause?.delayMs ?? result.retryAfterMs;
    if (outbox && id !== undefined) {
      outbox.markFailed(id, result.errorSafe ?? "telegram send failed", at, {
        errorClass,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    return {
      dryRun: result.dryRun,
      sentOk: 0,
      sentFailed: 1,
      sendErrors: result.errorSafe ? [result.errorSafe] : [],
      pauseChannel,
    };
  } catch (error) {
    const errorSafe = safeError(error);
    if (outbox && id !== undefined) {
      outbox.markFailed(id, errorSafe, at, { errorClass: "transient" });
    }
    return { dryRun: false, sentOk: 0, sentFailed: 1, sendErrors: [errorSafe], pauseChannel: false };
  }
}

async function notifySourceAdmins(
  deps: TelegramTestPipelineDeps,
  at: Date,
): Promise<{ sent: number; errors: string[] }> {
  const adminChatId = deps.config.adminTelegramChatId;
  if (!adminChatId || !(deps.baseline instanceof DurableDeliveryStore) || deps.sink.dryRun === true) {
    return { sent: 0, errors: [] };
  }
  try {
    const report = await dispatchSourceAdminAlerts(
      deps.baseline.verificationDatabase(),
      at,
      async (text) => {
        if (typeof deps.sink.sendAdminText === "function") {
          const result = await deps.sink.sendAdminText(adminChatId, text);
          return {
            ok: result.ok,
            ...(result.errorSafe ? { errorSafe: result.errorSafe } : {}),
          };
        }
        if (adminChatId === deps.sink.chatId) {
          const result = await deps.sink.sendText(text);
          return {
            ok: result.ok,
            ...(result.errorSafe ? { errorSafe: result.errorSafe } : {}),
          };
        }
        return { ok: false, errorSafe: "admin sender unavailable" };
      },
    );
    return { sent: report.sent, errors: report.errors };
  } catch (error) {
    return { sent: 0, errors: [safeError(error)] };
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
  const holdDb =
    deps.baseline instanceof DurableDeliveryStore
      ? deps.baseline.verificationDatabase()
      : deps.outbox instanceof DurableDeliveryStore
        ? deps.outbox.verificationDatabase()
        : undefined;
  const decisionTrace = new ListingDecisionTraceBuffer(cycle);

  const readMetaValue = (key: string): string | undefined => {
    if (!holdDb) {
      return undefined;
    }
    const row = holdDb.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };
  const readRieltorWatermarks = ():
    | Partial<Record<RieltorCategoryName, Date>>
    | undefined => {
    const watermarks: Partial<Record<RieltorCategoryName, Date>> = {};
    for (const category of ["apartment", "house"] as const) {
      const parsed = Date.parse(readMetaValue(rieltorPublicationBoundaryKey(category)) ?? "");
      if (Number.isFinite(parsed)) {
        watermarks[category] = new Date(parsed);
      }
    }
    return Object.keys(watermarks).length > 0 ? watermarks : undefined;
  };
  const readOlxWatermarks = ():
    | Partial<Record<"apartment" | "house", Date>>
    | undefined => {
    const watermarks: Partial<Record<"apartment" | "house", Date>> = {};
    for (const category of ["apartments", "houses"] as const satisfies readonly OlxBrowserCategoryName[]) {
      const parsed = Date.parse(readMetaValue(olxPublicationBoundaryKey(category)) ?? "");
      if (Number.isFinite(parsed)) {
        watermarks[olxCategoryToCoverageKey(category)] = new Date(parsed);
      }
    }
    return Object.keys(watermarks).length > 0 ? watermarks : undefined;
  };
  const readRieltorCatchup = ():
    | Partial<Record<RieltorCategoryName, { target: string; resumePage: number }>>
    | undefined => {
    const catchup: Partial<Record<RieltorCategoryName, { target: string; resumePage: number }>> =
      {};
    for (const category of ["apartment", "house"] as const) {
      const parsed = parseRieltorCatchup(readMetaValue(rieltorCatchupKey(category)));
      if (parsed) {
        catchup[category] = parsed;
      }
    }
    return Object.keys(catchup).length > 0 ? catchup : undefined;
  };
  const readRieltorBootstrapTarget = (): Date | undefined => {
    if (!holdDb) {
      return undefined;
    }
    const row = holdDb
      .prepare(
        `SELECT established_at AS establishedAt, last_success_at AS lastSuccessAt
         FROM source_baselines WHERE source = 'rieltor'`,
      )
      .get() as { establishedAt: string; lastSuccessAt: string | null } | undefined;
    if (!row) {
      return undefined;
    }
    const times = [Date.parse(row.establishedAt), Date.parse(row.lastSuccessAt ?? "")].filter(
      (value) => Number.isFinite(value),
    );
    if (times.length === 0) {
      return undefined;
    }
    return new Date(Math.min(...times));
  };

  type SourceBucket = {
    source: string;
    ok: boolean;
    listings: Listing[];
    raw: Listing[];
    collectedCount: number;
  };
  const buckets: SourceBucket[] = [];
  const sellerTotals = emptySellerStats();
  let profileLikelyIntermediary = 0;
  let profileHighRisk = 0;
  let profileRejected = 0;

  const recordAttempt = (attempt: TelegramSourceAttempt): void => {
    sourceAttempts.push(attempt);
    deps.baseline.recordSourceHealth?.(
      {
        source: attempt.source,
        transport: attempt.transport,
        listingCount: attempt.listingCount,
        ok: attempt.ok,
        ...(attempt.resultKind !== undefined ? { resultKind: attempt.resultKind } : {}),
        ...(attempt.httpStatus !== undefined ? { httpStatus: attempt.httpStatus } : {}),
        ...(attempt.errorSafe !== undefined ? { errorSafe: attempt.errorSafe } : {}),
      },
      now(),
    );
  };

  for (const adapter of deps.adapters) {
    const enabled = canonicalSourceEnabled(adapter.source, deps.config);

    const capability = capabilityFor(adapter.source, enabled, deps.config);
    if (!enabled) {
      recordAttempt({
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
      const publicationWatermarks =
        adapter.source === "rieltor"
          ? readRieltorWatermarks()
          : adapter.source === "olx"
            ? readOlxWatermarks()
            : undefined;
      const rieltorCatchup = adapter.source === "rieltor" ? readRieltorCatchup() : undefined;
      const rieltorBootstrapTarget =
        adapter.source === "rieltor" ? readRieltorBootstrapTarget() : undefined;
      const domriaKnownIds =
        adapter.source === "domria"
          ? parseDomriaAcquiredIds(readMetaValue(DOMRIA_ACQUIRED_IDS_KEY))
          : undefined;
      const result: SourceFetchResult = await adapter.inspectLatest({
        preferOwners: usesOwnerOnlySourceFilter(deps.config),
        ...(publicationWatermarks ? { publicationWatermarks } : {}),
        ...(rieltorCatchup ? { rieltorCatchup } : {}),
        ...(rieltorBootstrapTarget ? { rieltorBootstrapTarget } : {}),
        ...(domriaKnownIds && domriaKnownIds.length > 0 ? { domriaKnownIds } : {}),
      });
      const classified = classifySourceAttempt(result);
      // Do not drop old publishedAt here — baseline must see current inventory.
      // Freshness classifier (not MAX_LISTING_AGE filter) gates what is sent as new.
      const { maxListingAgeMinutes: _ignoredAge, ...configWithoutAge } = deps.config;
      const sellerStats = countSellerDecisions(result.listings, deps.config, decisionTrace);
      for (const listing of result.listings) {
        decisionTrace.record(listing.source, listing.sourceId, "collected", "source_fetch");
        decisionTrace.record(listing.source, listing.sourceId, "normalized", "listing_object");
      }
      sellerTotals.sellerAcceptedOwner += sellerStats.sellerAcceptedOwner;
      sellerTotals.sellerAcceptedSelfDeclared += sellerStats.sellerAcceptedSelfDeclared;
      sellerTotals.sellerAcceptedUnknown += sellerStats.sellerAcceptedUnknown;
      sellerTotals.sellerRejectedIntermediary += sellerStats.sellerRejectedIntermediary;
      sellerTotals.otherFilterRejected += sellerStats.otherFilterRejected;
      sellerTotals.acceptedCount += sellerStats.acceptedCount;
      const acceptedRaw = applyListingFilters(result.listings, configWithoutAge)
        .filter((item) => item.accepted && item.locationMatched)
        .map((item) => item.listing);
      const profilePolicies: SellerProfilePolicies = {
        likelyPolicy: deps.config.sellerProfileLikelyPolicy,
        newAccountPolicy: deps.config.sellerProfileNewAccountPolicy,
      };
      const profiled = applySellerProfileGate(
        acceptedRaw,
        deps.sink.dryRun === true ? undefined : holdDb,
        now(),
        profilePolicies,
      );
      profileLikelyIntermediary += profiled.profileLikelyIntermediary;
      profileHighRisk += profiled.profileHighRisk;
      profileRejected += profiled.profileRejected;
      const accepted = profiled.kept;

      buckets.push({
        source: adapter.source,
        ok: classified.processable,
        listings: accepted,
        raw: result.listings,
        collectedCount: result.listings.length,
      });
      if (holdDb && adapter.source === "domria" && result.coverage?.retainedSourceIds) {
        const previous = parseDomriaAcquiredIds(readMetaValue(DOMRIA_ACQUIRED_IDS_KEY));
        const merged = mergeDomriaAcquiredIds(previous, result.coverage.retainedSourceIds);
        holdDb
          .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)")
          .run(DOMRIA_ACQUIRED_IDS_KEY, JSON.stringify(merged));
      }
      if (holdDb && adapter.source === "rieltor" && result.coverage) {
        const writeMeta = holdDb.prepare(
          "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
        );
        const deleteMeta = holdDb.prepare("DELETE FROM schema_meta WHERE key = ?");
        for (const category of ["apartment", "house"] as const) {
          const committed = result.coverage.committedBoundary?.[category];
          if (committed) {
            writeMeta.run(rieltorPublicationBoundaryKey(category), committed);
          }
          if (result.coverage.catchup && category in result.coverage.catchup) {
            const state = result.coverage.catchup[category];
            if (state) {
              writeMeta.run(rieltorCatchupKey(category), serializeRieltorCatchup(state));
            } else {
              deleteMeta.run(rieltorCatchupKey(category));
            }
          }
        }
      }
      if (holdDb && adapter.source === "olx" && result.coverage?.committedBoundary) {
        const writeMeta = holdDb.prepare(
          "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
        );
        for (const category of ["apartments", "houses"] as const satisfies readonly OlxBrowserCategoryName[]) {
          const committed = result.coverage.committedBoundary[olxCategoryToCoverageKey(category)];
          if (committed) {
            // Only advance when the walk closed the gap; never past uncollected inventory.
            writeMeta.run(olxPublicationBoundaryKey(category), committed);
          }
        }
      }
      const collectedIds = collectedSourceIdsForLog(result.listings);
      recordAttempt({
        source: adapter.source,
        enabled: true,
        transport: result.transport,
        capability,
        ok: classified.ok,
        listingCount: result.listings.length,
        collectedSourceIds: collectedIds.ids,
        collectedSourceIdsTotal: collectedIds.totalUnique,
        collectedSourceIdsComplete: collectedIds.complete,
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
      const browserAcquisition = adapter.source === "olx" && deps.config.enableOlxBrowser;
      sourceErrors.push({ source: adapter.source, errorSafe });
      buckets.push({ source: adapter.source, ok: false, listings: [], raw: [], collectedCount: 0 });
      recordAttempt({
        source: adapter.source,
        enabled: true,
        transport: "n/a",
        capability,
        ok: false,
        listingCount: 0,
        resultKind: browserAcquisition ? "browser_failure" : "transport_failure",
        errorSafe,
      });
    }
  }

  // Production only builds adapters for enabled sources. A flag that flips off
  // must still replace a previous ok/failure row, without fetching that source.
  for (const source of CANONICAL_HEALTH_SOURCES) {
    if (canonicalSourceEnabled(source, deps.config)) {
      continue;
    }
    if (sourceAttempts.some((attempt) => attempt.source === source)) {
      continue;
    }
    deps.baseline.recordSourceHealth?.(
      {
        source,
        transport: "n/a",
        listingCount: 0,
        ok: false,
        resultKind: "disabled",
      },
      now(),
    );
  }

  const linkedSellerVerification = emptyLinkedSellerVerification();
  const linkedSellerEvents: LinkedSellerEvent[] = [];
  const fetchedListings = buckets.flatMap((bucket) => bucket.raw);
  dropListingsWithConfirmedIntermediaryPeer(
    buckets,
    sourceAttempts,
    sellerTotals,
    fetchedListings,
    linkedSellerVerification,
    linkedSellerEvents,
  );
  const verifyLinkedRieltor = createCycleRieltorSellerVerifier({
    db:
      deps.baseline instanceof DurableDeliveryStore
        ? deps.baseline.verificationDatabase()
        : undefined,
    peers: fetchedListings,
    now,
    timeoutMs: deps.config.sourceTimeoutMs,
    ...(deps.rieltorDetailGapMs !== undefined ? { gapMs: deps.rieltorDetailGapMs } : {}),
    ...(deps.fetchRieltorDetail ? { fetchPage: deps.fetchRieltorDetail } : {}),
  });
  const verifyLinkedOlx = createCycleOlxSellerVerifier({
    db:
      deps.baseline instanceof DurableDeliveryStore
        ? deps.baseline.verificationDatabase()
        : undefined,
    peers: fetchedListings,
    now,
    timeoutMs: deps.config.sourceTimeoutMs,
    profileLikelyPolicy: deps.config.sellerProfileLikelyPolicy,
    ...(deps.olxDetailGapMs !== undefined ? { gapMs: deps.olxDetailGapMs } : {}),
    ...(deps.fetchOlxDetail ? { fetchPage: deps.fetchOlxDetail } : {}),
    ...(deps.probeOlxProfile ? { probeProfile: deps.probeOlxProfile } : {}),
  });
  const verifyLinkedSeller = async (listing: Listing): Promise<LinkedSellerDecision> => {
    const rieltor = await verifyLinkedRieltor(listing);
    if (rieltor.outcome !== "not_required") {
      return rieltor;
    }
    return verifyLinkedOlx(listing);
  };
  const allowLinkedSeller = async (listing: Listing): Promise<boolean> => {
    if (holdDb && hasSellerHold(holdDb, listing.source, listing.sourceId)) {
      return false;
    }
    const decision = await verifyLinkedSeller(listing);
    noteLinkedSeller(listing, decision, linkedSellerVerification, linkedSellerEvents);
    if (decision.drop) {
      if (holdDb) {
        deleteSellerHold(holdDb, listing.source, listing.sourceId);
      }
      retractAcceptedSeller(listing, sourceAttempts, sellerTotals);
      return false;
    }
    const rieltorTarget = canonicalRieltorDetailTarget(
      typeof listing.metadata?.originalUrl === "string" ? listing.metadata.originalUrl : undefined,
    );
    const olxTarget = canonicalOlxDetailTarget(
      typeof listing.metadata?.originalUrl === "string" ? listing.metadata.originalUrl : undefined,
    );
    const holdTarget = rieltorTarget
      ? { id: rieltorTarget.id, source: "rieltor" as const }
      : olxTarget
        ? { id: olxTarget.token, source: "olx" as const }
        : undefined;
    if (
      holdDb &&
      deps.sink.dryRun !== true &&
      holdTarget &&
      shouldHoldSellerVerification(decision)
    ) {
      upsertSellerHold(holdDb, listing, holdTarget.id, now(), holdTarget.source);
      return false;
    }
    return true;
  };

  let sentOk = 0;
  let sentFailed = 0;
  const dryRun = deps.sink.dryRun === true;
  const deliveryStore = deps.outbox instanceof DurableDeliveryStore ? deps.outbox : undefined;
  let pauseChannel = deliveryStore?.telegramPauseActive(now()) ?? false;
  const handoff = async (
    listing: Listing,
    deliveryKind: DeliveryKind,
    existingId?: number,
  ): Promise<DeliveryOutcome> => {
    if (!dryRun && pauseChannel) {
      return deliverListing(deps, listing, deliveryKind, existingId, "queue");
    }
    const delivered = await deliverListing(deps, listing, deliveryKind, existingId);
    if (delivered.pauseChannel) {
      pauseChannel = true;
    }
    return delivered;
  };
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

  if (deps.outbox && !pauseChannel) {
    for (const item of deps.outbox.listRetryable(20, now())) {
      const delivered = await handoff(item.listing, item.deliveryKind, item.id);
      sentOk += delivered.sentOk;
      sentFailed += delivered.sentFailed;
      sendErrors.push(...delivered.sendErrors);
      if (pauseChannel) {
        break;
      }
    }
  }

  const releaseHeldListing = async (original: Listing): Promise<void> => {
    const listing = annotateListing(original);
    if (crossSource) {
      const decision = crossSource.assessCrossSource(listing, crossSourcePeers);
      if (decision.suppress) {
        suppressedCrossSourceDuplicate += 1;
        deps.dedupe.markSeen(listing);
        return;
      }
    }
    const established = deps.baseline.establishedAt(listing.source);
    const monitoringStartedAt = laterDate(established, policyCutoverAt);
    const freshness = classifyListingFreshness(listing, {
      maxPublicationAgeMinutes,
      strictNewPublications,
      now: now(),
      ...(monitoringStartedAt ? { monitoringStartedAt } : {}),
    });
    if (!freshness.deliverable) {
      deps.dedupe.markSeen(listing);
      return;
    }
    const deliveryKind =
      freshness.kind === "new_publication" || freshness.kind === "first_noticed"
        ? freshness.kind
        : "first_noticed";
    const delivered = await handoff(listing, deliveryKind);
    if (crossSource) {
      crossSourcePeers.push(listing);
    }
    sentOk += delivered.sentOk;
    sentFailed += delivered.sentFailed;
    sendErrors.push(...delivered.sendErrors);
  };

  if (holdDb && deps.sink.dryRun !== true) {
    const released = await resolveDueSellerHolds(holdDb, now(), verifyLinkedSeller);
    for (const item of released) {
      if (item.action === "send") {
        await releaseHeldListing(item.listing);
      }
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

    for (const listing of bucket.listings) {
      deps.dedupe.noteObserved?.(listing, now());
    }

    if (!deps.baseline.hasBaseline(bucket.source)) {
      const unseen = deps.dedupe
        .filterUnseen(bucket.listings)
        .map((l) => withFirstSeenAt(l, now()));
      initialInventoryCount += unseen.length;
      if (firstRunMode === "preview") {
        usedPreview = true;
        const sample = unseen.slice(0, previewLimit);
        await attachDisplayPrices(deps, sample);
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
          }
          if (!(await allowLinkedSeller(listing))) {
            continue;
          }
          const delivered = await handoff(listing, "initial_preview");
          if (crossSource) {
            crossSourcePeers.push(listing);
          }
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
    // An incomplete scan must not move the last complete monitoring timestamp.
    if (attempt?.resultKind !== "coverage_degraded") {
      deps.baseline.recordSuccess(bucket.source, now());
    }
    const unseen = deps.dedupe.filterUnseen(bucket.listings).map((l) => withFirstSeenAt(l, now()));
    await attachDisplayPrices(deps, unseen);
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
          decisionTrace.record(
            listing.source,
            listing.sourceId,
            "deduped",
            decision.verdict,
            decision.match?.identityKey,
          );
          continue;
        }
        if (decision.verdict === "possible_duplicate") {
          crossSourceUncertainKept += 1;
        }
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
        decisionTrace.record(
          listing.source,
          listing.sourceId,
          "suppressed_freshness",
          freshness.kind,
        );
        continue;
      }

      if (!(await allowLinkedSeller(listing))) {
        decisionTrace.record(listing.source, listing.sourceId, "held", "linked_seller");
        continue;
      }

      const deliveryKind =
        freshness.kind === "new_publication" || freshness.kind === "first_noticed"
          ? freshness.kind
          : "first_noticed";
      decisionTrace.record(listing.source, listing.sourceId, "queued", deliveryKind);
      const delivered = await handoff(listing, deliveryKind);
      decisionTrace.record(
        listing.source,
        listing.sourceId,
        delivered.sentOk > 0 ? "delivered" : "delivery_failed",
        delivered.sentOk > 0 ? "sent" : "send_error",
      );
      if (crossSource) {
        crossSourcePeers.push(listing);
      }
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
  const decisionTraceFlush = decisionTrace.flush(holdDb);
  const adminAlerts = await notifySourceAdmins(deps, endedAt);
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
    profileLikelyIntermediary,
    profileHighRisk,
    profileRejected,
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
    linkedSellerVerification,
    linkedSellerEvents,
    dryRun,
    chatId: deps.sink.chatId,
    deliveryMode,
    sourceAttempts,
    sourceErrors,
    sendErrors,
    adminAlertsSent: adminAlerts.sent,
    adminAlertErrors: adminAlerts.errors,
    zeroResult: newlyObservedCount === 0 && sentOk === 0,
    zeroEligibleListings: newlyObservedCount === 0 && sentOk === 0 && !hasSourceFailures,
    hasSourceFailures,
    partialCoverage,
    decisionTrace: decisionTraceFlush,
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
