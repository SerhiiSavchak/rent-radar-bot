export type OlxProfileDecision = {
  verdict: "profile_likely_intermediary" | "unknown";
  evidence: string;
};

/**
 * Public OLX profile inventory, read from the listing's own `/uk/list/user/{slug}/` link.
 *
 * Live counts on 2026-09-23, one stock Chromium, sequential:
 * - Надія (`1811096174`): totalElements 6, totalPages 1, mixed real-estate and accommodation.
 * - Наталя Ткачук (`28160545`): totalElements 13, totalPages 2, real-estate categories on the page.
 * - Another Наталія (`24346513`): totalElements 20, totalPages 2.
 * - Ксенія and Юліан: 2 and 1 ads, one page.
 *
 * A second public page is the split. Six ads on one page stay unknown and are sent.
 * Three addresses are not this decision.
 */
export const OLX_PROFILE_MULTI_PAGE_MIN = 2;

/** Successful reads are reused so the next cycles do not open the same profile. */
export const OLX_PROFILE_SUCCESS_TTL_MS = 12 * 60 * 60 * 1000;

/** A failed read is unknown/send and is retried later, not on every cycle. */
export const OLX_PROFILE_FAILURE_TTL_MS = 60 * 60 * 1000;

/** New profile navigations per cycle, after the listing is otherwise deliverable. */
export const OLX_PROFILE_PROBE_BUDGET = 4;

export type OlxProfileSnapshot = {
  acquired: boolean;
  totalPages?: number;
  totalElements?: number;
  realEstateOnPage?: boolean;
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

/**
 * Reads `userListing.userListing` from the public profile prerendered state.
 * Missing counters stay unacquired. This does not invent an offers API.
 */
export function parseOlxProfileInventory(state: unknown): OlxProfileSnapshot {
  const nested = asRecord(asRecord(asRecord(state)?.userListing)?.userListing);
  const totalPages = nested?.totalPages;
  const totalElements = nested?.totalElements;
  if (typeof totalPages !== "number" || typeof totalElements !== "number") {
    return { acquired: false };
  }
  const ads = Array.isArray(nested?.ads) ? nested.ads : [];
  return {
    acquired: true,
    totalPages,
    totalElements,
    realEstateOnPage: ads.some((ad) => isRealEstateAd(ad)),
  };
}

export function classifyOlxProfileInventory(snapshot: OlxProfileSnapshot): OlxProfileDecision {
  if (!snapshot.acquired || snapshot.totalPages === undefined || snapshot.totalElements === undefined) {
    return { verdict: "unknown", evidence: "olx_profile_unreadable" };
  }
  const evidence = [
    `olx_pages=${snapshot.totalPages}`,
    `olx_total=${snapshot.totalElements}`,
    `olx_real_estate=${snapshot.realEstateOnPage ? 1 : 0}`,
  ].join(";");
  if (snapshot.totalPages >= OLX_PROFILE_MULTI_PAGE_MIN && snapshot.realEstateOnPage === true) {
    return { verdict: "profile_likely_intermediary", evidence };
  }
  return { verdict: "unknown", evidence };
}

export function olxProfileEvidence(snapshot: OlxProfileSnapshot, checkedAt: Date): string {
  const decision = classifyOlxProfileInventory(snapshot);
  if (decision.evidence === "olx_profile_unreadable") {
    return `olx_unreadable=1;olx_checked_at=${checkedAt.toISOString()}`;
  }
  return `${decision.evidence};olx_checked_at=${checkedAt.toISOString()}`;
}

function token(evidence: string, name: string): string | undefined {
  const match = evidence.match(new RegExp(`(?:^|;)${name}=([^;]*)`));
  return match?.[1];
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
  const unreadable = token(evidence, "olx_unreadable") === "1";
  const ttl = unreadable ? OLX_PROFILE_FAILURE_TTL_MS : OLX_PROFILE_SUCCESS_TTL_MS;
  if (age < 0 || age >= ttl) {
    return "stale";
  }
  const pages = Number(token(evidence, "olx_pages") ?? "");
  const realEstate = token(evidence, "olx_real_estate") === "1";
  if (!unreadable && pages >= OLX_PROFILE_MULTI_PAGE_MIN && realEstate) {
    return "fresh_likely";
  }
  return "fresh_unknown";
}
