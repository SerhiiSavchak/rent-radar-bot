export type OlxProfileDecision = {
  verdict: "profile_likely_intermediary" | "unknown";
  evidence: string;
};

/**
 * Public OLX profile inventory from the listing's own `/uk/list/user/{slug}/` link.
 *
 * Live counts on 2026-09-24, one stock Chromium, page 2 followed only from the
 * profile's own `page=2` link:
 * - Надія `1811096174`: 6 total, 1 page, 6 visible, 2 real-estate (ratio 0.33).
 * - Ксенія `11299243`: 2 total, 1 page, 2 real-estate.
 * - Юліан `172271722`: 1 total, 1 page, 1 real-estate.
 * - Наталя Ткачук `28160545`: 13 total, 2 pages, 10+3 visible, 13 real-estate.
 * - Наталія `24346513`: 21 total, 3 pages, first two pages 10+10 real-estate.
 *
 * Ten real-estate ads is the full first page both professional profiles filled.
 * Two real-estate ads, or one real-estate ad among other goods, stay unknown.
 */
export const OLX_PROFILE_REAL_ESTATE_MIN = 10;

/** A likely profile stays cached. The seller already showed a large inventory. */
export const OLX_PROFILE_LIKELY_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A small or mixed profile is rechecked within the hour. 45 minutes is three to
 * four 10-minute polls, short enough to notice a growing inventory and long
 * enough not to open Chromium for the same seller every cycle.
 */
export const OLX_PROFILE_UNKNOWN_TTL_MS = 45 * 60 * 1000;

/** A failed read stays sendable and is retried later, not on every cycle. */
export const OLX_PROFILE_FAILURE_TTL_MS = 60 * 60 * 1000;

/** New profile navigations per cycle. Past this, the listing is deferred, not sent. */
export const OLX_PROFILE_PROBE_BUDGET = 4;

export type OlxProfileSnapshot = {
  acquired: boolean;
  totalPages?: number;
  totalElements?: number;
  visibleAds?: number;
  realEstateAds?: number;
  realEstateRatio?: number;
};

