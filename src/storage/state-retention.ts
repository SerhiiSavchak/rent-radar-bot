import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Operational retention. There is no source-health history table and no poll
 * diagnostic history table, so those windows are not applied to current rows.
 */
export const STATE_RETENTION = {
  seenInactiveMs: 30 * DAY_MS,
  crossSourceIdentityMs: 90 * DAY_MS,
  sentOutboxMs: 30 * DAY_MS,
  cleanupIntervalMs: DAY_MS,
} as const;

export const STATE_CLEANUP_META_KEY = "state_cleanup_at";

export type StateCleanupOptions = {
  now?: Date;
  databasePath?: string;
  force?: boolean;
  intervalMs?: number;
};

export type StateCleanupReport = {
  ran: boolean;
  reason: "completed" | "not_due";
  seenRowsRemoved: number;
  crossSourceIdentitiesRemoved: number;
  sentOutboxRowsRemoved: number;
  diagnosticRowsRemoved: number;
  durationMs: number;
  databaseBytes?: number;
  finishedAt: string;
};

/**
 * Delete aged operational rows.
 * Never deletes pending/sending/failed outbox rows, baselines, the poller lock,
 * seller-policy metadata, or the current source_health row.
 */
export function runStateCleanupIfDue(
  db: DatabaseSync,
  options: StateCleanupOptions = {},
): StateCleanupReport {
  const now = options.now ?? new Date();
  const intervalMs = options.intervalMs ?? STATE_RETENTION.cleanupIntervalMs;
  const started = Date.now();
  if (!options.force) {
    const previous = readMeta(db, STATE_CLEANUP_META_KEY);
    const last = previous ? Date.parse(previous) : Number.NaN;
    if (Number.isFinite(last) && now.getTime() - last < intervalMs) {
      return {
        ran: false,
        reason: "not_due",
        seenRowsRemoved: 0,
        crossSourceIdentitiesRemoved: 0,
        sentOutboxRowsRemoved: 0,
        diagnosticRowsRemoved: 0,
        durationMs: Date.now() - started,
        finishedAt: now.toISOString(),
      };
    }
  }
  return runStateCleanup(db, now, options.databasePath, started);
}

function runStateCleanup(
  db: DatabaseSync,
  now: Date,
  databasePath: string | undefined,
  started: number,
): StateCleanupReport {
  const seenCutoff = new Date(now.getTime() - STATE_RETENTION.seenInactiveMs).toISOString();
  const identityCutoff = new Date(now.getTime() - STATE_RETENTION.crossSourceIdentityMs).toISOString();
  const sentCutoff = new Date(now.getTime() - STATE_RETENTION.sentOutboxMs).toISOString();
  const finishedAt = now.toISOString();
  let seenRowsRemoved: number;
  let crossSourceIdentitiesRemoved: number;
  let sentOutboxRowsRemoved: number;

  db.exec("BEGIN IMMEDIATE;");
  try {
    const identities = db
      .prepare(
        `DELETE FROM cross_source_identities
         WHERE created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM telegram_outbox AS o
             WHERE o.source = cross_source_identities.source
               AND o.source_id = cross_source_identities.source_id
               AND o.status IN ('pending', 'sending', 'failed')
           )
           AND NOT EXISTS (
             SELECT 1 FROM telegram_outbox AS o
             WHERE o.source = cross_source_identities.source
               AND o.source_id = cross_source_identities.source_id
               AND o.status = 'sent'
               AND (o.sent_at IS NULL OR o.sent_at >= ?)
           )`,
      )
      .run(identityCutoff, sentCutoff);
    crossSourceIdentitiesRemoved = changed(identities);

    const sent = db
      .prepare(
        `DELETE FROM telegram_outbox
         WHERE status = 'sent'
           AND sent_at IS NOT NULL
           AND sent_at < ?`,
      )
      .run(sentCutoff);
    sentOutboxRowsRemoved = changed(sent);

    const seen = db
      .prepare(
        `DELETE FROM seen_listings
         WHERE last_seen_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM telegram_outbox AS o
             WHERE (
               (o.source = seen_listings.source AND o.source_id = seen_listings.source_id)
               OR o.fingerprint = seen_listings.fingerprint
             )
             AND o.status IN ('pending', 'sending', 'failed', 'sent')
           )`,
      )
      .run(seenCutoff);
    seenRowsRemoved = changed(seen);

    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(
      STATE_CLEANUP_META_KEY,
      finishedAt,
    );
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  }

  const databaseBytes = databaseFileBytes(databasePath);
  return {
    ran: true,
    reason: "completed",
    seenRowsRemoved,
    crossSourceIdentitiesRemoved,
    sentOutboxRowsRemoved,
    diagnosticRowsRemoved: 0,
    durationMs: Date.now() - started,
    ...(databaseBytes !== undefined ? { databaseBytes } : {}),
    finishedAt,
  };
}

function changed(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function databaseFileBytes(databasePath: string | undefined): number | undefined {
  if (!databasePath) {
    return undefined;
  }
  let total = 0;
  let found = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(`${databasePath}${suffix}`).size;
      found = true;
    } catch {
      // The WAL/SHM sidecar is optional.
    }
  }
  return found ? total : undefined;
}
