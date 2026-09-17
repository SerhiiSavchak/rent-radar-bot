import type { Listing } from "../domain/listing.ts";

function normalizeUrl(url: string): string {
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

/** Process-local dedupe for TEST Telegram delivery (no DB required). */
export class InMemoryListingDedupe {
  private readonly ids = new Set<string>();
  private readonly urls = new Set<string>();

  keyOf(listing: Pick<Listing, "source" | "sourceId">): string {
    return `${listing.source}:${listing.sourceId}`;
  }

  hasSeen(listing: Pick<Listing, "source" | "sourceId" | "url">): boolean {
    if (this.ids.has(this.keyOf(listing))) {
      return true;
    }
    return this.urls.has(normalizeUrl(listing.url));
  }

  markSeen(listing: Pick<Listing, "source" | "sourceId" | "url">): void {
    this.ids.add(this.keyOf(listing));
    this.urls.add(normalizeUrl(listing.url));
  }

  /** Return only unseen listings and mark them seen. */
  takeNew(listings: Listing[]): Listing[] {
    const fresh: Listing[] = [];
    for (const listing of listings) {
      if (this.hasSeen(listing)) {
        continue;
      }
      this.markSeen(listing);
      fresh.push(listing);
    }
    return fresh;
  }
}
