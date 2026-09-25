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
 * HTTP 200 with those params retained in finalUrl does **not** prove the filter
 * is applied. Live suburb/order evidence for the HTML path remains
 * `olx_browser_radius_sort_status=blocked` until listing samples confirm it.
 * Do not treat URL retention or API-to-HTML analogy as coverage PASS.
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
 * Exhausting this budget before the publication boundary → coverage_degraded.
 */
export const OLX_BROWSER_PAGE_BUDGET = 2;

/** Overlap so a small reorder / promoted interleave does not truncate the walk. */
export const OLX_BROWSER_PUBLICATION_OVERLAP_MS = 30 * 60 * 1000;

/**
 * Crossing requires enough dated organic samples and a majority at/older than
 * the watermark. A single old outlier or missing dates must not end the walk.
 */
export const OLX_BROWSER_BOUNDARY_MIN_DATED = 3;
export const OLX_BROWSER_BOUNDARY_MIN_FRACTION = 0.5;

export type OlxBrowserCategoryName = "apartments" | "houses";

export function olxPublicationBoundaryKey(category: OlxBrowserCategoryName): string {
  return `olx_incremental_boundary_${category}`;
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

export function planOlxBrowserPages(input: {
  pageBudget?: number;
  mode?: "seed" | "steady" | "catchup";
}): number[] {
  const budget = Math.max(1, Math.min(input.pageBudget ?? OLX_BROWSER_PAGE_BUDGET, 3));
  // Seed still walks the budget: first-page-only under-covers after restart.
  return Array.from({ length: budget }, (_, i) => i + 1);
}

/**
 * Organic (non-promoted) publication times drive stop decisions.
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

/**
 * True only when enough dated organic samples exist and a majority are at or
 * older than watermark−overlap. Missing dates and single outliers do not cross.
 */
export function crossedOlxPublicationBoundary(
  organicTimes: readonly Date[],
  watermark: Date | undefined,
  overlapMs = OLX_BROWSER_PUBLICATION_OVERLAP_MS,
  options: { minDated?: number; minFraction?: number } = {},
): boolean {
  if (!watermark || organicTimes.length === 0) {
    return false;
  }
  const minDated = options.minDated ?? OLX_BROWSER_BOUNDARY_MIN_DATED;
  const minFraction = options.minFraction ?? OLX_BROWSER_BOUNDARY_MIN_FRACTION;
  if (organicTimes.length < minDated) {
    return false;
  }
  const threshold = watermark.getTime() - overlapMs;
  const olderOrEqual = organicTimes.filter((d) => d.getTime() <= threshold).length;
  return olderOrEqual / organicTimes.length >= minFraction;
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
  plannedPages: number[];
  fetchedPages: number[];
  lastPageCardCount: number;
  /** Positive empty/end evidence on the last fetched page — not merely 0 parsed cards. */
  lastPageCatalogEvidence: OlxPageCatalogEvidence;
  crossedBoundary: boolean;
  failed: boolean;
  newestOrganic?: string;
}): {
  boundaryReached: boolean;
  coverageTruncated: boolean;
  committed?: string;
} {
  if (input.failed) {
    return { boundaryReached: false, coverageTruncated: true };
  }
  if (input.crossedBoundary) {
    return {
      boundaryReached: true,
      coverageTruncated: false,
      ...(input.newestOrganic ? { committed: input.newestOrganic } : {}),
    };
  }
  if (input.lastPageCatalogEvidence === "confirmed_empty") {
    return {
      boundaryReached: true,
      coverageTruncated: false,
      ...(input.newestOrganic ? { committed: input.newestOrganic } : {}),
    };
  }
  if (input.lastPageCatalogEvidence === "parse_failed") {
    return { boundaryReached: false, coverageTruncated: true };
  }
  if (input.fetchedPages.length < input.plannedPages.length) {
    return { boundaryReached: false, coverageTruncated: true };
  }
  // Page budget exhausted while the last page still had cards (or unknown empty).
  return {
    boundaryReached: false,
    coverageTruncated: true,
  };
}

export function olxBrowserCoverageNotes(input: {
  distanceKm: number | null;
  pageBudget: number;
  pagesFetched: number;
  boundaryReached: boolean;
  coverageTruncated: boolean;
}): string[] {
  return [
    `olx_browser_distance_km=${input.distanceKm === null ? "omit" : input.distanceKm}`,
    `olx_browser_page_budget=${input.pageBudget}`,
    `olx_browser_pages_fetched=${input.pagesFetched}`,
    `olx_browser_boundary_reached=${input.boundaryReached}`,
    `olx_browser_coverage_truncated=${input.coverageTruncated}`,
    "olx_browser_sort_requested=search[order]=created_at:desc",
    "olx_browser_radius_sort_status=blocked",
    "olx_browser_radius_sort_note=url_retention_or_api_analogy_is_not_html_proof",
    "olx_browser_stop=majority_organic_boundary_or_confirmed_empty_or_budget",
  ];
}
