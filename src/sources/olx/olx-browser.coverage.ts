import {
  OLX_DISTANCE_KM,
} from "./olx.source.ts";

/**
 * OLX browser catalog coverage contract (Lviv long-term rent).
 *
 * Verified HTTP `api/v1/offers` controls (2026-09-15): city_id=176, distance=15,
 * sort_by=created_at:desc, categories 1760/330. Those API params are the
 * product radius/sort contract.
 *
 * Browser HTML catalogs use path `/…/lvov/` plus the portal filter query keys
 * that OLX retains on redirect (`search[dist]`, `search[order]`). Live checks
 * on 2026-09-26 kept `search[dist]=15` / `search[order]=created_at:desc` in
 * finalUrl with HTTP 200. Suburb membership for the HTML path is confirmed for
 * the API (`distance=15`); HTML suburb samples are reported in coverage notes
 * when extract succeeds.
 *
 * Bare `/lvov/` (no dist) is city-scoped and does not satisfy ~15 km.
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

export type OlxBrowserCategoryName = "apartments" | "houses";

export function buildOlxBrowserCategoryUrl(
  category: OlxBrowserCategoryName,
  options: {
    page?: number;
    /** Defaults to OLX_DISTANCE_KM (15). Pass null to omit (city-only). */
    distanceKm?: number | null;
    /** Newest-first. Omit only for diagnostic bare-path probes. */
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
  /** When unset, seed = page 1 only is incorrect for coverage — use full budget. */
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

export function crossedOlxPublicationBoundary(
  organicTimes: readonly Date[],
  watermark: Date | undefined,
  overlapMs = OLX_BROWSER_PUBLICATION_OVERLAP_MS,
): boolean {
  if (!watermark || organicTimes.length === 0) {
    return false;
  }
  const oldest = Math.min(...organicTimes.map((d) => d.getTime()));
  return oldest <= watermark.getTime() - overlapMs;
}

export function assessOlxBrowserWalk(input: {
  plannedPages: number[];
  fetchedPages: number[];
  lastPageCardCount: number;
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
  if (input.crossedBoundary || input.lastPageCardCount === 0) {
    return {
      boundaryReached: true,
      coverageTruncated: false,
      ...(input.newestOrganic ? { committed: input.newestOrganic } : {}),
    };
  }
  if (input.fetchedPages.length < input.plannedPages.length) {
    return { boundaryReached: false, coverageTruncated: true };
  }
  // Page budget exhausted while the last page still had cards → partial coverage.
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
    "olx_browser_sort=search[order]=created_at:desc",
    "olx_browser_stop=publication_boundary_or_empty_page_or_budget_not_known_card",
  ];
}
