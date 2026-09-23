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
  rememberOlxProfileProbe,
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

  it("does not treat two addresses as a likely intermediary", () => {
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
    expect(decision.verdict).toBe("unknown");
    expect(decision.verdict).not.toBe("profile_likely_intermediary");
    const gated = applySellerProfileGate(listings, undefined, now);
    expect(gated.dropped).toBe(0);
    expect(gated.profileRejected).toBe(0);
    expect(gated.profileLikelyIntermediary).toBe(0);
    expect(gated.kept).toHaveLength(2);
  });

  it("rejects three DIM.RIA addresses by default and still sends them when likely policy is send", () => {
    const listings = [
      card({
        source: "domria",
        sourceId: "a",
        url: "https://dom.ria.com/uk/realty-a.html",
        location: { raw: "Львів, вул. Зелена, 1" },
        metadata: { userId: "same" },
      }),
      card({
        source: "domria",
        sourceId: "b",
        url: "https://dom.ria.com/uk/realty-b.html",
        location: { raw: "Львів, вул. Городоцька, 20" },
        metadata: { userId: "same" },
      }),
      card({
        source: "domria",
        sourceId: "c",
        url: "https://dom.ria.com/uk/realty-c.html",
        location: { raw: "Львів, вул. Третя, 3" },
        metadata: { userId: "same" },
      }),
    ];
    const decision = assessSellerProfile({
      confirmedOwner: false,
      addresses: ["a", "b", "c"],
      now,
    });
    expect(decision.verdict).toBe("profile_likely_intermediary");
    expect(shouldRejectSellerProfile(decision.verdict, DEFAULT_SELLER_PROFILE_POLICIES)).toBe(true);
    const gated = applySellerProfileGate(listings, undefined, now);
    expect(gated.profileLikelyIntermediary).toBe(3);
    expect(gated.dropped).toBe(3);
    expect(gated.profileRejected).toBe(3);
    expect(gated.kept).toHaveLength(0);
    const sent = applySellerProfileGate(listings, undefined, now, {
      likelyPolicy: "send",
      newAccountPolicy: "reject",
    });
    expect(sent.profileLikelyIntermediary).toBe(3);
    expect(sent.profileRejected).toBe(0);
    expect(sent.dropped).toBe(0);
    expect(sent.kept).toHaveLength(3);
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
    expect(again.profileLikelyIntermediary).toBe(0);
    expect(again.dropped).toBe(0);
    expect(again.kept.map((item) => item.sourceId).sort()).toEqual(["2", "3"]);
    const stillSent = applySellerProfileGate(
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
    );
    expect(stillSent.profileLikelyIntermediary).toBe(0);
    expect(stillSent.profileRejected).toBe(0);
    expect(stillSent.dropped).toBe(0);
    expect(stillSent.kept).toHaveLength(1);
    reopened.close();
  });

  it("keeps a platform-confirmed owner with three addresses under the reject policy", () => {
    const db = openDb();
    const owner = (id: string, street: string): Listing =>
      card({
        source: "domria",
        sourceId: id,
        url: `https://dom.ria.com/uk/realty-${id}.html`,
        sellerType: "owner",
        metadata: { userId: "owner", ownerEvidenceLevel: "platform_confirmed" },
        location: { raw: street },
      });
    applySellerProfileGate([owner("1", "Львів, вул. Перша, 1"), owner("2", "Львів, вул. Друга, 2")], db, now);
    const third = applySellerProfileGate([owner("3", "Львів, вул. Третя, 3")], db, now);
    expect(third.dropped).toBe(0);
    expect(third.profileRejected).toBe(0);
    expect(third.profileLikelyIntermediary).toBe(0);
    expect(third.kept).toHaveLength(1);
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

  it("rejects a young account by default and sends it when new-account policy is send", () => {
    const fresh = card({
      source: "olx",
      sourceId: "new",
      url: "https://www.olx.ua/d/uk/obyavlenie/new",
      metadata: { olxUserId: "new-user", accountCreatedAt: "2026-09-22T08:00:00.000Z" },
    });
    const undated = card({
      source: "olx",
      sourceId: "undated",
      url: "https://www.olx.ua/d/uk/obyavlenie/undated",
      metadata: { olxUserId: "undated-user" },
    });
    const decision = assessSellerProfile({
      confirmedOwner: false,
      addresses: ["one"],
      accountCreatedAt: new Date("2026-09-22T08:00:00.000Z"),
      now,
    });
    expect(decision.verdict).toBe("profile_high_risk");
    expect(shouldRejectSellerProfile(decision.verdict)).toBe(true);
    const missingDate = assessSellerProfile({
      confirmedOwner: false,
      addresses: ["one"],
      now,
    });
    expect(missingDate.verdict).toBe("unknown");
    const gated = applySellerProfileGate([fresh], undefined, now);
    expect(gated.profileHighRisk).toBe(1);
    expect(gated.profileRejected).toBe(1);
    expect(gated.dropped).toBe(1);
    const kept = applySellerProfileGate([fresh], undefined, now, {
      likelyPolicy: "reject",
      newAccountPolicy: "send",
    });
    expect(kept.profileHighRisk).toBe(1);
    expect(kept.profileRejected).toBe(0);
    expect(kept.dropped).toBe(0);
    const noAge = applySellerProfileGate([undated], undefined, now);
    expect(noAge.profileHighRisk).toBe(0);
    expect(noAge.dropped).toBe(0);
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

  it("forgets expired cache rows and defaults both profile policies to reject", () => {
    const defaults = loadConfig({});
    expect(defaults.sellerProfileLikelyPolicy).toBe("reject");
    expect(defaults.sellerProfileNewAccountPolicy).toBe("reject");
    const sendEnv = loadConfig({
      SELLER_PROFILE_LIKELY_POLICY: "send",
      SELLER_PROFILE_NEW_ACCOUNT_POLICY: "send",
    });
    expect(sendEnv.sellerProfileLikelyPolicy).toBe("send");
    expect(sendEnv.sellerProfileNewAccountPolicy).toBe("send");
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

  it("sends the observed one-page OLX inventory and rejects a second real-estate page", () => {
    const db = openDb();
    const small = rememberOlxProfileProbe(
      db,
      "nadia",
      { acquired: true, totalPages: 1, totalElements: 6, realEstateOnPage: true },
      now,
    );
    expect(small.verdict).toBe("unknown");
    const sent = applySellerProfileGate(
      ["Зелена, 1", "Пасічна, 2", "Шевченка, 3", "Франка, 4", "Городоцька, 5", "Личаківська, 6"].map(
        (street, index) =>
          card({
            source: "olx",
            sourceId: `n-${index}`,
            url: `https://www.olx.ua/d/uk/obyavlenie/n-${index}`,
            location: { raw: `Львів, ${street}` },
            metadata: { olxUserId: "nadia" },
          }),
      ),
      db,
      now,
    );
    expect(sent.dropped).toBe(0);
    expect(sent.kept).toHaveLength(6);

    const large = rememberOlxProfileProbe(
      db,
      "tkachuk",
      { acquired: true, totalPages: 2, totalElements: 13, realEstateOnPage: true },
      now,
    );
    expect(large.verdict).toBe("profile_likely_intermediary");
    const rejected = applySellerProfileGate(
      [
        card({
          source: "olx",
          sourceId: "t-1",
          url: "https://www.olx.ua/d/uk/obyavlenie/t-1",
          metadata: { olxUserId: "tkachuk" },
        }),
      ],
      db,
      now,
    );
    expect(rejected.dropped).toBe(1);
    expect(rejected.profileRejected).toBe(1);

    const failed = rememberOlxProfileProbe(db, "offline", { acquired: false }, now);
    expect(failed.verdict).toBe("unknown");
    expect(failed.evidence).toContain("olx_unreadable=1");
    const kept = applySellerProfileGate(
      [
        card({
          source: "olx",
          sourceId: "off",
          url: "https://www.olx.ua/d/uk/obyavlenie/off",
          location: { raw: "Львів, вул. Зелена, 1" },
          metadata: { olxUserId: "offline" },
        }),
        card({
          source: "olx",
          sourceId: "off-2",
          url: "https://www.olx.ua/d/uk/obyavlenie/off-2",
          location: { raw: "Львів, вул. Городоцька, 2" },
          metadata: { olxUserId: "offline" },
        }),
        card({
          source: "olx",
          sourceId: "off-3",
          url: "https://www.olx.ua/d/uk/obyavlenie/off-3",
          location: { raw: "Львів, вул. Франка, 3" },
          metadata: { olxUserId: "offline" },
        }),
      ],
      db,
      now,
    );
    expect(kept.dropped).toBe(0);
    db.close();
  });
});
