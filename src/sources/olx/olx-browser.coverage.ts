import {
  OLX_DISTANCE_KM,
} from "./olx.source.ts";

/**
 * OLX browser catalog coverage contract (Lviv long-term rent).
 *
 * Verified HTTP `api/v1/offers` controls (2026-09-15): city_id=176, distance=15,
 * sort_by=created_at:desc, categories 1760/330.
 *
 * Browser HTML appends portal filter query keys `search[dist]` / `search[order]`.
 * Live evidence 2026-09-26 (3/3 workstation cycles, listing-level):
 * - radius (`search[dist]=15`): PASS — suburb cities (e.g. Винники, Сокільники)
 *   appear with dist that are absent from city-only samples.
 * - sort (`search[order]=created_at:desc`): BLOCKED — live 2026-09-26 ×3
 *   (`olx-sort/summary-1790406934261.json` + `SORT_FAILURE_ANALYSIS.md`):
 *   non-monotone organic `createdTime` is present in OLX prerendered ads order
 *   (not introduced by extract). URL retention is not newest-by-createdTime proof.
 *   Publication-time stop stays off.
 * - full unfiltered order-independent scan: historical BLOCKED (apartments still
 *   novel at page 25). That probe is not the production collector.
 *
 * Production collection (private catalog, verified shape apartments 140/4 pages,
 * houses 14/1 page) walks every structured page. `search[private_business]=private`
 * is an account filter, not ownership. A stored page cursor does not prove coverage.
 * Publication time and createdTime order do not end the walk.
 * Do not treat HTTP 200, fixtures, or a single OK request as coverage PASS.
 */
export const OLX_BROWSER_APARTMENTS_PATH =
  "/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/";
export const OLX_BROWSER_HOUSES_PATH = "/uk/nedvizhimost/doma/arenda-domov/lvov/";

/**
 * Retired page budget. Production OLX collection does not stop after two pages
 * and does not persist a resume cursor. Kept so historical planner tests stay
 * readable. Cursor progress is not catalog coverage.
 */
export const OLX_BROWSER_PAGE_BUDGET = 2;

/**
 * Safety ceiling for one private-catalog walk. Verified apartments are 4 pages.
 * A larger structured totalPages is incomplete coverage, not a deep cursor.
 */
export const OLX_PRIVATE_CATALOG_PAGE_CAP = 8;

/** Per page.goto. Four apartment pages plus one house page stay under a 10-minute poll. */
export const OLX_PRIVATE_NAVIGATION_TIMEOUT_MS = 45_000;
export const OLX_PRIVATE_CATEGORY_BUDGET_MS = 180_000;
export const OLX_PRIVATE_TOTAL_BUDGET_MS = 360_000;
export const OLX_PRIVATE_HOUSE_RESERVE_MS = 90_000;

/**
 * One cycle keeps the full Private catalog plus one complete Business apartment
 * snapshot (~1000 cards at the current 25-page size) or a hot page. 2500 stays
 * above that set and still rejects a runaway payload. Truncation is incomplete
 * coverage and must not be recorded as a successful Business snapshot.
 */
export const OLX_PRIVATE_ACQUIRED_CAP_PER_CATEGORY = 2500;

/** How often a complete Business apartment snapshot is due. */
export const OLX_BUSINESS_FULL_SCAN_INTERVAL_MS = 30 * 60 * 1000;

export const OLX_BUSINESS_POLL_INTERVAL_MINUTES = 10;
export const OLX_BUSINESS_COVERAGE_TARGET_MINUTES = 30;
export const OLX_BUSINESS_COVERAGE_UNSAFE_MINUTES = 60;

/**
 * Houses at or under this size are fetched whole on every poll.
 * Larger house catalogs are still fetched in one session while they stay
 * under the safety ceiling. There is no cross-cycle house page cursor.
 */
export const OLX_BUSINESS_HOUSE_ROUTINE_MAX_PAGES = 4;

/**
 * Hard stop for one Business walk. Current live apartments are 25 pages.
 * 40 leaves headroom without an unbounded crawl. Above this, coverage is
 * degraded and the full-scan timestamp is not written.
 */
export const OLX_BUSINESS_APARTMENT_PAGE_CEILING = 40;
export const OLX_BUSINESS_HOUSE_PAGE_CEILING = 40;

