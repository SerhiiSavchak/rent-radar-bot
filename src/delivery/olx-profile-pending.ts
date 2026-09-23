import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import { deserializeListing, serializeListing } from "../storage/durable-delivery-store.ts";

const PENDING_PREFIX = "olx_profile_pending:";

/**
 * A deliverable OLX listing whose seller profile was not read because the cycle
 * budget was full. It is not seen, queued, or classified. The next poll loads it
 * even if the catalog page no longer contains it.
 */
export function saveOlxProfilePending(db: DatabaseSync, listing: Listing): void {
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(
    `${PENDING_PREFIX}${listing.sourceId}`,
    serializeListing(listing),
  );
}

export function deleteOlxProfilePending(db: DatabaseSync, sourceId: string): void {
  db.prepare("DELETE FROM schema_meta WHERE key = ?").run(`${PENDING_PREFIX}${sourceId}`);
}

export function listOlxProfilePending(db: DatabaseSync): Listing[] {
  const rows = db
    .prepare("SELECT value FROM schema_meta WHERE key LIKE ? ORDER BY key")
    .all(`${PENDING_PREFIX}%`) as Array<{ value: string }>;
  const listings: Listing[] = [];
  for (const row of rows) {
    try {
      listings.push(deserializeListing(row.value));
    } catch {
      // A corrupt pending row is ignored. The key stays until a later decision deletes it.
    }
  }
  return listings;
}
