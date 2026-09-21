import type { Listing } from "../domain/listing.ts";
import type { ListingSource } from "../domain/listing.ts";
import type { ListingDedupe, SourceBaseline } from "./delivery-ports.ts";

/**
 * Per-source silent baseline for TEST Telegram delivery.
 * A failed fetch must NOT establish a baseline (avoids flood on recovery).
 *
 * State is process-local: on restart every source needs a silent re-baseline.
 * Does not use SQLite (TEST mode stays free of unapproved DB coupling).
 */
export class InMemorySourceBaseline implements SourceBaseline {
  private readonly ready = new Map<string, Date>();

  hasBaseline(source: ListingSource | string): boolean {
    return this.ready.has(source);
  }

  establishedAt(source: ListingSource | string): Date | undefined {
    return this.ready.get(source);
  }

  /**
   * Mark listings seen and record a successful baseline for this source.
   * Call only after ok / valid_empty fetch for that source.
   */
  establishSilent(
    source: ListingSource | string,
    listings: Listing[],
    dedupe: ListingDedupe,
    at = new Date(),
  ): number {
    for (const listing of listings) {
      dedupe.markSeen(listing);
    }
    this.ready.set(source, at);
    return listings.length;
  }

  recordSuccess(): void {
    // Process-local baseline has no last_success_at column.
  }

  /** Sources that already completed a successful baseline this process. */
  baselinedSources(): string[] {
    return [...this.ready.keys()].sort();
  }

  get survivesRestart(): false {
    return false;
  }
}