/** schema_meta key. Value is an ISO timestamp, written only after a complete snapshot. */
export const OLX_BUSINESS_LAST_FULL_SCAN_KEY = "olx_business_last_full_scan_at";

/**
 * Retired keys from the cross-cycle page cursor. Production deletes them.
 * They are not coverage.
 */
export const RETIRED_OLX_BUSINESS_ROLLING_KEYS = [
  "olx_business_rolling_apartments",
  "olx_business_rolling_houses",
] as const;

export function parseOlxBusinessLastFullScanAt(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

/** No previous success, or the last success is at least 30 minutes old. */
export function isOlxBusinessFullScanDue(lastFullScanAt: Date | undefined, now: Date): boolean {
  if (!lastFullScanAt) {
    return true;
  }
  return now.getTime() - lastFullScanAt.getTime() >= OLX_BUSINESS_FULL_SCAN_INTERVAL_MS;
}

export function assessOlxBusinessFullScanAge(
  lastFullScanAt: Date | undefined,
  now: Date,
): {
  lastFullScanAt: string | null;
  ageMinutes: number | null;
  due: boolean;
  degraded: boolean;
  unsafe: boolean;
} {
  if (!lastFullScanAt) {
    return {
      lastFullScanAt: null,
      ageMinutes: null,
      due: true,
      degraded: true,
      unsafe: true,
    };
  }
  const ageMinutes = (now.getTime() - lastFullScanAt.getTime()) / 60_000;
  return {
    lastFullScanAt: lastFullScanAt.toISOString(),
    ageMinutes,
    due: ageMinutes >= OLX_BUSINESS_COVERAGE_TARGET_MINUTES,
    degraded: ageMinutes > OLX_BUSINESS_COVERAGE_TARGET_MINUTES,
    unsafe: ageMinutes >= OLX_BUSINESS_COVERAGE_UNSAFE_MINUTES,
  };
}

/**
 * Hard cap used only for offline depth probes / feasibility math.
 * Hitting this without confirmed_empty means full-scan coverage is unproven.
 */
export const OLX_BROWSER_FULL_SCAN_PAGE_CAP = 25;

/** Default poll interval used for coverage feasibility (10 minutes). */
export const OLX_COVERAGE_POLL_CYCLE_MS = 10 * 60 * 1000;

/**
 * Historical feasibility math for an unfiltered catalog. Not the production
 * private-catalog collector. A page cursor is not safe and does not prove coverage.
 */
export function assessOlxOrderIndependentFullScan(input: {
  apartmentPagesFetched: number;
  apartmentConfirmedEmpty: boolean;
  apartmentNovelOnLastPage: number;
  housePagesFetched: number;
  houseConfirmedEmpty: boolean;
  elapsedMs: number;
  avgNavMs: number;
  olxTotalBudgetMs: number;
  pollCycleMs?: number;
  pageCap?: number;
}): {
  fullScanStatus: "PASS" | "BLOCKED";
  blockReasons: string[];
  pageCursorSafe: false;
  projectedApartmentPagesForEmpty: number | null;
} {
  const pollCycleMs = input.pollCycleMs ?? OLX_COVERAGE_POLL_CYCLE_MS;
  const pageCap = input.pageCap ?? OLX_BROWSER_FULL_SCAN_PAGE_CAP;
  const blockReasons: string[] = [];

  if (!input.apartmentConfirmedEmpty) {
    blockReasons.push("apartments_end_unknown");
    if (input.apartmentPagesFetched >= pageCap) {
      blockReasons.push("apartments_hit_page_cap_still_novel");
    }
    if (input.apartmentNovelOnLastPage > 0) {
      blockReasons.push("apartments_last_page_still_had_novel_ids");
    }
  }
  if (!input.houseConfirmedEmpty) {
    blockReasons.push("houses_end_unknown");
  }
  if (input.elapsedMs > input.olxTotalBudgetMs) {
    blockReasons.push("elapsed_exceeds_olx_total_budget");
  }
  if (input.elapsedMs > pollCycleMs * 0.5) {
    blockReasons.push("elapsed_exceeds_half_poll_cycle");
  }

  // If apartments never emptied, refuse to invent a finite page count.
  const projectedApartmentPagesForEmpty = input.apartmentConfirmedEmpty
    ? input.apartmentPagesFetched
    : null;

  if (
    projectedApartmentPagesForEmpty !== null &&
    input.avgNavMs > 0 &&
    projectedApartmentPagesForEmpty * input.avgNavMs + input.housePagesFetched * input.avgNavMs >
      input.olxTotalBudgetMs
  ) {
    blockReasons.push("projected_nav_time_exceeds_olx_total_budget");
  }

  return {
    fullScanStatus: blockReasons.length === 0 ? "PASS" : "BLOCKED",
    blockReasons,
    // Explicit: offset resume is unsafe under non-monotone / shifting pages.
    pageCursorSafe: false,
    projectedApartmentPagesForEmpty,
  };
}

/**
 * Evidence against treating an offset/page cursor as catalog coverage.
 * OLX pagination is non-monotone. A listing can move onto an already-skipped
 * page, and HTML createdTime order is not a verified newest-first walk.
 *
 * Pages 2–9, then 10–17, then 18–25 collected on three polls are NOT one
 * complete catalog. Production Business coverage is a same-cycle snapshot of
 * every declared page. These helpers exist so that claim cannot return
 * without revisiting the miss.
 *
 * A listing inserted on page 1 after the walker left page 1 is missed in-scan.
 */
export function olxForwardScanMissesInsertedOnPage1(input: {
  walkedPagesInOrder: number[];
  idsByPageAtWalkTime: Record<number, string[]>;
  /** Ids that appear on page 1 only after page 1 was already fetched. */
  latePage1InsertIds: string[];
}): { missedIds: string[]; duplicateIds: string[] } {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const page of input.walkedPagesInOrder) {
    for (const id of input.idsByPageAtWalkTime[page] ?? []) {
      if (seen.has(id)) {
        duplicateIds.push(id);
      }
      seen.add(id);
    }
  }
  const missedIds = input.latePage1InsertIds.filter((id) => !seen.has(id));
  return { missedIds, duplicateIds };
}

