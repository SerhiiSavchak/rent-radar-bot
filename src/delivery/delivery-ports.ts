import type { Listing } from "../domain/listing.ts";

export type ListingDedupe = {
  hasSeen(listing: Pick<Listing, "source" | "sourceId" | "url">): boolean;
  markSeen(listing: Pick<Listing, "source" | "sourceId" | "url">): void;
  filterUnseen(listings: Listing[]): Listing[];
  /**
   * Refresh last_seen_at when the row already exists.
   * Must not insert. A new listing stays unseen until markSeen.
   */
  noteObserved?(listing: Pick<Listing, "source" | "sourceId" | "url">, at?: Date): void;
};

export type SourceHealthWrite = {
  source: string;
  resultKind?: string;
  transport?: string;
  httpStatus?: number;
  errorSafe?: string;
  listingCount?: number;
  ok?: boolean;
};

export type SourceBaseline = {
  hasBaseline(source: string): boolean;
  establishedAt(source: string): Date | undefined;
  establishSilent(source: string, listings: Listing[], dedupe: ListingDedupe, at?: Date): number;
  /** Touch last successful fetch without rewriting established_at. */
  recordSuccess(source: string, at?: Date): void;
  readonly survivesRestart: boolean;
  ensureSellerPolicy?(policy: string, at?: Date): Date | undefined;
  sellerPolicyCutoverAt?(): Date | undefined;
  /** Latest attempt for one source. In-memory baselines omit this. */
  recordSourceHealth?(update: SourceHealthWrite, at?: Date): void;
};

export type OutboxStatus = "pending" | "sending" | "sent" | "failed";
export type OutboxErrorClass = "transient" | "permanent";

export type OutboxItem = {
  id: number;
  source: string;
  sourceId: string;
  fingerprint: string;
  listing: Listing;
  deliveryKind: "new_publication" | "first_noticed" | "initial_preview";
  status: OutboxStatus;
  attemptCount: number;
  lastAttemptAt?: string;
  lastError?: string;
  errorClass?: OutboxErrorClass;
  nextAttemptAt?: string;
};

export type TelegramOutbox = {
  enqueueIfNew(
    listing: Listing,
    deliveryKind: OutboxItem["deliveryKind"],
  ): { id: number; status: OutboxStatus; duplicate: boolean };
  claimForSend(id: number, at?: Date): boolean;
  markSent(id: number, at?: Date): void;
  markFailed(
    id: number,
    error: string,
    at?: Date,
    details?: { errorClass?: OutboxErrorClass; retryAfterMs?: number },
  ): void;
  listRetryable(limit?: number, at?: Date): OutboxItem[];
};

export function listingFingerprint(listing: Pick<Listing, "source" | "sourceId" | "url">): string {
  return `${listing.source}:${listing.sourceId}:${canonicalListingUrl(listing.url)}`;
}

export function canonicalListingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.hostname}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
