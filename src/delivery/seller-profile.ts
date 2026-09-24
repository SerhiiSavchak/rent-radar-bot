import type { DatabaseSync } from "node:sqlite";
import type { Listing, SellerType } from "../domain/listing.ts";

/**
 * How many distinct public addresses under one seller id count as repeated
 * unrelated inventory. Three matches the client wording "many listings".
 * Two addresses stay sendable evidence, not a likely-intermediary verdict.
 */
export const SELLER_PROFILE_DISTINCT_ADDRESS_MIN = 3;

/** Stored address samples per seller. Older samples stay until the cap shifts them out. */
export const SELLER_PROFILE_ADDRESS_CAP = 8;

/**
 * Used only when a source actually provides an account creation timestamp.
 * DIM.RIA, LUN, RIELTOR, and OLX catalog cards do not expose that date, so
 * this rule stays dormant in production until one of them does.
 */
export const SELLER_PROFILE_NEW_ACCOUNT_MAX_AGE_DAYS = 7;

export const SELLER_PROFILE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type SellerProfileVerdict =
  | "confirmed_intermediary"
  | "profile_likely_intermediary"
  | "profile_high_risk"
  | "unknown"
  | "confirmed_owner";

/** Delivery policy for heuristic profile evidence. Classification stays independent. */
export type SellerProfileDeliveryPolicy = "send" | "reject";

export type SellerProfilePolicies = {
  /** Default reject. Three-address inventory is likely, not confirmed intermediary proof. */
  likelyPolicy: SellerProfileDeliveryPolicy;
  /** Default reject. Applies only when a source supplied accountCreatedAt. */
  newAccountPolicy: SellerProfileDeliveryPolicy;
};

export const DEFAULT_SELLER_PROFILE_POLICIES: SellerProfilePolicies = {
  likelyPolicy: "reject",
  newAccountPolicy: "reject",
};

export type SellerProfileDecision = {
  verdict: SellerProfileVerdict;
  evidence: string;
};

export type SellerProfileGateStats = {
  kept: Listing[];
  /** Listings rejected only by an explicit reject profile policy. */
  dropped: number;
  profileLikelyIntermediary: number;
  profileHighRisk: number;
  profileRejected: number;
};

type CacheRow = {
  address_keys: string;
};

function meta(listing: Listing): Record<string, unknown> {
  return listing.metadata ?? {};
}

export function sellerProfileId(listing: Listing): string | undefined {
  const record = meta(listing);
  if (listing.source === "olx") {
    const id = record.olxUserId;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
    if (typeof id === "number" && Number.isFinite(id)) {
      return String(id);
    }
  }
  if (listing.source === "domria") {
    const id = record.userId;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
    if (typeof id === "number" && Number.isFinite(id)) {
      return String(id);
    }
  }
  return undefined;
}