/**
 * Resuming at page K after restart does not re-read 1..K-1; under shift those
 * pages may now hold ids never observed.
 */
export function olxPageCursorResumeMisses(input: {
  resumePage: number;
  /** Ids present on pages < resumePage after restart (reshuffled). */
  idsNowOnSkippedPages: string[];
  idsAlreadyStored: ReadonlySet<string>;
}): string[] {
  if (input.resumePage <= 1) {
    return [];
  }
  return input.idsNowOnSkippedPages.filter((id) => !input.idsAlreadyStored.has(id));
}

export const OLX_BROWSER_PUBLICATION_OVERLAP_MS = 30 * 60 * 1000;

/**
 * Reserved for a future verified-newest-first HTML path only.
 * Current default keeps time-stop off (`sortVerified` must be explicitly true).
 */
export const OLX_BROWSER_BOUNDARY_MIN_DATED = 3;

export type OlxBrowserCategoryName = "apartments" | "houses";
export type OlxWalkMode = "seed" | "catchup" | "steady";

/** Backlog still owed. Page 1 is always rechecked for new listings during catch-up. */
export type OlxCatchupState = {
  target: string;
  resumePage: number;
};

export function olxPublicationBoundaryKey(category: OlxBrowserCategoryName): string {
  return `olx_incremental_boundary_${category}`;
}

export function olxCatchupKey(category: OlxBrowserCategoryName): string {
  return `olx_incremental_catchup_${category}`;
}

export function parseOlxCatchup(raw: string | undefined): OlxCatchupState | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { target?: unknown; resumePage?: unknown };
    if (typeof parsed.target !== "string" || !Number.isFinite(Date.parse(parsed.target))) {
      return undefined;
    }
    const resumePage = Number(parsed.resumePage);
    if (!Number.isInteger(resumePage) || resumePage < 1) {
      return undefined;
    }
    return { target: new Date(parsed.target).toISOString(), resumePage };
  } catch {
    return undefined;
  }
}

export function serializeOlxCatchup(state: OlxCatchupState): string {
  return JSON.stringify({ target: state.target, resumePage: state.resumePage });
}

