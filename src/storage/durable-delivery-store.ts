import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import {
  decideFromHits,
  type CrossSourceDecision,
  type IdentityHit,
} from "../delivery/cross-source-dedup.ts";
import {
  channelPauseDelayMs,
  TELEGRAM_PAUSE_FAILURES_KEY,
  TELEGRAM_PAUSE_REASON_KEY,
  TELEGRAM_PAUSE_UNTIL_KEY,
  transientNextDelayMs,
} from "../delivery/telegram-delivery.ts";
import {
  canonicalListingUrl,
  listingFingerprint,
  type ListingDedupe,
  type OutboxErrorClass,
  type OutboxItem,
  type OutboxStatus,
  type SourceBaseline,
  type SourceHealthWrite,
  type TelegramOutbox,
} from "../delivery/delivery-ports.ts";
import { identityKeys, type IdentityKeyClass } from "../domain/provenance.ts";
import { writeSourceHealth } from "./source-health.ts";

type SeenRow = {
  source: string;
  source_id: string;
  fingerprint: string;
  canonical_url: string;
};

type OutboxRow = {
  id: number;
  source: string;
  source_id: string;
  fingerprint: string;
  listing_json: string;
  delivery_kind: OutboxItem["deliveryKind"];
  status: OutboxStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  error_class: string | null;
  next_attempt_at: string | null;
};

export class DurableDeliveryStore implements ListingDedupe, SourceBaseline, TelegramOutbox {
  readonly survivesRestart = true as const;

  constructor(private readonly db: DatabaseSync) {
    recoverInterruptedSends(db);
  }

  /** SQLite connection used for the linked-seller cache. Not a second database. */
  verificationDatabase(): DatabaseSync {
    return this.db;
  }

  hasSeen(listing: Pick<Listing, "source" | "sourceId" | "url">): boolean {
    const byId = this.db
      .prepare("SELECT source FROM seen_listings WHERE source = ? AND source_id = ? LIMIT 1")
      .get(listing.source, listing.sourceId);
    if (byId) {
      return true;
    }
    const byUrl = this.db
      .prepare("SELECT source FROM seen_listings WHERE canonical_url = ? LIMIT 1")
      .get(canonicalListingUrl(listing.url));
    if (byUrl) {
      return true;
    }
    const sent = this.db
      .prepare("SELECT id FROM telegram_outbox WHERE fingerprint = ? AND status = 'sent' LIMIT 1")
      .get(listingFingerprint(listing));
    return Boolean(sent);
  }

