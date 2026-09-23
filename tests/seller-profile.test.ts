import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import {
  applySellerProfileGate,
  assessSellerProfile,
  deleteExpiredSellerProfiles,
  DEFAULT_SELLER_PROFILE_POLICIES,
  sellerProfileId,
  shouldRejectSellerProfile,
  verdictWhenProfileUnreadable,
} from "../src/delivery/seller-profile.ts";
import type { Listing } from "../src/domain/listing.ts";
import { isSellerEligible } from "../src/filters/owner-filter.ts";
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
  const now = new Date("2026-09-23T08:00:00.000Z");

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function openDb(): DatabaseSync {
    fileIndex += 1;
    const db = new DatabaseSync(join(dir, `case-${fileIndex}.sqlite`));
    applyMigrations(db);
    return db;
  }

  it("keeps one address as unknown and sendable", () => {
    const decision = assessSellerProfile({
      confirmedOwner: false,
      addresses: ["львів вул зелена 1"],
      now,
    });
    expect(decision.verdict).toBe("unknown");
    expect(shouldRejectSellerProfile(decision.verdict)).toBe(false);
    const gated = applySellerProfileGate(
      [
        card({
          source: "olx",
          sourceId: "1",
          url: "https://www.olx.ua/d/uk/obyavlenie/1",
          metadata: { olxUserId: "one" },
        }),
      ],
      undefined,
      now,
    );
    expect(gated.dropped).toBe(0);
    expect(gated.profileLikelyIntermediary).toBe(0);
    expect(gated.kept).toHaveLength(1);
  });

  it("classifies two addresses as likely intermediary but sends by default", () => {
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
    ];
    const decision = assessSellerProfile({
      confirmedOwner: false,
      addresses: ["a", "b"],
      now,
    });
    expect(decision.verdict).toBe("profile_likely_intermediary");
    expect(shouldRejectSellerProfile(decision.verdict, DEFAULT_SELLER_PROFILE_POLICIES)).toBe(false);
    const gated = applySellerProfileGate(listings, undefined, now);
    expect(gated.dropped).toBe(0);
    expect(gated.profileRejected).toBe(0);
    expect(gated.profileLikelyIntermediary).toBe(2);
    expect(gated.kept).toHaveLength(2);
  });

  it("drops two-address inventory only when likely policy is reject", () => {
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
    ];
    const gated = applySellerProfileGate(listings, undefined, now, {
      likelyPolicy: "reject",
      newAccountPolicy: "send",
    });
    expect(gated.profileLikelyIntermediary).toBe(2);
    expect(gated.dropped).toBe(2);
    expect(gated.profileRejected).toBe(2);
    expect(gated.kept).toHaveLength(0);
  });

  it("reuses cached addresses after reopen and does not mix seller ids across sources", () => {
    const path = join(dir, "restart.sqlite");
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
    expect(again.profileLikelyIntermediary).toBe(1);
    expect(again.dropped).toBe(0);
    expect(again.kept.map((item) => item.sourceId).sort()).toEqual(["2", "3"]);
    const rejected = applySellerProfileGate(
      [
        card({
          source: "olx",
          sourceId: "4",
          url: "https://www.olx.ua/d/uk/obyavlenie/4",
          location: { raw: "Львів, вул. Третя, 3" },
          metadata: { olxUserId: "77" },
        }),
      ],
      reopened,
      now,
      { likelyPolicy: "reject", newAccountPolicy: "send" },
    );
    expect(rejected.dropped).toBe(1);
    reopened.close();
  });

  it("keeps a platform-confirmed owner even when another address is cached", () => {
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
      { likelyPolicy: "reject", newAccountPolicy: "reject" },
    );
    expect(second.dropped).toBe(0);
    expect(second.kept).toHaveLength(1);
    db.close();
  });

  it("keeps OLX isBusiness alone and does not treat it as confirmed intermediary", () => {
    const businessOnly = card({
      source: "olx",
      sourceId: "1",
      url: "https://www.olx.ua/d/uk/obyavlenie/1",
      metadata: { olxUserId: "user-1", olxIsBusiness: true },
    });
    expect(isSellerEligible(businessOnly)).toBe(true);
    const gated = applySellerProfileGate([businessOnly], undefined, now);
    expect(gated.dropped).toBe(0);
    expect(gated.kept).toHaveLength(1);
  });

  it("keeps a young account under the default new-account policy", () => {
    const fresh = card({
      source: "olx",
      sourceId: "new",
      url: "https://www.olx.ua/d/uk/obyavlenie/new",
      metadata: { olxUserId: "new-user", accountCreatedAt: "2026-09-22T08:00:00.000Z" },
    });
    const decision = assessSellerProfile({
      confirmedOwner: false,
      addresses: ["one"],
      accountCreatedAt: new Date("2026-09-22T08:00:00.000Z"),
      now,
    });
    expect(decision.verdict).toBe("profile_high_risk");
    expect(shouldRejectSellerProfile(decision.verdict)).toBe(false);
    const gated = applySellerProfileGate([fresh], undefined, now);
    expect(gated.profileHighRisk).toBe(1);
    expect(gated.dropped).toBe(0);
    const rejected = applySellerProfileGate([fresh], undefined, now, {
      likelyPolicy: "send",
      newAccountPolicy: "reject",
    });
    expect(rejected.dropped).toBe(1);
    expect(rejected.profileRejected).toBe(1);
  });

  it("does not turn a missing or unreadable seller identity into an owner", () => {
    const decision = verdictWhenProfileUnreadable();
    expect(decision.verdict).toBe("unknown");
    expect(decision.verdict).not.toBe("confirmed_owner");
    const noId = card({
      source: "lun",
      sourceId: "9",
      url: "https://lun.ua/uk/realty/9",
    });
    expect(sellerProfileId(noId)).toBeUndefined();
    const gated = applySellerProfileGate([noId], undefined, now);
    expect(gated.kept).toHaveLength(1);
    expect(gated.dropped).toBe(0);
  });

  it("still rejects strong confirmed intermediaries via the owner filter", () => {
    const agency = card({
      source: "domria",
      sourceId: "agency",
      url: "https://dom.ria.com/uk/realty-agency.html",
      sellerType: "unknown",
      metadata: {
        userId: "agency-user",
        agencyId: 52150,
        ownerEvidenceLevel: "intermediary",
        filterConsidersPrivateOwner: false,
      },
      sellerEvidence: ["DIM.RIA agency_id=52150"],
    });
    expect(isSellerEligible(agency)).toBe(false);
  });

  it("does not persist the profile cache during dry-run (undefined db)", () => {
    const db = openDb();
    applySellerProfileGate(
      [
        card({
          source: "olx",
          sourceId: "dry",
          url: "https://www.olx.ua/d/uk/obyavlenie/dry",
          metadata: { olxUserId: "dry-user" },
        }),
      ],
      undefined,
      now,
    );
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM seller_profile_cache")
      .get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });

  it("forgets expired cache rows and defaults both profile policies to send", () => {
    const defaults = loadConfig({});
    expect(defaults.sellerProfileLikelyPolicy).toBe("send");
    expect(defaults.sellerProfileNewAccountPolicy).toBe("send");
    const rejectEnv = loadConfig({
      SELLER_PROFILE_LIKELY_POLICY: "reject",
      SELLER_PROFILE_NEW_ACCOUNT_POLICY: "reject",
    });
    expect(rejectEnv.sellerProfileLikelyPolicy).toBe("reject");
    expect(rejectEnv.sellerProfileNewAccountPolicy).toBe("reject");
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
    db.close();
  });
});
