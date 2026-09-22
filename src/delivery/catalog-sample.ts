/**
 * Safety cap for one already-downloaded catalog response.
 * Live first responses on 2026-09-22 were LUN 24 cards per category and
 * OLX 51 apartments plus 36 houses. 120 sits above those pages, so a normal
 * first response is kept whole. The cap only stops a runaway payload.
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