export function findOlxPublicProfilePath(html: string): string | undefined {
  const match = html.match(/\/uk\/list\/user\/[A-Za-z0-9]+\/?/);
  if (!match) {
    return undefined;
  }
  return match[0].endsWith("/") ? match[0] : `${match[0]}/`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isRealEstateAd(raw: unknown): boolean {
  const category = asRecord(asRecord(raw)?.category);
  return category?.type === "real_estate";
}

function withRatio(snapshot: OlxProfileSnapshot): OlxProfileSnapshot {
  const visible = snapshot.visibleAds ?? 0;
  const realEstate = snapshot.realEstateAds ?? 0;
  return {
    ...snapshot,
    realEstateRatio: visible === 0 ? 0 : realEstate / visible,
  };
}

/**
 * Reads one page of `userListing.userListing`. Missing counters stay unacquired.
 */
export function parseOlxProfileInventory(state: unknown): OlxProfileSnapshot {
  const nested = asRecord(asRecord(asRecord(state)?.userListing)?.userListing);
  const totalPages = nested?.totalPages;
  const totalElements = nested?.totalElements;
  if (typeof totalPages !== "number" || typeof totalElements !== "number") {
    return { acquired: false };
  }
  const ads = Array.isArray(nested?.ads) ? nested.ads : [];
  const realEstateAds = ads.filter((ad) => isRealEstateAd(ad)).length;
  return withRatio({
    acquired: true,
    totalPages,
    totalElements,
    visibleAds: ads.length,
    realEstateAds,
  });
}

/** Adds a second public page onto the first. Totals stay from the first page. */
export function mergeOlxProfilePages(
  first: OlxProfileSnapshot,
  second: OlxProfileSnapshot,
): OlxProfileSnapshot {
  if (!first.acquired) {
    return second.acquired ? withRatio(second) : { acquired: false };
  }
  if (!second.acquired) {
    return withRatio(first);
  }
  const visibleAds = (first.visibleAds ?? 0) + (second.visibleAds ?? 0);
  const realEstateAds = (first.realEstateAds ?? 0) + (second.realEstateAds ?? 0);
  return withRatio({
    acquired: true,
    ...(first.totalPages !== undefined ? { totalPages: first.totalPages } : {}),
    ...(first.totalElements !== undefined ? { totalElements: first.totalElements } : {}),
    visibleAds,
    realEstateAds,
  });
}

export function classifyOlxProfileInventory(snapshot: OlxProfileSnapshot): OlxProfileDecision {
  if (
    !snapshot.acquired ||
    snapshot.totalPages === undefined ||
    snapshot.totalElements === undefined ||
    snapshot.realEstateAds === undefined ||
    snapshot.visibleAds === undefined
  ) {
    return { verdict: "unknown", evidence: "olx_profile_unreadable" };
  }
  const ratio = snapshot.visibleAds === 0 ? 0 : snapshot.realEstateAds / snapshot.visibleAds;
  const evidence = [
    `olx_pages=${snapshot.totalPages}`,
    `olx_total=${snapshot.totalElements}`,
    `olx_visible=${snapshot.visibleAds}`,
    `olx_real_estate_count=${snapshot.realEstateAds}`,
    `olx_real_estate_ratio=${Math.round(ratio * 100)}`,
  ].join(";");
  if (snapshot.realEstateAds >= OLX_PROFILE_REAL_ESTATE_MIN) {
    return { verdict: "profile_likely_intermediary", evidence };
  }
  return { verdict: "unknown", evidence };
}

export function olxProfileEvidence(snapshot: OlxProfileSnapshot, checkedAt: Date): string {
  const decision = classifyOlxProfileInventory(snapshot);
  const checked = `olx_checked_at=${checkedAt.toISOString()}`;
  if (decision.evidence === "olx_profile_unreadable") {
    return `olx_unreadable=1;${checked}`;
  }
  return `${decision.evidence};${checked}`;
}

function token(evidence: string, name: string): string | undefined {
  const match = evidence.match(new RegExp(`(?:^|;)${name}=([^;]*)`));
  return match?.[1];
}

function snapshotFromEvidence(evidence: string): OlxProfileSnapshot | undefined {
  const totalPages = Number(token(evidence, "olx_pages"));
  const totalElements = Number(token(evidence, "olx_total"));
  const visibleAds = Number(token(evidence, "olx_visible"));
  const realEstateAds = Number(token(evidence, "olx_real_estate_count"));
  if (
    ![totalPages, totalElements, visibleAds, realEstateAds].every((value) => Number.isFinite(value))
  ) {
    return undefined;
  }
  return withRatio({
    acquired: true,
    totalPages,
    totalElements,
    visibleAds,
    realEstateAds,
  });
}

export function olxProfileCacheState(
  evidence: string | undefined,
  now: Date,
): "absent" | "fresh_likely" | "fresh_unknown" | "stale" {
  if (!evidence || !evidence.includes("olx_checked_at=")) {
    return "absent";
  }
  const checkedAt = Date.parse(token(evidence, "olx_checked_at") ?? "");
  if (!Number.isFinite(checkedAt)) {
    return "absent";
  }
  const age = now.getTime() - checkedAt;
  if (age < 0) {
    return "stale";
  }
  if (token(evidence, "olx_unreadable") === "1") {
    return age < OLX_PROFILE_FAILURE_TTL_MS ? "fresh_unknown" : "stale";
  }
  const snapshot = snapshotFromEvidence(evidence);
  if (!snapshot) {
    return "stale";
  }
  const likely = classifyOlxProfileInventory(snapshot).verdict === "profile_likely_intermediary";
  const ttl = likely ? OLX_PROFILE_LIKELY_TTL_MS : OLX_PROFILE_UNKNOWN_TTL_MS;
  if (age >= ttl) {
    return "stale";
  }
  return likely ? "fresh_likely" : "fresh_unknown";
}