export function buildOlxBrowserCategoryUrl(
  category: OlxBrowserCategoryName,
  options: {
    page?: number;
    /** Defaults to OLX_DISTANCE_KM (15). Pass null to omit (city-only). */
    distanceKm?: number | null;
    /**
     * Historical sort probe only. Production collection leaves this off.
     * URL retention is not proof of createdTime order and does not end a scan.
     */
    orderCreatedDesc?: boolean;
    /**
     * Defaults to the Private account filter. Pass false only for a historical
     * unfiltered probe. Private is not ownership. Do not emit owner_type=private.
     */
    privateOnly?: boolean;
    /** Account catalog. Business does not replace Private. */
    accountCatalog?: "private" | "business";
  } = {},
): string {
  const path = category === "apartments" ? OLX_BROWSER_APARTMENTS_PATH : OLX_BROWSER_HOUSES_PATH;
  const params = new URLSearchParams();
  const distance = options.distanceKm === undefined ? OLX_DISTANCE_KM : options.distanceKm;
  if (distance !== null && distance !== undefined) {
    params.set("search[dist]", String(distance));
  }
  if (options.accountCatalog === "business") {
    params.set("search[private_business]", "business");
  } else if (options.accountCatalog === "private" || options.privateOnly !== false) {
    params.set("search[private_business]", "private");
  }
  if (options.orderCreatedDesc === true) {
    params.set("search[order]", "created_at:desc");
  }
  const page = options.page ?? 1;
  if (page > 1) {
    params.set("page", String(page));
  }
  const query = params.toString();
  return `https://www.olx.ua${path}${query ? `?${query}` : ""}`;
}

/** @deprecated Prefer buildOlxBrowserCategoryUrl("apartments"). */
export const OLX_BROWSER_APARTMENTS_URL = buildOlxBrowserCategoryUrl("apartments");
/** @deprecated Prefer buildOlxBrowserCategoryUrl("houses"). */
export const OLX_BROWSER_HOUSES_URL = buildOlxBrowserCategoryUrl("houses");

/**
 * Retired page-budget planner. Production OLX collection does not call this.
 * A stored resumePage is not catalog coverage.
 *
 * Seed is page 1 only. Catch-up rechecks page 1, then the owed deeper page.
 */
export function planOlxCategoryFetch(input: {
  committedBoundary?: string;
  catchup?: OlxCatchupState;
  bootstrapTarget?: string;
  pageBudget?: number;
}): {
  mode: OlxWalkMode;
  pages: number[];
  catchupTarget?: string;
} {
  const budget = Math.max(1, Math.min(input.pageBudget ?? OLX_BROWSER_PAGE_BUDGET, 3));
  if (!input.committedBoundary && !input.catchup && !input.bootstrapTarget) {
    return { mode: "seed", pages: [1] };
  }
  const catchupTarget = input.catchup?.target ?? input.bootstrapTarget ?? input.committedBoundary;
  const resumePage = input.catchup?.resumePage ?? 1;
  if (resumePage > 1) {
    // Always recheck page 1 for insertions/promotions, then continue at the owed
    // resume page. Using (resumePage - 1) with budget 2 permanently stalls:
    // resumePage=3 → [1,2] → next resume 3 (prod apartments stuck here).
    const pages = [1];
    for (let page = resumePage; pages.length < budget; page += 1) {
      if (!pages.includes(page)) {
        pages.push(page);
      }
    }
    return {
      mode: "catchup",
      pages,
      ...(catchupTarget ? { catchupTarget } : {}),
    };
  }
  const pages = Array.from({ length: budget }, (_, i) => i + 1);
  const mode: OlxWalkMode =
    input.committedBoundary && !input.catchup && !input.bootstrapTarget ? "steady" : "catchup";
  return {
    mode,
    pages,
    ...(catchupTarget ? { catchupTarget } : {}),
  };
}

/** @deprecated Prefer planOlxCategoryFetch. */
export function planOlxBrowserPages(input: {
  pageBudget?: number;
  mode?: OlxWalkMode;
}): number[] {
  if (input.mode === "seed") {
    return [1];
  }
  // Default (and steady/catchup) walks the configured page budget from page 1.
  return planOlxCategoryFetch({
    committedBoundary: "1970-01-01T00:00:00.000Z",
    ...(input.mode === "catchup"
      ? { catchup: { target: "1970-01-01T00:00:00.000Z", resumePage: 1 } }
      : {}),
    ...(input.pageBudget !== undefined ? { pageBudget: input.pageBudget } : {}),
  }).pages;
}

