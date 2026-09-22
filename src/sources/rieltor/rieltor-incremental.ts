import type { Listing } from "../../domain/listing.ts";
import type { IncrementalCoverage } from "../../domain/source.ts";

/** Public RIELTOR menu value whose live pages were newest-first on 2026-09-22. */
export const RIELTOR_NEWEST_SORT = "bycreated";

/** Keep this much publication-time overlap so a small reorder is still collected. */
export const RIELTOR_INCREMENTAL_OVERLAP_MS = 30 * 60 * 1000;

/** Safety guard. Reaching it before the publication boundary is a truncated scan. */
export const RIELTOR_INCREMENTAL_MAX_PAGES = 3;

export type RieltorCategoryName = "apartment" | "house";

export type RieltorIncrementalCoverage = IncrementalCoverage;

export function rieltorPublicationBoundaryKey(category: RieltorCategoryName): string {
  return `rieltor_incremental_boundary_${category}`;
}

export function crossedRieltorPublicationBoundary(
  publishedAt: Date | undefined,
  watermark: Date | undefined,
  overlapMs = RIELTOR_INCREMENTAL_OVERLAP_MS,
): boolean {
  if (!watermark || !publishedAt) {
    return false;
  }
  return publishedAt.getTime() <= watermark.getTime() - overlapMs;
}

export function publicationRange(listings: Pick<Listing, "publishedAt">[]): {
  oldest?: string;
  newest?: string;
} {
  const times = listings
    .map((listing) => listing.publishedAt?.getTime())
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (times.length === 0) {
    return {};
  }
  return {
    oldest: new Date(Math.min(...times)).toISOString(),
    newest: new Date(Math.max(...times)).toISOString(),
  };
}

/**
 * A scan with no stored watermark establishes page 1 and is not a truncated catalog claim.
 * A later scan that hits the page guard first is truncated and must not look complete.
 */
export function finalizeRieltorCoverage(input: {
  hadWatermark: boolean;
  pagesFetched: number;
  boundaryReached: boolean;
  maxPages?: number;
}): { boundaryReached: boolean; coverageTruncated: boolean } {
  if (!input.hadWatermark) {
    return { boundaryReached: true, coverageTruncated: false };
  }
  const maxPages = input.maxPages ?? RIELTOR_INCREMENTAL_MAX_PAGES;
  const coverageTruncated = !input.boundaryReached && input.pagesFetched >= maxPages;
  return { boundaryReached: input.boundaryReached, coverageTruncated };
}

export function formatRieltorCoverage(coverage: RieltorIncrementalCoverage): string {
  return [
    "rieltor_incremental",
    `pagesFetched=${coverage.pagesFetched}`,
    `cardsFetched=${coverage.cardsFetched}`,
    `boundaryReached=${coverage.boundaryReached}`,
    `coverageTruncated=${coverage.coverageTruncated}`,
    `oldestObservedPublication=${coverage.oldestObservedPublication ?? "none"}`,
    `newestObservedPublication=${coverage.newestObservedPublication ?? "none"}`,
  ].join(" ");
}