export function normalizeSellerAddress(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function isPlatformConfirmedOwner(listing: {
  sellerType: SellerType;
  metadata?: Record<string, unknown> | undefined;
}): boolean {
  return (
    listing.sellerType === "owner" && listing.metadata?.ownerEvidenceLevel === "platform_confirmed"
  );
}

/**
 * A missing profile page is not ownership. Callers that cannot read a profile
 * must leave the listing unknown rather than promoting it to confirmed_owner.
 */
export function verdictWhenProfileUnreadable(): SellerProfileDecision {
  return {
    verdict: "unknown",
    evidence: "profile_unreadable_not_owner",
  };
}

/**
 * Classification only. Does not decide delivery.
 * Three addresses → profile_likely_intermediary. A supplied young account → profile_high_risk.
 * Neither is confirmed intermediary proof.
 */
export function assessSellerProfile(input: {
  confirmedOwner: boolean;
  addresses: string[];
  accountCreatedAt?: Date | undefined;
  now: Date;
  distinctAddressMin?: number;
  newAccountMaxAgeDays?: number;
}): SellerProfileDecision {
  if (input.confirmedOwner) {
    return {
      verdict: "confirmed_owner",
      evidence: "platform_confirmed_owner",
    };
  }
  const distinct = new Set(input.addresses.filter(Boolean));
  const minimum = input.distinctAddressMin ?? SELLER_PROFILE_DISTINCT_ADDRESS_MIN;
  if (distinct.size >= minimum) {
    return {
      verdict: "profile_likely_intermediary",
      evidence: `distinct_addresses=${distinct.size}`,
    };
  }
  if (input.accountCreatedAt && !Number.isNaN(input.accountCreatedAt.getTime())) {
    const maxDays = input.newAccountMaxAgeDays ?? SELLER_PROFILE_NEW_ACCOUNT_MAX_AGE_DAYS;
    const ageMs = input.now.getTime() - input.accountCreatedAt.getTime();
    if (ageMs >= 0 && ageMs < maxDays * 24 * 60 * 60 * 1000) {
      return {
        verdict: "profile_high_risk",
        evidence: `account_age_days=${Math.floor(ageMs / (24 * 60 * 60 * 1000))}`,
      };
    }
  }
  return {
    verdict: "unknown",
    evidence: distinct.size > 0 ? `distinct_addresses=${distinct.size}` : "no_profile_signal",
  };
}

/**
 * Maps a profile verdict to delivery under the configured policies.
 * Strong platform intermediary rejection stays in the owner filter, not here.
 */
export function shouldRejectSellerProfile(
  verdict: SellerProfileVerdict,
  policies: SellerProfilePolicies = DEFAULT_SELLER_PROFILE_POLICIES,
): boolean {
  if (verdict === "confirmed_intermediary") {
    return true;
  }
  if (verdict === "profile_likely_intermediary") {
    return policies.likelyPolicy === "reject";
  }
  if (verdict === "profile_high_risk") {
    return policies.newAccountPolicy === "reject";
  }
  return false;
}

function readAddresses(db: DatabaseSync, source: string, sellerId: string): string[] {
  const row = db
    .prepare("SELECT address_keys FROM seller_profile_cache WHERE source = ? AND seller_id = ?")
    .get(source, sellerId) as CacheRow | undefined;
  if (!row) {
    return [];
  }
  try {
    const parsed = JSON.parse(row.address_keys) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function writeProfile(
  db: DatabaseSync,
  source: string,
  sellerId: string,
  decision: SellerProfileDecision,
  addresses: string[],
  now: Date,
): void {
  const kept = addresses.slice(-SELLER_PROFILE_ADDRESS_CAP);
  db.prepare(
    `INSERT INTO seller_profile_cache (source, seller_id, verdict, evidence, address_keys, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, seller_id) DO UPDATE SET
       verdict = excluded.verdict,
       evidence = excluded.evidence,
       address_keys = excluded.address_keys,
       updated_at = excluded.updated_at`,
  ).run(
    source,
    sellerId,
    decision.verdict,
    decision.evidence,
    JSON.stringify(kept),
    now.toISOString(),
  );
}

export function deleteExpiredSellerProfiles(db: DatabaseSync, now: Date): number {
  const cutoff = new Date(now.getTime() - SELLER_PROFILE_RETENTION_MS).toISOString();
  const result = db.prepare("DELETE FROM seller_profile_cache WHERE updated_at < ?").run(cutoff);
  return Number(result.changes ?? 0);
}

export function applySellerProfileGate(
  listings: Listing[],
  db: DatabaseSync | undefined,
  now: Date,
  policies: SellerProfilePolicies = DEFAULT_SELLER_PROFILE_POLICIES,
): SellerProfileGateStats {
  const groups = new Map<string, Listing[]>();
  const kept: Listing[] = [];
  let dropped = 0;
  let profileLikelyIntermediary = 0;
  let profileHighRisk = 0;
  let profileRejected = 0;
  for (const listing of listings) {
    const sellerId = sellerProfileId(listing);
    if (!sellerId) {
      if (
        listing.metadata?.sellerTextLevel === "likely" &&
        policies.likelyPolicy === "reject" &&
        !isPlatformConfirmedOwner(listing)
      ) {
        dropped += 1;
        profileLikelyIntermediary += 1;
        profileRejected += 1;
        continue;
      }
      kept.push(listing);
      continue;
    }
    const key = `${listing.source}\n${sellerId}`;
    const group = groups.get(key);
    if (group) {
      group.push(listing);
    } else {
      groups.set(key, [listing]);
    }
  }
  const persist = (
    source: string,
    sellerId: string,
    decision: SellerProfileDecision,
    addresses: string[],
  ) => {
    if (!db) {
      return;
    }
    try {
      writeProfile(db, source, sellerId, decision, addresses, now);
    } catch {
      // A database without the cache table still classifies the current batch in memory.
    }
  };
  for (const [key, group] of groups) {
    const newline = key.indexOf("\n");
    const source = key.slice(0, newline);
    const sellerId = key.slice(newline + 1);
    const fresh = group
      .map((listing) => normalizeSellerAddress(listing.location.raw))
      .filter((item): item is string => Boolean(item));
    let prior: string[] = [];
    if (db) {
      try {
        prior = readAddresses(db, source, sellerId);
      } catch {
        prior = [];
      }
    }
    const addresses = [...prior];
    for (const address of fresh) {
      if (!addresses.includes(address)) {
        addresses.push(address);
      }
    }
    const createdRaw = group
      .map((listing) => listing.metadata?.accountCreatedAt)
      .find((value) => typeof value === "string");
    const accountCreatedAt = typeof createdRaw === "string" ? new Date(createdRaw) : undefined;
    const confirmedOwner = group.every((listing) => isPlatformConfirmedOwner(listing));
    let decision = assessSellerProfile({
      confirmedOwner,
      addresses,
      ...(accountCreatedAt ? { accountCreatedAt } : {}),
      now,
    });
    if (
      !confirmedOwner &&
      decision.verdict === "unknown" &&
      group.some((listing) => listing.metadata?.sellerTextLevel === "likely")
    ) {
      decision = {
        verdict: "profile_likely_intermediary",
        evidence: "seller_text_families",
      };
    }
    persist(source, sellerId, decision, addresses);
    if (decision.verdict === "profile_likely_intermediary") {
      profileLikelyIntermediary += group.length;
    } else if (decision.verdict === "profile_high_risk") {
      profileHighRisk += group.length;
    }
    const reject = shouldRejectSellerProfile(decision.verdict, policies);
    if (!reject) {
      kept.push(...group);
      continue;
    }
    for (const listing of group) {
      if (isPlatformConfirmedOwner(listing)) {
        kept.push(listing);
      } else {
        dropped += 1;
        profileRejected += 1;
      }
    }
  }
  return {
    kept,
    dropped,
    profileLikelyIntermediary,
    profileHighRisk,
    profileRejected,
  };
}