/**
 * Organic (non-promoted) publication times drive optional verified-sort stops.
 * Promoted / top_ad cards must not alone end a newest-first walk.
 */
export function organicPublicationTimes(
  listings: Array<{
    publishedAt?: Date | undefined;
    metadata?: Record<string, unknown> | undefined;
  }>,
): Date[] {
  const times: Date[] = [];
  for (const listing of listings) {
    if (listing.metadata?.olxIsPromoted === true) {
      continue;
    }
    if (listing.publishedAt instanceof Date && Number.isFinite(listing.publishedAt.getTime())) {
      times.push(listing.publishedAt);
    }
  }
  return times;
}

export function countUndatedOrganic(
  listings: Array<{
    publishedAt?: Date | undefined;
    metadata?: Record<string, unknown> | undefined;
  }>,
): number {
  let count = 0;
  for (const listing of listings) {
    if (listing.metadata?.olxIsPromoted === true) {
      continue;
    }
    if (!(listing.publishedAt instanceof Date) || !Number.isFinite(listing.publishedAt.getTime())) {
      count += 1;
    }
  }
  return count;
}

/**
 * Publication-time stop for a verified newest-first ordering only.
 *
 * Default `sortVerified=false` (HTML path BLOCKED): always returns false.
 * A majority of old dated cards does **not** prove later pages are old, and
 * excluding undated cards from the denominator is unsafe — both are rejected.
 *
 * When `sortVerified=true` (future): every dated organic sample must be at or
 * older than watermark−overlap, and no undated organic cards may be present.
 */
/**
 * Listing-level newest-first check for organic publication times (epoch seconds).
 * Used by live sort probes; HTTP 200 / URL retention must not bypass this.
 */
export function isNonIncreasingCreatedTimes(times: readonly number[]): boolean {
  if (times.length < 3) {
    return false;
  }
  for (let i = 1; i < times.length; i += 1) {
    if (times[i]! > times[i - 1]!) {
      return false;
    }
  }
  return true;
}

export function crossedOlxPublicationBoundary(
  organicTimes: readonly Date[],
  watermark: Date | undefined,
  overlapMs = OLX_BROWSER_PUBLICATION_OVERLAP_MS,
  options: {
    minDated?: number;
    /** @deprecated Majority stop removed; ignored. */
    minFraction?: number;
    sortVerified?: boolean;
    undatedOrganicCount?: number;
  } = {},
): boolean {
  if (options.sortVerified !== true) {
    return false;
  }
  if (!watermark || organicTimes.length === 0) {
    return false;
  }
  if ((options.undatedOrganicCount ?? 0) > 0) {
    return false;
  }
  const minDated = options.minDated ?? OLX_BROWSER_BOUNDARY_MIN_DATED;
  if (organicTimes.length < minDated) {
    return false;
  }
  const threshold = watermark.getTime() - overlapMs;
  return organicTimes.every((d) => d.getTime() <= threshold);
}

export type OlxPageCatalogEvidence =
  | "confirmed_empty"
  | "parse_failed"
  | "has_listings"
  | "unknown";

/**
 * Distinguish genuine end-of-results from a broken/empty parse.
 * Zero validated cards alone is never sufficient to claim the catalog ended.
 */
export function classifyOlxPageCatalogEvidence(extracted: {
  listings: readonly unknown[];
  accessibilityOk: boolean;
  rawOfferCount: number;
  htmlDiagnostics?: {
    hasPrerenderedState?: boolean;
    prerenderedAdsPathFound?: boolean;
  };
  rejections?: readonly { reason: string }[];
}): OlxPageCatalogEvidence {
  if (extracted.listings.length > 0) {
    return "has_listings";
  }
  const diag = extracted.htmlDiagnostics;
  if (
    diag?.hasPrerenderedState === true &&
    diag.prerenderedAdsPathFound === true &&
    extracted.rawOfferCount === 0
  ) {
    return "confirmed_empty";
  }
  if (
    extracted.accessibilityOk ||
    diag?.hasPrerenderedState === false ||
    (extracted.rejections?.length ?? 0) > 0
  ) {
    return "parse_failed";
  }
  return "unknown";
}

