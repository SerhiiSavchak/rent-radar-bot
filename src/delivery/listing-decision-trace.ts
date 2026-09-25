import type { DatabaseSync } from "node:sqlite";
import type { ListingSource } from "../domain/listing.ts";

/**
 * Bounded per-listing pipeline decisions for missing-listing forensics.
 * Rejected/held rows are recorded without markSeen / outbox side effects.
 */
export const LISTING_DECISION_TRACE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const LISTING_DECISION_TRACE_CYCLE_CAP = 400;

export type ListingDecisionStage =
  | "collected"
  | "normalized"
  | "rejected_seller"
  | "rejected_geo"
  | "rejected_other"
  | "held"
  | "deduped"
  | "suppressed_freshness"
  | "queued"
  | "delivered"
  | "delivery_failed";

export type ListingDecisionRecord = {
  cycleId: number;
  source: ListingSource | string;
  sourceId: string;
  stage: ListingDecisionStage;
  reasonCode: string;
  identityKey?: string;
  at?: Date;
};

export function insertListingDecisionTrace(
  db: DatabaseSync,
  records: readonly ListingDecisionRecord[],
): number {
  if (records.length === 0) {
    return 0;
  }
  const stmt = db.prepare(
    `INSERT INTO listing_decision_trace (
       cycle_id, source, source_id, stage, reason_code, identity_key, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let written = 0;
  for (const row of records.slice(0, LISTING_DECISION_TRACE_CYCLE_CAP)) {
    const id = row.sourceId?.trim();
    if (!id) {
      continue;
    }
    stmt.run(
      row.cycleId,
      row.source,
      id,
      row.stage,
      row.reasonCode.slice(0, 120),
      row.identityKey?.slice(0, 200) ?? null,
      (row.at ?? new Date()).toISOString(),
    );
    written += 1;
  }
  return written;
}

export function deleteExpiredListingDecisionTraces(db: DatabaseSync, now = new Date()): number {
  const cutoff = new Date(now.getTime() - LISTING_DECISION_TRACE_RETENTION_MS).toISOString();
  const result = db.prepare("DELETE FROM listing_decision_trace WHERE created_at < ?").run(cutoff);
  return Number(result.changes);
}

export function listingDecisionTraceHas(
  db: DatabaseSync,
  input: { source: string; sourceId: string; stage?: ListingDecisionStage; cycleId?: number },
): boolean {
  if (input.stage !== undefined && input.cycleId !== undefined) {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM listing_decision_trace
         WHERE source = ? AND source_id = ? AND stage = ? AND cycle_id = ? LIMIT 1`,
      )
      .get(input.source, input.sourceId, input.stage, input.cycleId) as { ok: number } | undefined;
    return Boolean(row);
  }
  if (input.stage !== undefined) {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM listing_decision_trace
         WHERE source = ? AND source_id = ? AND stage = ? LIMIT 1`,
      )
      .get(input.source, input.sourceId, input.stage) as { ok: number } | undefined;
    return Boolean(row);
  }
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM listing_decision_trace WHERE source = ? AND source_id = ? LIMIT 1`,
    )
    .get(input.source, input.sourceId) as { ok: number } | undefined;
  return Boolean(row);
}

/** In-memory buffer used for one poll cycle, then flushed. */
export class ListingDecisionTraceBuffer {
  private readonly rows: ListingDecisionRecord[] = [];

  constructor(private readonly cycleId: number) {}

  record(
    source: string,
    sourceId: string,
    stage: ListingDecisionStage,
    reasonCode: string,
    identityKey?: string,
  ): void {
    if (this.rows.length >= LISTING_DECISION_TRACE_CYCLE_CAP) {
      return;
    }
    this.rows.push({
      cycleId: this.cycleId,
      source,
      sourceId,
      stage,
      reasonCode,
      ...(identityKey ? { identityKey } : {}),
    });
  }

  flush(db: DatabaseSync | undefined): number {
    if (!db || this.rows.length === 0) {
      return 0;
    }
    return insertListingDecisionTrace(db, this.rows);
  }

  snapshot(): readonly ListingDecisionRecord[] {
    return this.rows;
  }
}
