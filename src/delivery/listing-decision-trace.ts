import type { DatabaseSync } from "node:sqlite";
import type { ListingSource } from "../domain/listing.ts";

/**
 * Bounded per-listing pipeline decisions for missing-listing forensics.
 * Trace inserts themselves have no side effects. Terminal linked-seller
 * rejection is persisted via markSeen in the pipeline; temporary holds are not.
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

/** Stages that answer “what happened to this listing?” after collection. */
const TERMINAL_STAGES = new Set<ListingDecisionStage>([
  "rejected_seller",
  "rejected_geo",
  "rejected_other",
  "held",
  "deduped",
  "suppressed_freshness",
  "queued",
  "delivered",
  "delivery_failed",
]);

export type ListingDecisionRecord = {
  cycleId: number;
  source: ListingSource | string;
  sourceId: string;
  stage: ListingDecisionStage;
  reasonCode: string;
  identityKey?: string;
  at?: Date;
};

export type ListingDecisionTraceFlushReport = {
  written: number;
  dropped: number;
  truncated: boolean;
  totalAttempted: number;
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
  for (const row of records) {
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

/**
 * Prefer terminal decisions, then one collected row per listing, fairly across
 * sources. Absence from a truncated trace is never proof of non-collection.
 */
export function selectListingDecisionTraceRows(
  rows: readonly ListingDecisionRecord[],
  cap: number = LISTING_DECISION_TRACE_CYCLE_CAP,
): { kept: ListingDecisionRecord[]; dropped: number } {
  if (rows.length <= cap) {
    return { kept: [...rows], dropped: 0 };
  }
  const bySource = new Map<string, ListingDecisionRecord[]>();
  for (const row of rows) {
    const list = bySource.get(row.source) ?? [];
    list.push(row);
    bySource.set(row.source, list);
  }
  const sources = [...bySource.keys()].sort();
  const kept: ListingDecisionRecord[] = [];
  const keptKeys = new Set<string>();
  const keyOf = (row: ListingDecisionRecord) =>
    `${row.source}|${row.sourceId}|${row.stage}|${row.reasonCode}|${row.identityKey ?? ""}`;

  const takeRoundRobin = (predicate: (row: ListingDecisionRecord) => boolean) => {
    let progress = true;
    while (kept.length < cap && progress) {
      progress = false;
      for (const source of sources) {
        if (kept.length >= cap) {
          break;
        }
        const list = bySource.get(source);
        if (!list || list.length === 0) {
          continue;
        }
        const idx = list.findIndex(predicate);
        if (idx < 0) {
          continue;
        }
        const [row] = list.splice(idx, 1);
        if (!row) {
          continue;
        }
        const key = keyOf(row);
        if (keptKeys.has(key)) {
          continue;
        }
        keptKeys.add(key);
        kept.push(row);
        progress = true;
      }
    }
  };

  takeRoundRobin((row) => TERMINAL_STAGES.has(row.stage));
  // One collected marker per listing (skip duplicate normalized when tight).
  const collectedSeen = new Set<string>();
  takeRoundRobin((row) => {
    if (row.stage !== "collected") {
      return false;
    }
    const id = `${row.source}|${row.sourceId}`;
    if (collectedSeen.has(id)) {
      return false;
    }
    collectedSeen.add(id);
    return true;
  });
  takeRoundRobin(() => true);

  return { kept, dropped: rows.length - kept.length };
}

/** In-memory buffer used for one poll cycle, then flushed. */
export class ListingDecisionTraceBuffer {
  private readonly rows: ListingDecisionRecord[] = [];
  private attempted = 0;
  private lastFlush: ListingDecisionTraceFlushReport = {
    written: 0,
    dropped: 0,
    truncated: false,
    totalAttempted: 0,
  };

  constructor(
    private readonly cycleId: number,
    private readonly cap: number = LISTING_DECISION_TRACE_CYCLE_CAP,
  ) {}

  record(
    source: string,
    sourceId: string,
    stage: ListingDecisionStage,
    reasonCode: string,
    identityKey?: string,
  ): void {
    this.attempted += 1;
    this.rows.push({
      cycleId: this.cycleId,
      source,
      sourceId,
      stage,
      reasonCode,
      ...(identityKey ? { identityKey } : {}),
    });
  }

  flush(db: DatabaseSync | undefined): ListingDecisionTraceFlushReport {
    const selected = selectListingDecisionTraceRows(this.rows, this.cap);
    const written = db ? insertListingDecisionTrace(db, selected.kept) : selected.kept.length;
    this.lastFlush = {
      written,
      dropped: selected.dropped,
      truncated: selected.dropped > 0,
      totalAttempted: this.attempted,
    };
    this.rows.length = 0;
    return this.lastFlush;
  }

  report(): ListingDecisionTraceFlushReport {
    return this.lastFlush;
  }

  snapshot(): readonly ListingDecisionRecord[] {
    return this.rows;
  }
}
