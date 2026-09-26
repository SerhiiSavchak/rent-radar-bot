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
 * - sort (`search[order]=created_at:desc`): BLOCKED — organic `createdTime` /
 *   `lastRefreshTime` sequences are not non-increasing; URL retention alone is
 *   not proof. Publication-time stop stays off until sort is listing-verified.
 * Do not treat HTTP 200, fixtures, or a single OK request as coverage PASS.
 *
 * Because HTML sort is unverified, publication-time stop must not mark a walk
 * complete. Progress uses seed → committed boundary, then page catch-up cursors,
 * and confirmed-empty catalog evidence only.
 */
export const OLX_BROWSER_APARTMENTS_PATH =
  "/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/";
export const OLX_BROWSER_HOUSES_PATH = "/uk/nedvizhimost/doma/arenda-domov/lvov/";

/**
 * Per-category page budget inside one poll.
 *
 * Observed steady volume on city page-1 was ~81–89 combined apartments+houses
 * (~40–55/category). Two pages ≈ 80–110 organic cards/category before the
 * acquired-response cap (120). At a 10-minute poll that covers normal churn
 * and a short downtime backlog without pretending deep history is complete.
 * Exhausting this budget before the publication boundary → coverage_degraded
 * and a stored catch-up cursor (next poll continues; does not rescan only page 1).
 */
export const OLX_BROWSER_PAGE_BUDGET = 2;

/** Overlap so a small reorder / promoted interleave does not truncate the walk. */
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
    /** Requested newest-first filter key. Application is unverified for HTML. */
    orderCreatedDesc?: boolean;
  } = {},
): string {
  const path = category === "apartments" ? OLX_BROWSER_APARTMENTS_PATH : OLX_BROWSER_HOUSES_PATH;
  const params = new URLSearchParams();
  const distance = options.distanceKm === undefined ? OLX_DISTANCE_KM : options.distanceKm;
  if (distance !== null && distance !== undefined) {
    params.set("search[dist]", String(distance));
  }
  if (options.orderCreatedDesc !== false) {
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
 * Plan pages for one category. Seed is page 1 only (monitoring start).
 * Catch-up always rechecks page 1 for new listings, then resumes deeper pages.
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
    const pages = [1];
    for (let page = Math.max(2, resumePage - 1); pages.length < budget; page += 1) {
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
    const failedPage =
      input.fetchedPages[input.fetchedPages.length - 1] ??
      input.plannedPages[input.fetchedPages.length] ??
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
  const last = input.fetchedPages[input.fetchedPages.length - 1] ?? 1;
  return {
    boundaryReached: false,
    coverageTruncated: true,
    catchup: keep(last + 1),
  };
}

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
    "olx_browser_radius_sort_note=radius_suburb_listing_evidence_pass_sort_organic_order_not_monotone",
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
    "olx_incremental",
    `pagesFetched=${coverage.pagesFetched}`,
    `cardsFetched=${coverage.cardsFetched}`,
    `boundaryReached=${coverage.boundaryReached}`,
    `coverageTruncated=${coverage.coverageTruncated}`,
    `oldestObservedPublication=${coverage.oldestObservedPublication ?? "none"}`,
    `newestObservedPublication=${coverage.newestObservedPublication ?? "none"}`,
    `catchupResume=${resume || "none"}`,
  ].join(" ");
}
