import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import {
  canonicalListingUrl,
  listingFingerprint,
  type ListingDedupe,
  type OutboxItem,
  type OutboxStatus,
  type SourceBaseline,
  type TelegramOutbox,
} from "../delivery/delivery-ports.ts";

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
};

export class DurableDeliveryStore implements ListingDedupe, SourceBaseline, TelegramOutbox {
  readonly survivesRestart = true as const;

  constructor(private readonly db: DatabaseSync) {
    recoverInterruptedSends(db);
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

  markSeen(listing: Pick<Listing, "source" | "sourceId" | "url"> & Partial<Pick<Listing, "publishedAt" | "refreshedAt">>): void {
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
      return;
    }
    this.db
      .prepare(
        `INSERT INTO seen_listings (
          source, source_id, fingerprint, canonical_url, first_seen_at, last_seen_at, published_at, refreshed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(listing.source, listing.sourceId, fingerprint, url, now, now, published, refreshed);
  }

  filterUnseen(listings: Listing[]): Listing[] {
    return listings.filter((listing) => !this.hasSeen(listing));
  }

  hasBaseline(source: string): boolean {
    return Boolean(this.db.prepare("SELECT source FROM source_baselines WHERE source = ?").get(source));
  }

  establishedAt(source: string): Date | undefined {
    const row = this.db
      .prepare("SELECT established_at AS establishedAt FROM source_baselines WHERE source = ?")
      .get(source) as { establishedAt: string } | undefined;
    return row ? new Date(row.establishedAt) : undefined;
  }

  establishSilent(source: string, listings: Listing[], dedupe: ListingDedupe, at = new Date()): number {
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

  enqueueIfNew(
    listing: Listing,
    deliveryKind: OutboxItem["deliveryKind"],
  ): { id: number; status: OutboxStatus; duplicate: boolean } {
    const fingerprint = listingFingerprint(listing);
    const existing = this.db
      .prepare("SELECT id, status FROM telegram_outbox WHERE fingerprint = ?")
      .get(fingerprint) as { id: number; status: OutboxStatus } | undefined;
    if (existing) {
      return { id: existing.id, status: existing.status, duplicate: true };
    }
    const created = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO telegram_outbox (
          source, source_id, fingerprint, listing_json, delivery_kind, status, attempt_count, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(listing.source, listing.sourceId, fingerprint, serializeListing(listing), deliveryKind, created);
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
        "UPDATE telegram_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ? AND status = 'sending'",
      )
      .run(at.toISOString(), id);
  }

  markFailed(id: number, error: string, at = new Date()): void {
    this.db
      .prepare(
        "UPDATE telegram_outbox SET status = 'failed', last_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'sending'",
      )
      .run(at.toISOString(), error.slice(0, 400), id);
  }

  listRetryable(limit = 50): OutboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, source, source_id, fingerprint, listing_json, delivery_kind, status, attempt_count, last_attempt_at, last_error
         FROM telegram_outbox
         WHERE status IN ('pending', 'failed')
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(limit) as OutboxRow[];
    return rows.map(rowToOutboxItem);
  }

  seenFingerprints(): string[] {
    const rows = this.db.prepare("SELECT fingerprint FROM seen_listings").all() as SeenRow[];
    return rows.map((row) => row.fingerprint);
  }
}

export function recoverInterruptedSends(db: DatabaseSync): number {
  const result = db
    .prepare("UPDATE telegram_outbox SET status = 'pending' WHERE status = 'sending'")
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
  };
}
