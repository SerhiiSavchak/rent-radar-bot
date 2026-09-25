import { describe, expect, it } from "vitest";
import {
  classifyOlxProfileInventory,
  findOlxPublicProfilePath,
  findOlxSellerShopUrl,
  mergeOlxProfilePages,
  olxProfileCacheState,
  olxProfileEvidence,
  parseOlxProfileInventory,
  propertyKeyFromOlxProfileAd,
  resolveOlxInventoryProbeTarget,
} from "../src/sources/olx/olx-seller-profile.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import { selectDomriaHealthMessage } from "../src/sources/domria/domria.source.ts";
import type { Listing } from "../src/domain/listing.ts";
import { SELLER_PROFILE_DISTINCT_ADDRESS_MIN } from "../src/delivery/seller-profile.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";

function lunLinked(originalUrl: string, sourceId = "4726173400"): Listing {
  return {
    source: "lun",
    sourceId,
    url: `https://lun.ua/uk/realty/${sourceId}`,
    title: "Будинок",
    location: { raw: "Сокільники", city: "Сокільники" },
    propertyType: "house",
    sellerType: "unknown",
    sellerConfidence: "low",
    sellerEvidence: [],
    discoveredAt: new Date("2026-09-25T09:08:00.000Z"),
    publishedAt: new Date("2026-09-25T08:48:44.000Z"),
    metadata: { originalUrl },
  };
}

function withProfileLink(html: string, slug = "xhouse1"): string {
  return html.replace(
    "</body>",
    `<a href="/uk/list/user/${slug}/">усі оголошення</a></body>`,
  );
}

function withShopLink(html: string, shop = "https://localshop.olx.ua/uk/home/"): string {
  return html.replace(
    "</body>",
    `<a href="${shop}" data-testid="user-profile-link">Усі оголошення автора</a></body>`,
  );
}

