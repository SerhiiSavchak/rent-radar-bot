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
   * Effective lower bound supplied by the caller.
   * For a baselined source this is the later of the previous complete poll
   * and a seller-policy cutover. Publications older than it are late inventory
   * unless publishedAt is still inside lateDiscoveryGraceMinutes.
   */
  monitoringStartedAt?: Date | undefined;
  /**
   * Listings first seen after the monitoring boundary stay deliverable when
   * publishedAt is at most this many minutes old. Independent of
   * maxPublicationAgeMinutes. Omitted means LATE_DISCOVERY_GRACE_MINUTES.
   */
  lateDiscoveryGraceMinutes?: number | undefined;
};

const DEFAULT_MAX_PUBLICATION_AGE_MINUTES = 7 * 24 * 60; // 7 days

/**
 * Delayed catalog visibility. A listing can be published before the previous
 * successful poll and still be new. 60 minutes covers the observed 15–46
 * minute OLX delays and does not reopen multi-hour inventory.
 */
export const LATE_DISCOVERY_GRACE_MINUTES = 60;

/** Written into a seller hold only after the listing passed this freshness rule. */
export const FRESHNESS_GATE_VERSION = 2;

export function markFreshnessApproved(
  listing: Listing,
  monitoringStartedAt: Date | undefined,
): Listing {
  return {
    ...listing,
    metadata: {
      ...listing.metadata,
      freshnessGateVersion: FRESHNESS_GATE_VERSION,
      ...(monitoringStartedAt
        ? { freshnessMonitoringBoundary: monitoringStartedAt.toISOString() }
        : {}),
    },
  };
}

export function hasFreshnessGateApproval(listing: Pick<Listing, "metadata">): boolean {
  return listing.metadata?.freshnessGateVersion === FRESHNESS_GATE_VERSION;
}

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
  const graceMinutes = policy.lateDiscoveryGraceMinutes ?? LATE_DISCOVERY_GRACE_MINUTES;

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
    if (ageMs <= graceMinutes * 60_000) {
      return {
        kind: "new_publication",
        deliverable: true,
        withinAgeWindow: true,
        reason: `publishedAt (${published.toISOString()}) is before monitoring started (${monitoringStartedAt.toISOString()}) but within ${graceMinutes}-minute late-discovery grace`,
      };
    }
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
