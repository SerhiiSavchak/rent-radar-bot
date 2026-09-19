import type { Listing } from "../domain/listing.ts";
import { canonicalListingUrl, type ListingDedupe } from "./delivery-ports.ts";

/**
 * Process-local dedupe for TEST Telegram delivery (no DB required).
 * Exact keys only: `source:sourceId` and canonical listing URL.
 * Does NOT merge by phone/price similarity.
 *
 * Restart durability: **in-memory only** — a process restart forgets all keys.
 * Do not claim cross-restart dedupe without an approved persistence layer.
 */
export class InMemoryListingDedupe implements ListingDedupe {
  private readonly ids = new Set<string>();
  private readonly urls = new Set<string>();

  keyOf(listing: Pick<Listing, "source" | "sourceId">): string {
    return `${listing.source}:${listing.sourceId}`;
  }

  hasSeen(listing: Pick<Listing, "source" | "sourceId" | "url">): boolean {
    if (this.ids.has(this.keyOf(listing))) {
      return true;
    }
    return this.urls.has(canonicalListingUrl(listing.url));
  }

  markSeen(listing: Pick<Listing, "source" | "sourceId" | "url">): void {
    this.ids.add(this.keyOf(listing));
    this.urls.add(canonicalListingUrl(listing.url));
  }

  /** Return unseen listings without marking (failed sends must remain eligible). */
  filterUnseen(listings: Listing[]): Listing[] {
    const fresh: Listing[] = [];
    for (const listing of listings) {
      if (this.hasSeen(listing)) {
        continue;
      }
      fresh.push(listing);
    }
    return fresh;
  }

  /**
   * @deprecated Prefer filterUnseen + markSeen after successful delivery.
   * Still marks immediately — do not use for send pipelines.
   */
  takeNew(listings: Listing[]): Listing[] {
    const fresh = this.filterUnseen(listings);
    for (const listing of fresh) {
      this.markSeen(listing);
    }
    return fresh;
  }

  get size(): number {
    return this.ids.size;
  }
}
