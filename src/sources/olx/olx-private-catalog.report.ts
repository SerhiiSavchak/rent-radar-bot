import type { OlxBrowserExtractResult, OlxPrivateCategoryScan } from "./olx-browser.extract.ts";

export type OlxPrivateCatalogReport = {
  commit: string;
  apartmentsExpectedPages: number | null;
  apartmentsFetchedPages: number[];
  apartmentsTotalElements: number | null;
  housesExpectedPages: number | null;
  housesFetchedPages: number[];
  housesTotalElements: number | null;
  uniqueListingIds: number;
  businessLeakCount: number;
  parserFailures: string[];
  navigationFailures: string[];
  otherFailures: string[];
  elapsedMs: number;
  complete: boolean;
  healthDegraded: boolean;
};

function classify(
  category: "apartments" | "houses",
  scan: OlxPrivateCategoryScan | undefined,
  parserFailures: string[],
  navigationFailures: string[],
  otherFailures: string[],
): void {
  if (!scan) {
    parserFailures.push(`${category}:missing_scan`);
    return;
  }
  if (scan.status === "complete") {
    return;
  }
  if (scan.status === "navigation_failed") {
    navigationFailures.push(category);
    return;
  }
  if (scan.status === "parser_failure") {
    parserFailures.push(category);
    return;
  }
  otherFailures.push(`${category}:${scan.status}`);
}

/**
 * Read-only summary of one private-catalog extract.
 * `complete` means both categories fetched every structured page.
 * A Business leak keeps `complete` when those cards were rejected, and sets
 * `healthDegraded`. A stored page cursor is not part of this report.
 */
export function buildOlxPrivateCatalogReport(input: {
  commit: string;
  elapsedMs: number;
  result: OlxBrowserExtractResult;
}): OlxPrivateCatalogReport {
  const apartments = input.result.privateScan?.apartments;
  const houses = input.result.privateScan?.houses;
  const parserFailures: string[] = [];
  const navigationFailures: string[] = [];
  const otherFailures: string[] = [];
  classify("apartments", apartments, parserFailures, navigationFailures, otherFailures);
  classify("houses", houses, parserFailures, navigationFailures, otherFailures);
  const businessLeakCount =
    (apartments?.businessLeakCount ?? 0) + (houses?.businessLeakCount ?? 0);
  const businessStillReturned = input.result.listings.some(
    (listing) => listing.metadata?.olxIsBusiness === true,
  );
  if (businessStillReturned) {
    otherFailures.push("business_card_not_rejected");
  }
  const pagesComplete =
    apartments?.status === "complete" &&
    houses?.status === "complete" &&
    parserFailures.length === 0 &&
    navigationFailures.length === 0 &&
    otherFailures.length === 0;
  return {
    commit: input.commit,
    apartmentsExpectedPages: apartments?.expectedPages ?? null,
    apartmentsFetchedPages: apartments?.fetchedPages ?? [],
    apartmentsTotalElements: apartments?.totalElements ?? null,
    housesExpectedPages: houses?.expectedPages ?? null,
    housesFetchedPages: houses?.fetchedPages ?? [],
    housesTotalElements: houses?.totalElements ?? null,
    uniqueListingIds: new Set(input.result.listings.map((listing) => listing.sourceId)).size,
    businessLeakCount,
    parserFailures,
    navigationFailures,
    otherFailures,
    elapsedMs: input.elapsedMs,
    complete: pagesComplete,
    healthDegraded: !pagesComplete || businessLeakCount > 0,
  };
}
