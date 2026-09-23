import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Listing } from "../src/domain/listing.ts";
import { closeDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { applyMigrations } from "../src/storage/migrations.ts";

/**
 * 2026-09-23 19:35 and 20:35 Kyiv. Two OLX houses, both 9000 UAH, Frankivskyi.
 * Different source ids, URLs, seller ids, and photo file ids. No shop, partner, or externalUrl link.
 */
function kosteyiv(sourceId: string, token: string, sellerId: string, photo: string): Listing {
  return {
    source: "olx",
    sourceId,
    url: `https://www.olx.ua/d/uk/obyavlenie/budynok-${token}-ID${token}.html`,
    title: "Будинок",
    location: { raw: "Львів, Франківський", city: "Львів" },
    propertyType: "house",
    sellerType: "unknown",
    price: { amount: 9000, currency: "UAH", period: "month" },
    images: [`https://ireland.apollo.olxcdn.com/v1/files/${photo}/image`],
    discoveredAt: new Date("2026-09-23T16:35:00.000Z"),
    metadata: { olxUserId: sellerId, ownerEvidenceLevel: "self_declared" },
  };
}

describe("observed OLX repost pair", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-dup-"));
  let index = 0;

  afterEach(() => {
    closeDb();
  });

  function store(): DurableDeliveryStore {
    index += 1;
    const db = new DatabaseSync(join(dir, `${index}.sqlite`));
    applyMigrations(db);
    return new DurableDeliveryStore(db);
  }

  const first = kosteyiv("935759871", "11klT9", "172271722", "jhfy5fppemhc");
  const second = kosteyiv("935765176", "11kngI", "2096100494", "mtwsjsfndkkf1");

  it("does not suppress the second Kosteyiv card and still blocks an exact resend", () => {
    const db = store();
    db.rememberCrossSource(first);
    db.markSeen(first);
    const firstOutbox = db.enqueueIfNew(first, "new_publication");
    const secondOutbox = db.enqueueIfNew(second, "new_publication");
    expect(firstOutbox.duplicate).toBe(false);
    expect(secondOutbox.duplicate).toBe(false);
    expect(db.assessCrossSource(second, [first]).suppress).toBe(false);
    expect(db.hasSeen(first)).toBe(true);
    expect(db.hasSeen({ ...first, sourceId: "other-id" })).toBe(true);
    expect(db.hasSeen(second)).toBe(false);
    expect(new Set([...(first.images ?? []), ...(second.images ?? [])]).size).toBe(2);
    const replay = db.enqueueIfNew(first, "new_publication");
    expect(replay.duplicate).toBe(true);
    expect(replay.id).toBe(firstOutbox.id);
  });
});