describe("OLX public profile inventory (distinct properties / addresses)", () => {
  it("reads the profile path and counts distinct addresses, not listing ids", () => {
    expect(findOlxPublicProfilePath('<a href="/uk/list/user/1YzaQC/">усі оголошення</a>')).toBe(
      "/uk/list/user/1YzaQC/",
    );
    const one = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 1,
          totalElements: 2,
          ads: [
            {
              id: 1,
              category: { type: "real_estate" },
              location: { city: { name: "Львів" }, district: { name: "Галицький" } },
            },
            { id: 2, category: { type: "electronics" } },
          ],
        },
      },
    });
    expect(one.realEstateAds).toBe(1);
    expect(one.propertyKeys).toHaveLength(1);
    expect(classifyOlxProfileInventory(one).verdict).toBe("unknown");

    const agent = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 2,
          totalElements: 12,
          ads: [
            {
              id: 10,
              category: { type: "real_estate" },
              location: {
                city: { name: "Львів" },
                district: { name: "Галицький" },
                streetName: "вул. А 10",
              },
            },
            {
              id: 11,
              category: { type: "real_estate" },
              location: {
                city: { name: "Львів" },
                district: { name: "Франківський" },
                streetName: "вул. Б 11",
              },
            },
            {
              id: 12,
              category: { type: "real_estate" },
              location: { city: { name: "Сокільники" }, district: { name: "центр" }, streetName: "вул. В 1" },
            },
          ],
        },
      },
    });
    const page2 = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 2,
          totalElements: 12,
          ads: [
            {
              id: 13,
              category: { type: "real_estate" },
              location: {
                city: { name: "Львів" },
                district: { name: "Сихівський" },
                streetName: "вул. Г 13",
              },
            },
          ],
        },
      },
    });
    const merged = mergeOlxProfilePages(agent, page2);
    expect(merged.precisePropertyKeys?.length).toBeGreaterThanOrEqual(SELLER_PROFILE_DISTINCT_ADDRESS_MIN);
    expect(classifyOlxProfileInventory(merged).verdict).toBe("profile_likely_intermediary");
    expect(classifyOlxProfileInventory(merged).evidence).toContain("olx_precise_addresses=");
    expect(classifyOlxProfileInventory(merged).evidence).toContain("olx_likely=1");
  });

  it("does not treat three listing ids for the same address as three properties", () => {
    const ads = [1, 2, 3].map((id) => ({
      id,
      category: { type: "real_estate" },
      location: {
        city: { name: "Львів" },
        district: { name: "Галицький" },
        streetName: "вул. Однакова 12",
      },
    }));
    const snap = parseOlxProfileInventory({
      userListing: { userListing: { totalPages: 1, totalElements: 3, ads } },
    });
    expect(snap.realEstateAds).toBe(3);
    expect(snap.precisePropertyKeys).toHaveLength(1);
    expect(classifyOlxProfileInventory(snap).verdict).toBe("unknown");
    expect(propertyKeyFromOlxProfileAd(ads[0])?.kind).toBe("precise");
  });

  it("treats three coarse districts as likely locations, not verified addresses", () => {
    const ads = [
      {
        id: 1,
        category: { type: "real_estate" },
        location: { city: { name: "Львів" }, district: { name: "Галицький" } },
      },
      {
        id: 2,
        category: { type: "real_estate" },
        location: { city: { name: "Львів" }, district: { name: "Франківський" } },
      },
      {
        id: 3,
        category: { type: "real_estate" },
        location: { city: { name: "Львів" }, district: { name: "Сихівський" } },
      },
    ];
    const snap = parseOlxProfileInventory({
      userListing: { userListing: { totalPages: 1, totalElements: 3, ads } },
    });
    expect(snap.precisePropertyKeys).toHaveLength(0);
    expect(snap.coarseLocationKeys).toHaveLength(3);
    const decision = classifyOlxProfileInventory(snap);
    expect(decision.verdict).toBe("profile_likely_intermediary");
    expect(decision.evidence).toContain("distinct_coarse_locations=3");
    expect(decision.evidence).toContain("not_verified_property_addresses=1");
    expect(decision.evidence).not.toMatch(/distinct_addresses=3/);
  });

  it("keeps ordinary owners with 1–2 properties / repeated ads sendable", () => {
    const repeated = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 1,
          totalElements: 2,
          ads: [
            {
              id: 1,
              category: { type: "real_estate" },
              location: {
                city: { name: "Львів" },
                district: { name: "Галицький" },
                streetName: "вул. А 1",
              },
            },
            {
              id: 2,
              category: { type: "real_estate" },
              location: {
                city: { name: "Львів" },
                district: { name: "Галицький" },
                streetName: "вул. А 1",
              },
            },
          ],
        },
      },
    });
    expect(repeated.precisePropertyKeys).toHaveLength(1);
    expect(classifyOlxProfileInventory(repeated).verdict).toBe("unknown");
  });

  it("preserves uncertainty when only city-level location exists", () => {
    const snap = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 1,
          totalElements: 5,
          ads: [1, 2, 3, 4, 5].map((id) => ({
            id,
            category: { type: "real_estate" },
            location: { city: { name: "Львів" } },
          })),
        },
      },
    });
    expect(snap.propertyKeys).toHaveLength(0);
    expect(classifyOlxProfileInventory(snap).verdict).toBe("unknown");
  });

  it("keeps one or two distinct addresses sendable and failed reads unknown", () => {
    const two = parseOlxProfileInventory({
      userListing: {
        userListing: {
          totalPages: 1,
          totalElements: 2,
          ads: [
            {
              id: 1,
              category: { type: "real_estate" },
              location: { city: { name: "Львів" }, district: { name: "А" } },
            },
            {
              id: 2,
              category: { type: "real_estate" },
              location: { city: { name: "Львів" }, district: { name: "Б" } },
            },
          ],
        },
      },
    });
    expect(classifyOlxProfileInventory(two).verdict).toBe("unknown");
    expect(classifyOlxProfileInventory({ acquired: false }).verdict).toBe("unknown");
    expect(classifyOlxProfileInventory({ acquired: false }).evidence).toContain("unreadable");
    const checked = new Date("2026-09-25T12:00:00.000Z");
    const likely = olxProfileEvidence(
      {
        acquired: true,
        totalPages: 2,
        totalElements: 5,
        visibleAds: 5,
        realEstateAds: 5,
        propertyKeys: ["львів галицький вул а 1", "львів франківський вул б 2", "сокільники центр вул в 3"],
        precisePropertyKeys: [
          "львів галицький вул а 1",
          "львів франківський вул б 2",
          "сокільники центр вул в 3",
        ],
      },
      checked,
    );
    expect(olxProfileCacheState(likely, new Date(checked.getTime() + 60_000))).toBe("fresh_likely");
  });
});

