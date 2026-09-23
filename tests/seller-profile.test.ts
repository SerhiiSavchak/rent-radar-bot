import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySellerProfileGate,
  assessSellerProfile,
  deleteExpiredSellerProfiles,
  sellerProfileId,
  verdictWhenProfileUnreadable,
} from "../src/delivery/seller-profile.ts";
import type { Listing } from "../src/domain/listing.ts";
import { closeDb } from "../src/storage/db.ts";
import { applyMigrations } from "../src/storage/migrations.ts";

function card(overrides: Partial<Listing> & Pick<Listing, "source" | "sourceId" | "url">): Listing {
  return {
    title: "Квартира",
    location: { raw: "Львів, вул. Зелена, 1", city: "Львів" },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: new Date("2026-09-23T08:00:00.000Z"),
    ...overrides,
  };
}

describe("seller profile classifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-profile-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
  });

  function openDb(): DatabaseSync {
    fileIndex += 1;
    const db = new DatabaseSync(join(dir, `case-${fileIndex}.sqlite`));
    applyMigrations(db);
    return db;
  }

  it("drops an explicit agency profile and keeps a single weak business flag", () => {
    const agency = assessSellerProfile({
      confirmedOwner: false,
      addresses: ["agency"],
      now: new Date("2026-09-23T08:00:00.000Z"),
    });
    expect(agency.verdict).toBe("unknown");
    expect(agency.drop).toBe(false);
    const businessOnly = card({
      source: "olx",
      sourceId: "1",
      url: "https://www.olx.ua/d/uk/obyavlenie/1",
      metadata: { olxUserId: "user-1", olxIsBusiness: true },
    });
    const gated = applySellerProfileGate([businessOnly], undefined, new Date("2026-09-23T08:00:00.000Z"));
    expect(gated.dropped).toBe(0);
    expect(gated.kept).toHaveLength(1);
  });

  it("drops several distinct addresses for one seller and keeps one address", () => {
    const now = new Date("2026-09-23T08:00:00.000Z");
    const listings = [
      card({
        source: "olx",
        sourceId: "a",
        url: "https://www.olx.ua/d/uk/obyavlenie/a",
        location: { raw: "Львів, вул. Зелена, 1" },
        metadata: { olxUserId: "same" },
      }),
      card({
        source: "olx",
        sourceId: "b",
        url: "https://www.olx.ua/d/uk/obyavlenie/b",
        location: { raw: "Львів, вул. Городоцька, 20" },
        metadata: { olxUserId: "same" },
      }),
      card({
        source: "domria",
        sourceId: "c",
        url: "https://dom.ria.com/uk/realty-c.html",
        location: { raw: "Львів, вул. Одна, 3" },
        metadata: { userId: "owner-1" },
      }),
    ];
    const gated = applySellerProfileGate(listings, undefined, now);
    expect(gated.dropped).toBe(2);
    expect(gated.kept.map((item) => item.sourceId)).toEqual(["c"]);
  });

  it("does not turn a profile failure into a confirmed owner", () => {
    const decision = verdictWhenProfileUnreadable();
    expect(decision.verdict).toBe("unknown");
    expect(decision.verdict).not.toBe("confirmed_owner");
    expect(decision.drop).toBe(false);
  });

  it("reuses cached addresses after reopen and does not mix seller ids across sources", () => {
    const path = join(dir, "restart.sqlite");
    const now = new Date("2026-09-23T08:00:00.000Z");
    const first = new DatabaseSync(path);
    applyMigrations(first);
    const initial = applySellerProfileGate(
      [
        card({
          source: "olx",
          sourceId: "1",
          url: "https://www.olx.ua/d/uk/obyavlenie/1",
          location: { raw: "Львів, вул. Зелена, 1" },
          metadata: { olxUserId: "77" },
        }),
      ],
      first,
      now,
    );
    expect(initial.dropped).toBe(0);
    first.close();
    const reopened = new DatabaseSync(path);
    const again = applySellerProfileGate(
      [
        card({
          source: "olx",
          sourceId: "2",
          url: "https://www.olx.ua/d/uk/obyavlenie/2",
          location: { raw: "Львів, вул. Городоцька, 9" },
          metadata: { olxUserId: "77" },
        }),
        card({
          source: "domria",
          sourceId: "3",
          url: "https://dom.ria.com/uk/realty-3.html",
          location: { raw: "Львів, вул. Інша, 4" },
          metadata: { userId: "77" },
        }),
      ],
      reopened,
      now,
    );
    expect(again.dropped).toBe(1);
    expect(again.kept.map((item) => item.source)).toEqual(["domria"]);
    reopened.close();
  });

  it("drops a supplied new-account timestamp and forgets expired cache rows", () => {
    const now = new Date("2026-09-23T08:00:00.000Z");
    const fresh = card({
      source: "olx",
      sourceId: "new",
      url: "https://www.olx.ua/d/uk/obyavlenie/new",
      metadata: { olxUserId: "new-user", accountCreatedAt: "2026-09-22T08:00:00.000Z" },
    });
    expect(applySellerProfileGate([fresh], undefined, now).dropped).toBe(1);
    const old = card({
      source: "olx",
      sourceId: "old",
      url: "https://www.olx.ua/d/uk/obyavlenie/old",
      metadata: { olxUserId: "old-user", accountCreatedAt: "2020-01-01T00:00:00.000Z" },
    });
    expect(applySellerProfileGate([old], undefined, now).dropped).toBe(0);
    const db = openDb();
    applySellerProfileGate(
      [
        card({
          source: "olx",
          sourceId: "aged",
          url: "https://www.olx.ua/d/uk/obyavlenie/aged",
          metadata: { olxUserId: "aged" },
        }),
      ],
      db,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(deleteExpiredSellerProfiles(db, now)).toBe(1);
    expect(sellerProfileId(fresh)).toBe("new-user");
    db.close();
  });

  it("keeps a platform-confirmed owner even when another address is cached", () => {
    const now = new Date("2026-09-23T08:00:00.000Z");
    const db = openDb();
    applySellerProfileGate(
      [
        card({
          source: "domria",
          sourceId: "1",
          url: "https://dom.ria.com/uk/realty-1.html",
          sellerType: "owner",
          metadata: { userId: "owner", ownerEvidenceLevel: "platform_confirmed" },
          location: { raw: "Львів, вул. Перша, 1" },
        }),
      ],
      db,
      now,
    );
    const second = applySellerProfileGate(
      [
        card({
          source: "domria",
          sourceId: "2",
          url: "https://dom.ria.com/uk/realty-2.html",
          sellerType: "owner",
          metadata: { userId: "owner", ownerEvidenceLevel: "platform_confirmed" },
          location: { raw: "Львів, вул. Друга, 2" },
        }),
      ],
      db,
      now,
    );
    expect(second.dropped).toBe(0);
    db.close();
  });
});
