/**
 * Cards already present in one catalog response on 2026-09-22:
 * LUN 24 per category, DIM.RIA at least 20 apartments, OLX browser 51 apartments
 * and 36 houses. The poll keeps that response instead of a global prefix of 10.
 * 80 leaves headroom over the measured OLX page without a second request.
 */
export const CATALOG_CARDS_PER_CATEGORY = 80;

export function catalogSampleLimit(categoryCount = 2): number {
  return CATALOG_CARDS_PER_CATEGORY * Math.max(1, categoryCount);
}

export function keepBalancedCatalogSample<T extends { propertyType: string }>(
  listings: T[],
  totalLimit: number,
): T[] {
  const order = ["apartment", "house", "other"] as const;
  const groups = new Map<string, T[]>();
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
    }
  }
  const present = order.filter((key) => (groups.get(key)?.length ?? 0) > 0);
  if (present.length === 0) {
    return [];
  }
  const perGroup = Math.max(1, Math.ceil(totalLimit / present.length));
  const kept: T[] = [];
  for (const key of present) {
    kept.push(...(groups.get(key) ?? []).slice(0, perGroup));
  }
  return kept;
}