describe("LUN → exact OLX linked seller + shop as inventory probe", () => {
  it("does not treat a storefront without intermediary evidence as confirmed intermediary", async () => {
    const originalUrl =
      "https://www.olx.ua/d/uk/obyavlenie/orenda-kvartyry-local-shop-ID11shop1.html";
    const html = withShopLink(
      derivedOracleOfferDetailHtml({
        id: 940001,
        url: originalUrl,
        title: "Квартира",
        description: "від власника, без комісії",
        user: { name: "Олена", company_name: null, sellerType: null },
        isBusiness: false,
      }),
      "https://localshop.olx.ua/uk/home/",
    );
    expect(findOlxSellerShopUrl(html)).toBe("https://localshop.olx.ua/uk/home/");
    expect(resolveOlxInventoryProbeTarget(html)).toBe("https://localshop.olx.ua/uk/home/");

    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-25T09:10:00.000Z"),
      timeoutMs: 5_000,
      profileLikelyPolicy: "reject",
      fetchPage: async () => ({ status: 200, finalUrl: originalUrl, bodyText: html }),
      probeProfile: async (input) => {
        expect(input.profilePath).toBe("https://localshop.olx.ua/uk/home/");
        return {
          acquired: true,
          totalPages: 1,
          totalElements: 1,
          visibleAds: 1,
          realEstateAds: 1,
          propertyKeys: ["львів галицький вул тест"],
        };
      },
    });
    const decision = await verify(lunLinked(originalUrl, "shop-ok"));
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("detail_unknown");
    expect(decision.evidence).not.toMatch(/platform OLX seller shop/i);
    expect(decision.evidence).not.toMatch(/confirmed.?intermediary/i);
  });

  it("rejects via profile_likely when shop inventory has 3+ distinct addresses", async () => {
    const originalUrl =
      "https://www.olx.ua/d/uk/obyavlenie/orenda-kmnati-v-budinku-soklniki-okremo-kuhnya-ID11kYHE.html";
    const html = withShopLink(
      derivedOracleOfferDetailHtml({
        id: 935000,
        url: originalUrl,
        title: "Оренда кімнати",
        description: "кімната",
        user: { name: "Валерія", company_name: "XHOUSE", sellerType: null },
        isBusiness: true,
      }),
      "https://xhouse.olx.ua/uk/home/",
    );
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-25T09:10:00.000Z"),
      timeoutMs: 5_000,
      profileLikelyPolicy: "reject",
      fetchPage: async () => ({ status: 200, finalUrl: originalUrl, bodyText: html }),
      probeProfile: async () => ({
        acquired: true,
        totalPages: 2,
        totalElements: 18,
        visibleAds: 18,
        realEstateAds: 15,
        propertyKeys: [
          "львів галицький вул а 1",
          "львів франківський вул б 2",
          "сокільники центр вул в 3",
          "львів сихівський вул г 4",
        ],
        precisePropertyKeys: [
          "львів галицький вул а 1",
          "львів франківський вул б 2",
          "сокільники центр вул в 3",
          "львів сихівський вул г 4",
        ],
      }),
    });
    const decision = await verify(lunLinked(originalUrl));
    expect(decision.outcome).toBe("detail_profile_likely");
    expect(decision.drop).toBe(true);
    expect(decision.evidence).toMatch(/olx_likely=1|distinct_addresses=|olx_precise_addresses=/);
  });

  it("rejects XHOUSE-style unknown detail when /uk/list/user inventory has 3+ addresses", async () => {
    const originalUrl =
      "https://www.olx.ua/d/uk/obyavlenie/orenda-kmnati-v-budinku-soklniki-okremo-kuhnya-ID11kYHE.html";
    const html = withProfileLink(
      derivedOracleOfferDetailHtml({
        id: 935000,
        url: originalUrl,
        title: "Оренда кімнати",
        description: "кімната",
        user: { name: "Евгений", company_name: "XHOUSE", sellerType: null },
        isBusiness: true,
      }),
    );
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-25T09:10:00.000Z"),
      timeoutMs: 5_000,
      profileLikelyPolicy: "reject",
      fetchPage: async () => ({ status: 200, finalUrl: originalUrl, bodyText: html }),
      probeProfile: async () => ({
        acquired: true,
        totalPages: 2,
        totalElements: 18,
        visibleAds: 18,
        realEstateAds: 15,
        propertyKeys: [
          "львів галицький вул а 1",
          "львів франківський вул б 2",
          "сокільники центр вул в 3",
          "львів сихівський вул г 4",
        ],
        precisePropertyKeys: [
          "львів галицький вул а 1",
          "львів франківський вул б 2",
          "сокільники центр вул в 3",
          "львів сихівський вул г 4",
        ],
      }),
    });
    const decision = await verify(lunLinked(originalUrl));
    expect(decision.outcome).toBe("detail_profile_likely");
    expect(decision.drop).toBe(true);
    // Verdict comes from inventory evidence + policy, not the XHOUSE name/storefront alone.
    expect(decision.evidence).toMatch(/olx_likely=1|olx_precise_addresses=/);
    expect(decision.evidence).not.toMatch(/platform OLX seller shop/i);
  });

  it("keeps a private seller with only 1–2 profile listings", async () => {
    const original = "https://www.olx.ua/d/uk/obyavlenie/orenda-kvartyry-ID11priv.html";
    const html = withProfileLink(
      derivedOracleOfferDetailHtml({
        id: 1,
        url: original,
        title: "Квартира",
        description: "від власника",
        user: { name: "Олена", company_name: null, sellerType: null },
        isBusiness: false,
      }),
      "priv1",
    );
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-25T09:10:00.000Z"),
      timeoutMs: 5_000,
      profileLikelyPolicy: "reject",
      fetchPage: async () => ({ status: 200, finalUrl: original, bodyText: html }),
      probeProfile: async () => ({
        acquired: true,
        totalPages: 1,
        totalElements: 2,
        visibleAds: 2,
        realEstateAds: 2,
        propertyKeys: ["львів галицький вул а", "львів франківський вул б"],
      }),
    });
    const decision = await verify(lunLinked(original, "99"));
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("detail_unknown");
  });

  it("treats a blocked profile as UNKNOWN and does not drop", async () => {
    const original = "https://www.olx.ua/d/uk/obyavlenie/orenda-kvartyry-ID11block.html";
    const html = withProfileLink(
      derivedOracleOfferDetailHtml({
        id: 2,
        url: original,
        title: "Квартира",
        description: "текст",
        user: { name: "Ігор", company_name: "XHOUSE", sellerType: null },
        isBusiness: true,
      }),
      "blk",
    );
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-25T09:10:00.000Z"),
      timeoutMs: 5_000,
      profileLikelyPolicy: "reject",
      fetchPage: async () => ({ status: 200, finalUrl: original, bodyText: html }),
      probeProfile: async () => ({ acquired: false }),
    });
    const decision = await verify(lunLinked(original, "100"));
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("detail_unknown");
    expect(decision.evidence).toContain("olx_profile_unreadable");
  });

  it("does not treat reserved OLX platform hosts as seller shops", () => {
    expect(
      findOlxSellerShopUrl('<a href="https://www.olx.ua/uk/home/" data-testid="user-profile-link">x</a>'),
    ).toBeUndefined();
    expect(
      findOlxSellerShopUrl('<a href="https://help.olx.ua/uk/home/" data-testid="seller-link">x</a>'),
    ).toBeUndefined();
    expect(
      findOlxSellerShopUrl(
        '<a href="https://xhouse.olx.ua/uk/home/" data-testid="user-profile-link">Усі оголошення автора</a>',
      ),
    ).toBe("https://xhouse.olx.ua/uk/home/");
  });
});

describe("DIM.RIA health message selection", () => {
  it("surfaces the parser failure instead of the transport slogan", () => {
    const message = selectDomriaHealthMessage([
      "Production DIM.RIA acquisition is public HTML embedded JSON. The official API is not called.",
      "parser_failure: searchEngine items missing",
    ]);
    expect(message).toContain("parser_failure");
    expect(message).not.toContain("official API is not called");
  });
});