  markSeen(
    listing: Pick<Listing, "source" | "sourceId" | "url"> &
      Partial<
        Pick<Listing, "publishedAt" | "refreshedAt" | "metadata" | "rooms" | "areaM2" | "price">
      >,
  ): void {
    const now = new Date().toISOString();
    const url = canonicalListingUrl(listing.url);
    const fingerprint = listingFingerprint(listing);
    const published = listing.publishedAt?.toISOString() ?? null;
    const refreshed = listing.refreshedAt?.toISOString() ?? null;
    const existing = this.db
      .prepare("SELECT first_seen_at FROM seen_listings WHERE source = ? AND source_id = ? LIMIT 1")
      .get(listing.source, listing.sourceId) as { first_seen_at: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          "UPDATE seen_listings SET canonical_url = ?, fingerprint = ?, last_seen_at = ?, published_at = COALESCE(?, published_at), refreshed_at = COALESCE(?, refreshed_at) WHERE source = ? AND source_id = ?",
        )
        .run(url, fingerprint, now, published, refreshed, listing.source, listing.sourceId);
    } else {
      this.db
        .prepare(
          `INSERT INTO seen_listings (
          source, source_id, fingerprint, canonical_url, first_seen_at, last_seen_at, published_at, refreshed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(listing.source, listing.sourceId, fingerprint, url, now, now, published, refreshed);
    }
  }

  noteObserved(listing: Pick<Listing, "source" | "sourceId" | "url">, at = new Date()): void {
    const iso = at.toISOString();
    const url = canonicalListingUrl(listing.url);
    this.db
      .prepare(
        "UPDATE seen_listings SET last_seen_at = ? WHERE source = ? AND source_id = ? AND last_seen_at < ?",
      )
      .run(iso, listing.source, listing.sourceId, iso);
    this.db
      .prepare(
        "UPDATE seen_listings SET last_seen_at = ? WHERE canonical_url = ? AND last_seen_at < ?",
      )
      .run(iso, url, iso);
  }

  assessCrossSource(listing: Listing, peers: Listing[] = []): CrossSourceDecision {
    const keys = identityKeys(listing);
    const hits: IdentityHit[] = [];
    const query = this.db.prepare(
      `SELECT identity_key AS identityKey, key_class AS keyClass, source, source_id AS sourceId
       FROM cross_source_identities
       WHERE identity_key = ? AND NOT (source = ? AND source_id = ?)`,
    );
    for (const item of keys) {
      const rows = query.all(item.key, listing.source, listing.sourceId) as Array<{
        identityKey: string;
        keyClass: string;
        source: string;
        sourceId: string;
      }>;
      for (const row of rows) {
        const theirClass = asKeyClass(row.keyClass);
        if (!theirClass) {
          continue;
        }
        hits.push({
          key: row.identityKey,
          ourClass: item.keyClass,
          theirClass,
          source: row.source,
          sourceId: row.sourceId,
        });
      }
    }
    return decideFromHits(listing, hits, peers);
  }

  rememberCrossSource(
    listing: Pick<Listing, "source" | "sourceId" | "url"> &
      Partial<Pick<Listing, "metadata" | "rooms" | "areaM2" | "price">>,
  ): void {
    if (identityKeys(listing).length === 0) {
      return;
    }
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.insertIdentityKeys(listing, new Date().toISOString());
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /**
   * Writes confirmed identity keys. Caller must already be inside a transaction
   * when this has to commit together with an outbox row.
   */
  private insertIdentityKeys(
    listing: Pick<Listing, "source" | "sourceId" | "url"> &
      Partial<Pick<Listing, "metadata" | "rooms" | "areaM2" | "price">>,
    createdAt: string,
  ): void {
    const keys = identityKeys(listing);
    if (keys.length === 0) {
      return;
    }
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO cross_source_identities (
        identity_key, key_class, source, source_id, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const item of keys) {
      insert.run(item.key, item.keyClass, listing.source, listing.sourceId, createdAt);
    }
  }

  filterUnseen(listings: Listing[]): Listing[] {
    return listings.filter((listing) => !this.hasSeen(listing));
  }

  hasBaseline(source: string): boolean {
    return Boolean(
      this.db.prepare("SELECT source FROM source_baselines WHERE source = ?").get(source),
    );
  }

  establishedAt(source: string): Date | undefined {
    const row = this.db
      .prepare("SELECT established_at AS establishedAt FROM source_baselines WHERE source = ?")
      .get(source) as { establishedAt: string } | undefined;
    return row ? new Date(row.establishedAt) : undefined;
  }

  establishSilent(
    source: string,
    listings: Listing[],
    dedupe: ListingDedupe,
    at = new Date(),
  ): number {
    for (const listing of listings) {
      dedupe.markSeen(listing);
    }
    const iso = at.toISOString();
    this.db
      .prepare(
        `INSERT INTO source_baselines (source, established_at, last_success_at, seed_listing_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET last_success_at = excluded.last_success_at`,
      )
      .run(source, iso, iso, listings.length);
    return listings.length;
  }

  recordSuccess(source: string, at = new Date()): void {
    this.recordSourceSuccess(source, at);
  }

  recordSourceSuccess(source: string, at = new Date()): void {
    this.db
      .prepare("UPDATE source_baselines SET last_success_at = ? WHERE source = ?")
      .run(at.toISOString(), source);
  }

  recordSourceHealth(input: SourceHealthWrite, at = new Date()): void {
    writeSourceHealth(this.db, input, at);
  }

  enqueueIfNew(
    listing: Listing,
    deliveryKind: OutboxItem["deliveryKind"],
  ): { id: number; status: OutboxStatus; duplicate: boolean } {
    const fingerprint = listingFingerprint(listing);
    const existing = this.db
      .prepare("SELECT id, status FROM telegram_outbox WHERE fingerprint = ?")
      .get(fingerprint) as { id: number; status: OutboxStatus } | undefined;
    if (existing) {
      // The outbox row is already durable, so identity cannot outrun delivery state.
      this.rememberCrossSource(listing);
      return { id: existing.id, status: existing.status, duplicate: true };
    }
    const created = new Date().toISOString();
    const insertOutbox = this.db.prepare(
      `INSERT INTO telegram_outbox (
        source, source_id, fingerprint, listing_json, delivery_kind, status, attempt_count, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      insertOutbox.run(
        listing.source,
        listing.sourceId,
        fingerprint,
        serializeListing(listing),
        deliveryKind,
        created,
      );
      this.insertIdentityKeys(listing, created);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    const row = this.db
      .prepare("SELECT id FROM telegram_outbox WHERE fingerprint = ?")
      .get(fingerprint) as { id: number };
    return { id: row.id, status: "pending", duplicate: false };
  }

  claimForSend(id: number, at = new Date()): boolean {
    const result = this.db
      .prepare(
        "UPDATE telegram_outbox SET status = 'sending', last_attempt_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND status IN ('pending', 'failed')",
      )
      .run(at.toISOString(), id);
    return Number(result.changes) === 1;
  }

  markSent(id: number, at = new Date()): void {
    this.db
      .prepare(
        `UPDATE telegram_outbox
         SET status = 'sent', sent_at = ?, last_error = NULL, error_class = NULL, next_attempt_at = NULL
         WHERE id = ? AND status = 'sending'`,
      )
      .run(at.toISOString(), id);
  }

  markFailed(
    id: number,
    error: string,
    at = new Date(),
    details?: { errorClass?: OutboxErrorClass; retryAfterMs?: number },
  ): void {
    const errorClass = details?.errorClass ?? "transient";
    const attempt = this.db
      .prepare("SELECT attempt_count AS attemptCount FROM telegram_outbox WHERE id = ?")
      .get(id) as { attemptCount: number } | undefined;
    const nextAttemptAt =
      errorClass === "permanent"
        ? null
        : new Date(
            at.getTime() +
              transientNextDelayMs(attempt?.attemptCount ?? 1, details?.retryAfterMs ?? 0),
          ).toISOString();
    this.db
      .prepare(
        `UPDATE telegram_outbox
         SET status = 'failed', last_attempt_at = ?, last_error = ?, error_class = ?, next_attempt_at = ?
         WHERE id = ? AND status = 'sending'`,
      )
      .run(at.toISOString(), error.slice(0, 400), errorClass, nextAttemptAt, id);
  }

  listRetryable(limit = 50, at = new Date()): OutboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, source, source_id, fingerprint, listing_json, delivery_kind, status,
                attempt_count, last_attempt_at, last_error, error_class, next_attempt_at
         FROM telegram_outbox
         WHERE status IN ('pending', 'failed')
           AND COALESCE(error_class, 'transient') != 'permanent'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(at.toISOString(), limit) as OutboxRow[];
    return rows.map(rowToOutboxItem);
  }

  seenFingerprints(): string[] {
    const rows = this.db.prepare("SELECT fingerprint FROM seen_listings").all() as SeenRow[];
    return rows.map((row) => row.fingerprint);
  }

  ensureSellerPolicy(policy: string, at = new Date()): Date | undefined {
    const stored = this.readMeta("seller_policy");
    const storedAt = this.readMeta("seller_policy_applied_at");
    if (stored === policy) {
      return storedAt ? new Date(storedAt) : undefined;
    }
    const baselineCount = this.db.prepare("SELECT COUNT(*) AS n FROM source_baselines").get() as {
      n: number;
    };
    this.writeMeta("seller_policy", policy);
    const expandingToApproved =
      policy === "reject_intermediaries" &&
      (stored === "owner_only" || (!stored && Number(baselineCount.n) > 0));
    if (expandingToApproved) {
      this.writeMeta("seller_policy_applied_at", at.toISOString());
      return at;
    }
    return storedAt ? new Date(storedAt) : undefined;
  }

  sellerPolicyCutoverAt(): Date | undefined {
    const raw = this.readMeta("seller_policy_applied_at");
    return raw ? new Date(raw) : undefined;
  }

  telegramPauseActive(at = new Date()): boolean {
    const until = this.readMeta(TELEGRAM_PAUSE_UNTIL_KEY);
    return until !== undefined && Date.parse(until) > at.getTime();
  }

  /** Durable channel pause. Survives restart. Does not mark any source unhealthy. */
  noteOperatorChannelFailure(
    at: Date,
    reason: string,
  ): { until: string; delayMs: number; failures: number } {
    const failures = Number(this.readMeta(TELEGRAM_PAUSE_FAILURES_KEY) ?? "0") + 1;
    const delayMs = channelPauseDelayMs(Number.isFinite(failures) ? failures : 1);
    const until = new Date(at.getTime() + delayMs).toISOString();
    this.writeMeta(TELEGRAM_PAUSE_UNTIL_KEY, until);
    this.writeMeta(TELEGRAM_PAUSE_REASON_KEY, reason.slice(0, 80));
    this.writeMeta(TELEGRAM_PAUSE_FAILURES_KEY, String(failures));
    return { until, delayMs, failures };
  }

  clearTelegramPause(): void {
    this.db
      .prepare("DELETE FROM schema_meta WHERE key IN (?, ?, ?)")
      .run(TELEGRAM_PAUSE_UNTIL_KEY, TELEGRAM_PAUSE_REASON_KEY, TELEGRAM_PAUSE_FAILURES_KEY);
  }

  private readMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  private writeMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)")
      .run(key, value);
  }
}

