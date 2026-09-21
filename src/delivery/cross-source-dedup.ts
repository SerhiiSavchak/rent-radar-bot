import type { Listing } from "../domain/listing.ts";
import {
  identityKeys,
  type IdentityKeyClass,
  type ProvenanceListing,
} from "../domain/provenance.ts";

export type DedupVerdict = "unique" | "confirmed_duplicate" | "possible_duplicate";

export type CrossSourceDecision = {
  verdict: DedupVerdict;
  suppress: boolean;
  reasons: string[];
  match?: {
    source: string;
    sourceId: string;
    identityKey: string;
  };
};

export type IdentityHit = {
  key: string;
  ourClass: IdentityKeyClass;
  theirClass: IdentityKeyClass;
  source: string;
  sourceId: string;
};

export type CrossSourceIndex = {
  assessCrossSource(listing: Listing, peers?: Listing[]): CrossSourceDecision;
  rememberCrossSource(listing: Listing): void;
};

const CONFIRM_RANK = [
  "explicit_external_listing_id",
  "explicit_external_url",
  "same_platform_listing_id",
  "same_canonical_url",
  "lun_group_id",
];

/**
 * Level 3 confirms only a shared LUN groupId between LUN listings.
 * similarPageIds and hasDuplicates stay on the provenance record and do not suppress:
 * "similar" is not an explicit same-listing id.
 * Level 4/5 (attributes, text, images, AI) never suppress.
 */
export function confirmReason(
  key: string,
  ourClass: IdentityKeyClass,
  theirClass: IdentityKeyClass,
): string | undefined {
  if (key.startsWith("lun:group:") && ourClass === "lun_cluster" && theirClass === "lun_cluster") {
    return "lun_group_id";
  }
  if (key.startsWith("lun:")) {
    return undefined;
  }
  const explicit = ourClass === "explicit_external" || theirClass === "explicit_external";
  if (
    explicit &&
    (key.startsWith("olx:token:") || key.startsWith("rieltor:id:") || key.startsWith("domria:id:"))
  ) {
    return "explicit_external_listing_id";
  }
  if (explicit && key.startsWith("url:")) {
    return "explicit_external_url";
  }
  if (ourClass === "own" && theirClass === "own") {
    if (
      key.startsWith("olx:token:") ||
      key.startsWith("rieltor:id:") ||
      key.startsWith("domria:id:")
    ) {
      return "same_platform_listing_id";
    }
    if (key.startsWith("url:")) {
      return "same_canonical_url";
    }
  }
  return undefined;
}

function sameListing(
  a: { source: string; sourceId: string },
  b: { source: string; sourceId: string },
): boolean {
  return a.source === b.source && a.sourceId === b.sourceId;
}

function currenciesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Rooms + area + price is recorded as uncertain. Coordinates do not upgrade it.
 * Text similarity is not calculated.
 */
export function attributeOverlap(candidate: ProvenanceListing, peer: ProvenanceListing): boolean {
  if (sameListing(candidate, peer)) {
    return false;
  }
  if (
    candidate.rooms === undefined ||
    peer.rooms === undefined ||
    candidate.rooms <= 0 ||
    candidate.rooms !== peer.rooms
  ) {
    return false;
  }
  if (
    candidate.areaM2 === undefined ||
    peer.areaM2 === undefined ||
    candidate.areaM2 <= 0 ||
    candidate.areaM2 !== peer.areaM2
  ) {
    return false;
  }
  if (!candidate.price || !peer.price) {
    return false;
  }
  return (
    candidate.price.amount === peer.price.amount &&
    currenciesMatch(candidate.price.currency, peer.price.currency)
  );
}

export function decideFromHits(
  listing: ProvenanceListing,
  hits: IdentityHit[],
  peers: ProvenanceListing[] = [],
): CrossSourceDecision {
  const reasons: string[] = [];
  let match: CrossSourceDecision["match"];
  let bestRank = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    if (hit.source === listing.source && hit.sourceId === listing.sourceId) {
      continue;
    }
    const reason = confirmReason(hit.key, hit.ourClass, hit.theirClass);
    if (!reason) {
      continue;
    }
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
    const rank = CONFIRM_RANK.indexOf(reason);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
      match = { source: hit.source, sourceId: hit.sourceId, identityKey: hit.key };
    }
  }
  if (reasons.length > 0) {
    reasons.sort((a, b) => CONFIRM_RANK.indexOf(a) - CONFIRM_RANK.indexOf(b));
    return {
      verdict: "confirmed_duplicate",
      suppress: true,
      reasons,
      ...(match ? { match } : {}),
    };
  }
  const overlapped = peers.some((peer) => attributeOverlap(listing, peer));
  if (overlapped) {
    return {
      verdict: "possible_duplicate",
      suppress: false,
      reasons: ["attribute_overlap_not_sufficient"],
    };
  }
  return {
    verdict: "unique",
    suppress: false,
    reasons: ["no_confirmed_relation"],
  };
}

export function assessAgainstKnown(candidate: Listing, known: Listing[]): CrossSourceDecision {
  const ours = identityKeys(candidate);
  const hits: IdentityHit[] = [];
  for (const other of known) {
    if (sameListing(candidate, other)) {
      continue;
    }
    const theirs = identityKeys(other);
    for (const our of ours) {
      const match = theirs.find((item) => item.key === our.key);
      if (!match) {
        continue;
      }
      hits.push({
        key: our.key,
        ourClass: our.keyClass,
        theirClass: match.keyClass,
        source: other.source,
        sourceId: other.sourceId,
      });
    }
  }
  return decideFromHits(
    candidate,
    hits,
    known.filter((other) => !sameListing(candidate, other)),
  );
}

export function isCrossSourceIndex(value: object): value is CrossSourceIndex {
  const record = value as Partial<CrossSourceIndex>;
  return (
    typeof record.assessCrossSource === "function" &&
    typeof record.rememberCrossSource === "function"
  );
}

export function crossSourceOf(dedupe: object): CrossSourceIndex | undefined {
  return isCrossSourceIndex(dedupe) ? dedupe : undefined;
}