/** Map OLX browser category names onto IncrementalCoverage apartment|house keys. */
export function olxCategoryToCoverageKey(
  category: OlxBrowserCategoryName,
): "apartment" | "house" {
  return category === "apartments" ? "apartment" : "house";
}

export function assessOlxBrowserWalk(input: {
  mode: OlxWalkMode;
  plannedPages: number[];
  fetchedPages: number[];
  lastPageCardCount: number;
  /** Positive empty/end evidence on the last fetched page — not merely 0 parsed cards. */
  lastPageCatalogEvidence: OlxPageCatalogEvidence;
  crossedBoundary: boolean;
  failed: boolean;
  newestOrganic?: string;
  catchupTarget?: string;
  previousCommitted?: string;
}): {
  boundaryReached: boolean;
  coverageTruncated: boolean;
  committed?: string;
  catchup: OlxCatchupState | null;
} {
  const target = input.catchupTarget ?? input.previousCommitted;
  const keep = (resumePage: number): OlxCatchupState | null =>
    target ? { target, resumePage } : null;

  if (input.mode === "seed") {
    if (input.failed || !input.newestOrganic) {
      return { boundaryReached: false, coverageTruncated: true, catchup: null };
    }
    // Monitoring start only — does not claim deep catalog coverage.
    return {
      boundaryReached: true,
      coverageTruncated: false,
      committed: input.newestOrganic,
      catchup: null,
    };
  }

  if (input.failed) {
    // Prefer the next planned page not yet fetched (failure on the owed page),
    // otherwise retry the last successfully fetched page.
    const failedPage =
      input.plannedPages[input.fetchedPages.length] ??
      input.fetchedPages[input.fetchedPages.length - 1] ??
      input.plannedPages[0] ??
      1;
    return {
      boundaryReached: false,
      coverageTruncated: true,
      catchup: keep(failedPage),
    };
  }

  // Confirmed empty or (future) verified-sort crossing closes the gap.
  if (input.crossedBoundary || input.lastPageCatalogEvidence === "confirmed_empty") {
    return {
      boundaryReached: true,
      coverageTruncated: false,
      ...(input.newestOrganic ? { committed: input.newestOrganic } : {}),
      catchup: null,
    };
  }

  if (input.lastPageCatalogEvidence === "parse_failed") {
    const failedPage = input.fetchedPages[input.fetchedPages.length - 1] ?? 1;
    return {
      boundaryReached: false,
      coverageTruncated: true,
      catchup: keep(failedPage),
    };
  }

  if (input.fetchedPages.length < input.plannedPages.length) {
    const next = input.plannedPages[input.fetchedPages.length] ?? 1;
    return {
      boundaryReached: false,
      coverageTruncated: true,
      catchup: keep(next),
    };
  }

  // Page budget exhausted while cards remain — persist catch-up; do not rescan only page 1.
  // Use the highest fetched page so non-contiguous plans like [1, resumePage] advance.
  const last = input.fetchedPages.length > 0 ? Math.max(...input.fetchedPages) : 1;
  return {
    boundaryReached: false,
    coverageTruncated: true,
    catchup: keep(last + 1),
  };
}

export type OlxPrivateScanNoteInput = {
  distanceKm: number | null;
  apartmentsStatus: string;
  apartmentsExpectedPages: number | null;
  apartmentsFetchedPages: number[];
  apartmentsTotalElements: number | null;
  housesStatus: string;
  housesExpectedPages: number | null;
  housesFetchedPages: number[];
  housesTotalElements: number | null;
  businessLeakCount: number;
};