export function recoverInterruptedSends(db: DatabaseSync): number {
  const result = db
    .prepare(
      "UPDATE telegram_outbox SET status = 'pending', next_attempt_at = NULL WHERE status = 'sending'",
    )
    .run();
  return Number(result.changes);
}

export function serializeListing(listing: Listing): string {
  return JSON.stringify({
    ...listing,
    publishedAt: listing.publishedAt?.toISOString(),
    refreshedAt: listing.refreshedAt?.toISOString(),
    firstSeenAt: listing.firstSeenAt?.toISOString(),
    discoveredAt: listing.discoveredAt.toISOString(),
  });
}

export function deserializeListing(raw: string): Listing {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    ...(parsed as unknown as Listing),
    discoveredAt: new Date(String(parsed.discoveredAt)),
    ...(parsed.publishedAt ? { publishedAt: new Date(String(parsed.publishedAt)) } : {}),
    ...(parsed.refreshedAt ? { refreshedAt: new Date(String(parsed.refreshedAt)) } : {}),
    ...(parsed.firstSeenAt ? { firstSeenAt: new Date(String(parsed.firstSeenAt)) } : {}),
  };
}

function asKeyClass(value: string): IdentityKeyClass | undefined {
  if (value === "own" || value === "explicit_external" || value === "lun_cluster") {
    return value;
  }
  return undefined;
}

function rowToOutboxItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    fingerprint: row.fingerprint,
    listing: deserializeListing(row.listing_json),
    deliveryKind: row.delivery_kind,
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.error_class === "transient" ||
    row.error_class === "permanent" ||
    row.error_class === "operator_action"
      ? { errorClass: row.error_class }
      : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
  };
}
