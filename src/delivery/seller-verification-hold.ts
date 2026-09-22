import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import type { LinkedSellerDecision } from "./rieltor-detail-seller.ts";
import { deserializeListing, serializeListing } from "../storage/durable-delivery-store.ts";

/** Two 10-minute polls. An unresolved seller is sent after this, not on the first 403. */
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

export function shouldHoldSellerVerification(decision: LinkedSellerDecision): boolean {
  return (
    decision.outcome === "detail_transport_failure" ||
    decision.outcome === "detail_rate_limited" ||
    decision.outcome === "detail_parser_failure" ||
    decision.outcome === "skipped_after_rate_limit"
  );
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
): void {
  const started = now.toISOString();
  const releaseAt = new Date(now.getTime() + SELLER_HOLD_MAX_MS).toISOString();
  db.prepare(
    `INSERT INTO seller_verification_holds (
       source, source_id, listing_json, external_source, external_listing_id,
       hold_started_at, next_check_at, attempt_count, release_at
     ) VALUES (?, ?, ?, 'rieltor', ?, ?, ?, 1, ?)
     ON CONFLICT(source, source_id) DO NOTHING`,
  ).run(
    listing.source,
    listing.sourceId,
    serializeListing(listing),
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
): Promise<Array<{ listing: Listing; action: SellerHoldAction }>> {
  const actions: Array<{ listing: Listing; action: SellerHoldAction }> = [];
  for (const hold of listDueSellerHolds(db, now)) {
    const decision = await verify(hold.listing);
    if (decision.drop) {
      deleteSellerHold(db, hold.source, hold.sourceId);
      actions.push({ listing: hold.listing, action: "drop" });
      continue;
    }
    if (shouldHoldSellerVerification(decision)) {
      if (now.getTime() >= Date.parse(hold.releaseAt)) {
        deleteSellerHold(db, hold.source, hold.sourceId);
        actions.push({ listing: hold.listing, action: "send" });
      } else {
        keepSellerHold(db, hold.source, hold.sourceId, now);
        actions.push({ listing: hold.listing, action: "keep" });
      }
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