/** Production coverage notes. A page cursor is not an input and is not a result. */
export function olxPrivateCatalogNotes(input: OlxPrivateScanNoteInput): string[] {
  const pagesComplete =
    input.apartmentsStatus === "complete" && input.housesStatus === "complete";
  const degraded = !pagesComplete || input.businessLeakCount > 0;
  return [
    "olx_browser_catalog=private_only",
    "olx_browser_private_filter=search[private_business]=private",
    "olx_browser_private_is_not_owner=true",
    `olx_browser_distance_km=${input.distanceKm === null ? "omit" : input.distanceKm}`,
    "olx_browser_concurrency=1",
    "olx_browser_end_condition=structured_totalPages",
    "olx_browser_sort_not_used_for_coverage=true",
    "olx_browser_publication_time_stop=not_used",
    "olx_browser_page_cursor_not_used_for_coverage=true",
    `olx_private_apartments_status=${input.apartmentsStatus}`,
    `olx_private_apartments_expected_pages=${input.apartmentsExpectedPages ?? "none"}`,
    `olx_private_apartments_fetched_pages=${input.apartmentsFetchedPages.join(",") || "none"}`,
    `olx_private_apartments_total_elements=${input.apartmentsTotalElements ?? "none"}`,
    `olx_private_houses_status=${input.housesStatus}`,
    `olx_private_houses_expected_pages=${input.housesExpectedPages ?? "none"}`,
    `olx_private_houses_fetched_pages=${input.housesFetchedPages.join(",") || "none"}`,
    `olx_private_houses_total_elements=${input.housesTotalElements ?? "none"}`,
    `olx_private_business_leak_count=${input.businessLeakCount}`,
    `olx_browser_full_scan_status=${degraded ? "degraded" : "complete"}`,
  ];
}

/**
 * Retired notes for the page-budget walk. Do not log these as production coverage.
 * `full_scan_status=blocked` described the unfiltered catalog, not the private scan.
 */
export function olxBrowserCoverageNotes(input: {
  distanceKm: number | null;
  pageBudget: number;
  pagesFetched: number;
  boundaryReached: boolean;
  coverageTruncated: boolean;
  mode?: OlxWalkMode;
  catchupResume?: string;
}): string[] {
  return [
    "retired_page_budget_notes_not_collection_coverage=true",
    `olx_browser_distance_km=${input.distanceKm === null ? "omit" : input.distanceKm}`,
    `olx_browser_page_budget=${input.pageBudget}`,
    `olx_browser_pages_fetched=${input.pagesFetched}`,
    `olx_browser_boundary_reached=${input.boundaryReached}`,
    `olx_browser_coverage_truncated=${input.coverageTruncated}`,
    ...(input.mode ? [`olx_browser_walk_mode=${input.mode}`] : []),
    ...(input.catchupResume ? [`olx_browser_catchup_resume=${input.catchupResume}`] : []),
    "olx_browser_sort_requested=search[order]=created_at:desc",
    "olx_browser_radius_status=live_verified_2026-09-26",
    "olx_browser_sort_status=blocked",
    "olx_browser_full_scan_status=blocked",
    "olx_browser_full_scan_note=apartments_catalog_end_unproven_page_cursor_unsafe",
    "olx_browser_radius_sort_note=radius_suburb_listing_evidence_pass_sort_organic_created_not_monotone_2026-09-26",
    "olx_browser_time_stop=disabled_until_html_sort_verified",
    "olx_browser_stop=seed_commit_or_confirmed_empty_or_catchup_budget",
  ];
}

export function formatOlxCoverage(coverage: {
  pagesFetched: number;
  cardsFetched: number;
  boundaryReached: boolean;
  coverageTruncated: boolean;
  oldestObservedPublication?: string;
  newestObservedPublication?: string;
  catchup?: Partial<Record<"apartment" | "house", { target: string; resumePage: number } | null>>;
}): string {
  const catchup = coverage.catchup;
  const resume = catchup
    ? (["apartment", "house"] as const)
        .map((category) => {
          const state = catchup[category];
          return state ? `${category}:${state.resumePage}` : undefined;
        })
        .filter((item): item is string => item !== undefined)
        .join(",")
    : "";
  return [
    "olx_private_catalog",
    "page_cursor_not_coverage=true",
    `pagesFetched=${coverage.pagesFetched}`,
    `cardsFetched=${coverage.cardsFetched}`,
    `boundaryReached=${coverage.boundaryReached}`,
    `coverageTruncated=${coverage.coverageTruncated}`,
    `oldestObservedPublication=${coverage.oldestObservedPublication ?? "none"}`,
    `newestObservedPublication=${coverage.newestObservedPublication ?? "none"}`,
    `retiredPageCursor=${resume || "none"}`,
  ].join(" ");
}
