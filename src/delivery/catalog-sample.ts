import type { IncrementalCoverage } from "../domain/source.ts";

/**
 * Safety cap for one already-downloaded catalog response.
 * Live first responses on 2026-09-22 were LUN 24 cards per category and
 * OLX 51 apartments plus 36 houses. 120 sits above those pages, so a normal
 * first response is kept whole. The cap only stops a runaway payload.
 * Hitting the cap is incomplete coverage: the kept cards stay usable, and the
 * poll records coverage_degraded.
 */
export const ACQUIRED_RESPONSE_CAP_PER_CATEGORY = 120;

export function keepAcquiredByCategory<T extends { propertyType: string }>(
  listings: T[],
  capPerCategory = ACQUIRED_RESPONSE_CAP_PER_CATEGORY,
): { kept: T[]; truncated: boolean } {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const listing of listings) {
    const key =
      listing.propertyType === "apartment" || listing.propertyType === "house"
        ? listing.propertyType
        : "other";
    const group = groups.get(key);
    if (group) {
      group.push(listing);
    } else {
      groups.set(key, [listing]);
      order.push(key);
    }
  }
  let truncated = false;
  const kept: T[] = [];
  for (const key of order) {
    const group = groups.get(key) ?? [];
    if (group.length > capPerCategory) {
      truncated = true;
    }
    kept.push(...group.slice(0, capPerCategory));
  }
  return { kept, truncated };
}

/** Present only when the local cap drops cards. A full acquired page leaves coverage unset. */
export function coverageForAcquiredCards(
  cardsFetched: number,
  truncated: boolean,
): IncrementalCoverage | undefined {
  if (!truncated) {
    return undefined;
  }
  return {
    pagesFetched: 1,
    cardsFetched,
    boundaryReached: false,
    coverageTruncated: true,
  };
}
