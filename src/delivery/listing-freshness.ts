import type { Listing } from "../domain/listing.ts";

export type ListingDeliveryKind =
  | "baseline_silent"
  | "initial_preview"
  | "new_publication"
  | "first_noticed"
  | "old_publication"
  | "refreshed_old"
  | "late_discovered";

export type FreshnessClassification = {
  kind: ListingDeliveryKind;
  /** Whether Telegram should send this listing under current policy. */
  deliverable: boolean;
  /** publishedAt exists and is within maxPublicationAgeMinutes. Not sufficient for delivery. */
  withinAgeWindow: boolean;
  reason: string;
};

export type FreshnessPolicy = {
  /** Max age of publishedAt to treat as a new publication (necessary, not sufficient). */
  maxPublicationAgeMinutes: number;
  /** When true, listings without publishedAt are not delivered. */
  strictNewPublications: boolean;
  now: Date;
  /**
   * When the per-source silent baseline was established.
   * Publications older than this are late-discovered inventory, not new publications.
   */
  monitoringStartedAt?: Date | undefined;
};

const DEFAULT_MAX_PUBLICATION_AGE_MINUTES = 7 * 24 * 60; // 7 days

export function defaultMaxPublicationAgeMinutes(
  configMaxListingAgeMinutes: number | undefined,
): number {
  return configMaxListingAgeMinutes ?? DEFAULT_MAX_PUBLICATION_AGE_MINUTES;
}

/**
 * Classify a listing for Telegram delivery after baseline is established.
 * Dedupe alone is NOT freshness — this uses publishedAt / refreshedAt provenance.
 * Being inside the age window is not enough to be a new publication.
 */
export function classifyListingFreshness(
  listing: Pick<Listing, "publishedAt" | "refreshedAt" | "source" | "sourceId">,
  policy: FreshnessPolicy,
): FreshnessClassification {
  const published = listing.publishedAt;
  const refreshed = listing.refreshedAt;
  const maxMs = policy.maxPublicationAgeMinutes * 60_000;
  const nowMs = policy.now.getTime();

  if (!published) {
    return {
      kind: "first_noticed",
      deliverable: !policy.strictNewPublications,
      withinAgeWindow: false,
      reason: policy.strictNewPublications
        ? "publishedAt unknown — excluded by strict new-publications mode"
        : "publishedAt unknown — deliverable as first noticed only",
    };
  }

  const ageMs = nowMs - published.getTime();
  const withinAgeWindow = ageMs <= maxMs;
  const monitoringStartedAt = policy.monitoringStartedAt;

  if (ageMs > maxMs) {
    if (refreshed && nowMs - refreshed.getTime() <= maxMs) {
      return {
        kind: "refreshed_old",
        deliverable: false,
        withinAgeWindow: false,
        reason: `old publishedAt (${published.toISOString()}) with recent refresh — not a new publication`,
      };
    }
    return {
      kind: "old_publication",
      deliverable: false,
      withinAgeWindow: false,
      reason: `publishedAt older than ${policy.maxPublicationAgeMinutes} minutes — not a new publication`,
    };
  }

  if (monitoringStartedAt && published.getTime() < monitoringStartedAt.getTime()) {
    return {
      kind: "late_discovered",
      deliverable: false,
      withinAgeWindow,
      reason: `publishedAt (${published.toISOString()}) is before monitoring started (${monitoringStartedAt.toISOString()}) — not a new publication`,
    };
  }

  return {
    kind: "new_publication",
    deliverable: true,
    withinAgeWindow: true,
    reason: monitoringStartedAt
      ? "publishedAt after monitoring started and within freshness window"
      : "publishedAt within freshness window (age window only — not delivery eligibility)",
  };
}

/** Attach firstSeenAt on first observation without inventing publishedAt. */
export function withFirstSeenAt(listing: Listing, firstSeenAt: Date): Listing {
  if (listing.firstSeenAt) {
    return listing;
  }
  return { ...listing, firstSeenAt };
}
