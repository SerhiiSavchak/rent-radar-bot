import type { Listing } from "../domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../domain/source.ts";
import type { AppConfig } from "../config/env.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { isOwnerEligible } from "../filters/owner-filter.ts";
import {
  classifyListingFreshness,
  defaultMaxPublicationAgeMinutes,
  withFirstSeenAt,
} from "./listing-freshness.ts";
import { InMemoryListingDedupe } from "./listing-dedupe-memory.ts";
import { InMemorySourceBaseline } from "./source-baseline-memory.ts";
import { type TelegramSendResult, type TelegramTestSink } from "../outputs/telegram-test.sink.ts";

export type TelegramSourceAttempt = {
  source: string;
  enabled: boolean;
  transport: string;
  capability: string;
  ok: boolean;
  listingCount: number;
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
  newAfterDedupe: number;
  initialInventoryCount: number;
  newlyObservedCount: number;
  sentOk: number;
  sentFailed: number;
  suppressedOld: number;
  suppressedRefreshedOld: number;
  suppressedUnknownStrict: number;
  suppressedLateDiscovered: number;
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
  dedupeSurvivesRestart: false;
  baselineSurvivesRestart: false;
  restartRebaseline: true;
};

export type TelegramTestPipelineDeps = {
  adapters: ListingSourceAdapter[];
  config: AppConfig;
  sink: TelegramTestSink;
  dedupe: InMemoryListingDedupe;
  baseline: InMemorySourceBaseline;
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

function resolveFirstRunMode(
  config: AppConfig,
  override?: "seed" | "preview",
): "seed" | "preview" {
  if (override) {
    return override;
  }
  // Legacy FIRST_RUN_MODE=send is treated as preview (never flood unlabeled "new").
  if (config.firstRunMode === "send" || config.firstRunMode === "preview") {
    return "preview";
  }
  return "seed";
}

/**
 * One collection cycle with per-source silent baseline + freshness gating.
 * Failed sends do not mark delivered. Failed sources do not establish baseline.
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
  const maxPublicationAgeMinutes = defaultMaxPublicationAgeMinutes(deps.config.maxListingAgeMinutes);

  type SourceBucket = {
    source: string;
    ok: boolean;
    listings: Listing[];
  };
  const buckets: SourceBucket[] = [];

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
      const classified = classifySourceAttempt(result);
      // Do not drop old publishedAt here — baseline must see current inventory.
      // Freshness classifier (not MAX_LISTING_AGE filter) gates what is sent as new.
      const { maxListingAgeMinutes: _ignoredAge, ...configWithoutAge } = deps.config;
      const filtered = applyListingFilters(result.listings, configWithoutAge).filter(
        (item) => item.accepted && item.locationMatched,
      );
      const accepted = filtered
        .map((item) => item.listing)
        .filter(
          (listing) =>
            !deps.config.ownerOnly ||
            isOwnerEligible(listing, { acceptSelfDeclared: deps.config.ownerAcceptSelfDeclared === true }),
        );

      buckets.push({ source: adapter.source, ok: classified.ok, listings: accepted });
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
      buckets.push({ source: adapter.source, ok: false, listings: [] });
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
  let dryRun = false;
  let initialInventoryCount = 0;
  let newlyObservedCount = 0;
  let suppressedOld = 0;
  let suppressedRefreshedOld = 0;
  let suppressedUnknownStrict = 0;
  let suppressedLateDiscovered = 0;
  let newAfterDedupe = 0;
  let collectedRaw = 0;
  let acceptedFiltered = 0;
  let usedPreview = false;
  let usedSeed = false;

  for (const bucket of buckets) {
    collectedRaw += bucket.listings.length;
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
      const unseen = deps.dedupe.filterUnseen(bucket.listings).map((l) => withFirstSeenAt(l, now()));
      initialInventoryCount += unseen.length;
      if (firstRunMode === "preview") {
        usedPreview = true;
        const sample = unseen.slice(0, previewLimit);
        for (const listing of sample) {
          try {
            const result: TelegramSendResult = await deps.sink.sendListing(listing, {
              deliveryKind: "initial_preview",
            });
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
    const unseen = deps.dedupe.filterUnseen(bucket.listings).map((l) => withFirstSeenAt(l, now()));
    newAfterDedupe += unseen.length;
    newlyObservedCount += unseen.length;

    for (const listing of unseen) {
      const freshness = classifyListingFreshness(listing, {
        maxPublicationAgeMinutes,
        strictNewPublications,
        now: now(),
        ...(deps.baseline.establishedAt(bucket.source)
          ? { monitoringStartedAt: deps.baseline.establishedAt(bucket.source) }
          : {}),
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
      try {
        const result: TelegramSendResult = await deps.sink.sendListing(listing, { deliveryKind });
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
    newAfterDedupe,
    initialInventoryCount,
    newlyObservedCount,
    sentOk,
    sentFailed,
    suppressedOld,
    suppressedRefreshedOld,
    suppressedUnknownStrict,
    suppressedLateDiscovered,
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
    dedupeSurvivesRestart: false,
    baselineSurvivesRestart: false,
    restartRebaseline: true,
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
  ownerAcceptSelfDeclared: boolean;
  firstRunMode: "seed" | "preview" | "send";
}): string {
  const mode = input.firstRunMode === "send" ? "preview" : input.firstRunMode;
  return [
    "🧪 <b>TEST Telegram poll starting</b>",
    `chat_id: ${input.chatId}`,
    `cycles: ${input.cycles} · interval_ms: ${input.intervalMs}`,
    `dry_run: ${input.dryRun}`,
    `owner_only: ${input.ownerOnly}`,
    `owner_accept_self_declared: ${input.ownerAcceptSelfDeclared}`,
    `first_run_mode: ${mode} (seed = silent per-source baseline; preview = small «Початкова добірка»)`,
    `sources: domria=${input.enableDomria} lun=${input.enableLun} rieltor=${input.enableRieltor} olx_http=${input.enableOlx}`,
    "Age window is necessary but not sufficient: listings published before the silent baseline are not «Нова публікація».",
    "Dedupe + baseline are in-memory only — restart triggers silent re-baseline (no flood of historical inventory as «нове»).",
    "Platform seller labels are not legal ownership proof. Self-declared text is labeled separately and off by default.",
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
    "Failed sources never establish an empty baseline — recovery re-baselines silently.",
    "Dedupe/baseline did not survive restart (in-memory).",
  ].join("\n");
}
