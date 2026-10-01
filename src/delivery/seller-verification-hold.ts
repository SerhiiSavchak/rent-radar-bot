import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import type { SellerPolicy } from "../filters/owner-filter.ts";
import type { LinkedSellerDecision } from "./rieltor-detail-seller.ts";
import { deserializeListing, serializeListing } from "../storage/durable-delivery-store.ts";

/**
 * Absolute retry deadline measured from hold_started_at.
 * A temporary failure is rechecked until this instant, then released.
 * Retries must not move release_at. Evaluated unknown is not a hold
 * under reject_intermediaries.
 */
export const SELLER_HOLD_MAX_MS = 20 * 60 * 1000;

export type SellerHoldRow = {
  source: string;
  sourceId: string;
  listing: Listing;
  externalSource: string;
  externalListingId: string;
  holdStartedAt: string;
  nextCheckAt: string;
  attemptCount: number;
  releaseAt: string;
};

export type SellerVerificationDisposition = "allow" | "defer" | "reject";

const TEMPORARY_SELLER_VERIFICATION_OUTCOMES = new Set<LinkedSellerDecision["outcome"]>([
  "detail_transport_failure",
  "detail_rate_limited",
  "detail_parser_failure",
  "skipped_after_rate_limit",
]);

const EVALUATED_UNKNOWN_OUTCOMES = new Set<LinkedSellerDecision["outcome"]>([
  "detail_unknown",
  "cache_unknown",
]);

/**
 * One policy decision for a finished linked-seller check.
 * Terminal drops reject. Transport, rate-limit, and parser failures defer.
 * Evaluated unknown is deliverable under reject_intermediaries and stays
 * deferred under owner_only. Unknown is not promoted to confirmed owner.
 */
export function sellerVerificationDisposition(
  decision: LinkedSellerDecision,
  policy: SellerPolicy = "reject_intermediaries",
): SellerVerificationDisposition {
  if (decision.drop) {
    return "reject";
  }
  if (TEMPORARY_SELLER_VERIFICATION_OUTCOMES.has(decision.outcome)) {
    return "defer";
  }
  if (EVALUATED_UNKNOWN_OUTCOMES.has(decision.outcome)) {
    return policy === "owner_only" ? "defer" : "allow";
  }
  return "allow";
}

/** True only for a temporary defer. Evaluated unknown is not a hold under reject_intermediaries. */
export function shouldHoldSellerVerification(
  decision: LinkedSellerDecision,
  policy: SellerPolicy = "reject_intermediaries",
): boolean {
  return sellerVerificationDisposition(decision, policy) === "defer";
}

export function hasSellerHold(db: DatabaseSync, source: string, sourceId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT source FROM seller_verification_holds WHERE source = ? AND source_id = ?")
      .get(source, sourceId),
  );
}

export function upsertSellerHold(
  db: DatabaseSync,
  listing: Listing,
  externalListingId: string,
  now: Date,
  externalSource: "rieltor" | "olx" = "rieltor",
): void {
  const started = now.toISOString();
  const releaseAt = new Date(now.getTime() + SELLER_HOLD_MAX_MS).toISOString();
  db.prepare(
    `INSERT INTO seller_verification_holds (
       source, source_id, listing_json, external_source, external_listing_id,
       hold_started_at, next_check_at, attempt_count, release_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(source, source_id) DO NOTHING`,
  ).run(
    listing.source,
    listing.sourceId,
    serializeListing(listing),
    externalSource,
    externalListingId,
    started,
    started,
    releaseAt,
  );
}

export function listDueSellerHolds(db: DatabaseSync, now: Date): SellerHoldRow[] {
  const rows = db
    .prepare(
      `SELECT source, source_id AS sourceId, listing_json AS listingJson,
              external_source AS externalSource, external_listing_id AS externalListingId,
              hold_started_at AS holdStartedAt, next_check_at AS nextCheckAt,
              attempt_count AS attemptCount, release_at AS releaseAt
       FROM seller_verification_holds
       WHERE next_check_at <= ?
       ORDER BY hold_started_at, source, source_id`,
    )
    .all(now.toISOString()) as Array<{
    source: string;
    sourceId: string;
    listingJson: string;
    externalSource: string;
    externalListingId: string;
    holdStartedAt: string;
    nextCheckAt: string;
    attemptCount: number;
    releaseAt: string;
  }>;
  return rows.map((row) => ({
    source: row.source,
    sourceId: row.sourceId,
    listing: deserializeListing(row.listingJson),
    externalSource: row.externalSource,
    externalListingId: row.externalListingId,
    holdStartedAt: row.holdStartedAt,
    nextCheckAt: row.nextCheckAt,
    attemptCount: Number(row.attemptCount),
    releaseAt: row.releaseAt,
  }));
}

export function deleteSellerHold(db: DatabaseSync, source: string, sourceId: string): void {
  db.prepare("DELETE FROM seller_verification_holds WHERE source = ? AND source_id = ?").run(
    source,
    sourceId,
  );
}

export function keepSellerHold(db: DatabaseSync, source: string, sourceId: string, now: Date): void {
  const nextCheck = new Date(now.getTime() + 1000).toISOString();
  db.prepare(
    `UPDATE seller_verification_holds
     SET attempt_count = attempt_count + 1, next_check_at = ?
     WHERE source = ? AND source_id = ?`,
  ).run(nextCheck, source, sourceId);
}

export function countSellerHolds(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM seller_verification_holds").get() as {
    n: number;
  };
  return Number(row.n);
}

export type SellerHoldAction = "drop" | "keep" | "send";

export async function resolveDueSellerHolds(
  db: DatabaseSync,
  now: Date,
  verify: (listing: Listing) => Promise<LinkedSellerDecision>,
  policy: SellerPolicy = "reject_intermediaries",
): Promise<Array<{ listing: Listing; action: SellerHoldAction }>> {
  const actions: Array<{ listing: Listing; action: SellerHoldAction }> = [];
  for (const hold of listDueSellerHolds(db, now)) {
    const decision = await verify(hold.listing);
    const disposition = sellerVerificationDisposition(decision, policy);
    if (disposition === "reject") {
      deleteSellerHold(db, hold.source, hold.sourceId);
      actions.push({ listing: hold.listing, action: "drop" });
      continue;
    }
    if (disposition === "defer") {
      const releaseAtMs = Date.parse(hold.releaseAt);
      if (Number.isFinite(releaseAtMs) && now.getTime() >= releaseAtMs) {
        deleteSellerHold(db, hold.source, hold.sourceId);
        actions.push({
          listing: hold.listing,
          action: policy === "owner_only" ? "drop" : "send",
        });
        continue;
      }
      keepSellerHold(db, hold.source, hold.sourceId, now);
      actions.push({ listing: hold.listing, action: "keep" });
      continue;
    }
    deleteSellerHold(db, hold.source, hold.sourceId);
    actions.push({ listing: hold.listing, action: "send" });
  }
  return actions;
}

/** Drop holds whose release is more than a day behind, so the table cannot accumulate. */
export function deleteAbandonedSellerHolds(db: DatabaseSync, now: Date): number {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare("DELETE FROM seller_verification_holds WHERE release_at < ?").run(cutoff);
  return Number(result.changes);
}
