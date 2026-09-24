import { describe, expect, it } from "vitest";
import { classifyOwner, isSellerEligible, sellerRejectionReason } from "../src/filters/owner-filter.ts";
import { classifySellerIdentityName, classifySellerText } from "../src/utils/text-evidence.ts";
import {
  canonicalOlxDetailTarget,
  classifyOlxLinkedSellerHtml,
  createCycleOlxSellerVerifier,
} from "../src/delivery/olx-detail-seller.ts";
import type { Listing } from "../src/domain/listing.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";

describe("seller identity name context", () => {
  it("treats clear agency brands as strong in name context", () => {
    for (const name of [
      "West Realty",
      "ABC Agency",
      "АН Золотий Дім",
      "Ксенія АН",
      "Рієлтор Олена",
      "Property Broker",
      "Lviv City Estate",
      "Агенція Дім",
    ]) {
      expect(classifySellerIdentityName(name).level, name).toBe("confirmed");
    }
  });

  it("does not invent intermediary from ordinary personal names", () => {
    expect(classifySellerIdentityName("Олена").level).toBe("unknown");
    expect(classifySellerIdentityName("John Smith").level).toBe("unknown");
  });

  it("keeps Realty supporting-only in free listing text unless strong patterns match", () => {
    const text = classifySellerText("Nice flat near Realty street market");
    expect(text.level).not.toBe("confirmed");
  });

  it("rejects OLX company/profile agency brand under reject_intermediaries", () => {
    const owner = classifyOwner({
      sellerIdentityName: "West Realty",
      agencyName: "West Realty",
      text: "Здам квартиру без посередників",
    });
    expect(["intermediary", "conflict"]).toContain(owner.ownerEvidenceLevel);
    expect(
      isSellerEligible({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      }),
    ).toBe(false);
  });

  it("does not reject ordinary personal company name alone", () => {
    const owner = classifyOwner({
      agencyName: "Олена",
      sellerIdentityName: "Олена",
      text: "Здам квартиру",
    });
    expect(owner.ownerEvidenceLevel).not.toBe("intermediary");
    expect(
      isSellerEligible({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      }),
    ).toBe(true);
  });

  it("aggregator LUN isOwner yields to exact agency brand on same listing", () => {
    const owner = classifyOwner({
      platformOwner: true,
      aggregatorOwner: true,
      agencyName: "West Realty",
      sellerIdentityName: "West Realty",
    });
    expect(owner.ownerEvidenceLevel).toBe("conflict");
    expect(
      sellerRejectionReason({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      }),
    ).toBeTruthy();
  });

  it("true platform-confirmed owner still overrides text intermediary", () => {
    const owner = classifyOwner({
      platformOwner: true,
      text: "агентство нерухомості пропонує",
    });
    expect(owner.ownerEvidenceLevel).toBe("platform_confirmed");
    expect(owner.sellerType).toBe("owner");
  });

  it("isBusiness alone stays unknown/sendable", () => {
    const owner = classifyOwner({ isBusiness: true, text: "Здам квартиру" });
    expect(owner.ownerEvidenceLevel).toBe("private_unknown");
    expect(
      isSellerEligible({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      }),
    ).toBe(true);
  });
});

describe("LUN→OLX exact linked seller verification", () => {
  it("canonicalizes OLX listing URLs by token", () => {
    const target = canonicalOlxDetailTarget(
      "https://www.olx.ua/d/uk/obyavlenie/orenda-kvartyry-ID11gWHG.html?foo=1",
    );
    expect(target?.token).toBe("11gWHG");
    expect(target?.url).toContain("ID11gWHG");
  });

  it("classifies linked HTML with Realty company as intermediary", () => {
    const html = derivedOracleOfferDetailHtml({
      id: 42,
      url: "https://www.olx.ua/d/obyavlenie/orenda-ID11gWHG.html",
      title: "Квартира",
      description: "Здам",
      user: { name: "West Realty", company_name: "West Realty", sellerType: null },
      isBusiness: true,
    });
    const classified = classifyOlxLinkedSellerHtml(html, "11gWHG");
    expect(classified.verdict).toBe("confirmed_intermediary");
  });

  it("drops LUN when same-cycle OLX peer is intermediary", async () => {
    const lun: Listing = {
      source: "lun",
      sourceId: "1",
      url: "https://lun.ua/uk/realty/1",
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "owner",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: {
        ownerEvidenceLevel: "platform_confirmed",
        originalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID11gWHG.html",
      },
    };
    const olx: Listing = {
      source: "olx",
      sourceId: "42",
      url: "https://www.olx.ua/d/obyavlenie/orenda-ID11gWHG.html",
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "unknown",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: {
        ownerEvidenceLevel: "intermediary",
        urlToken: "11gWHG",
      },
    };
    const verify = createCycleOlxSellerVerifier({
      peers: [lun, olx],
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      timeoutMs: 1000,
      fetchPage: async () => {
        throw new Error("should not fetch when same-cycle peer exists");
      },
    });
    const decision = await verify(lun);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("same_cycle_confirmed_agent");
  });

  it("drops LUN from detail HTML when company is West Realty", async () => {
    const lun: Listing = {
      source: "lun",
      sourceId: "2",
      url: "https://lun.ua/uk/realty/2",
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "owner",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: {
        ownerEvidenceLevel: "platform_confirmed",
        originalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID22xYZA.html",
      },
    };
    const body = derivedOracleOfferDetailHtml({
      id: 99,
      url: "https://www.olx.ua/d/obyavlenie/orenda-ID22xYZA.html",
      title: "Квартира",
      description: "Здам",
      user: { name: "West Realty", company_name: "West Realty", sellerType: null },
      isBusiness: false,
    });
    const verify = createCycleOlxSellerVerifier({
      peers: [lun],
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      timeoutMs: 1000,
      fetchPage: async () => ({
        status: 200,
        finalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID22xYZA.html",
        bodyText: body,
      }),
    });
    const decision = await verify(lun);
    expect(decision.requested).toBe(true);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_confirmed_agent");
  });

  it("keeps LUN sendable when linked OLX has ordinary personal name only", async () => {
    const lun: Listing = {
      source: "lun",
      sourceId: "3",
      url: "https://lun.ua/uk/realty/3",
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "owner",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: {
        ownerEvidenceLevel: "platform_confirmed",
        originalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID33pQRS.html",
      },
    };
    const body = derivedOracleOfferDetailHtml({
      id: 100,
      url: "https://www.olx.ua/d/obyavlenie/orenda-ID33pQRS.html",
      title: "Квартира",
      description: "Здам",
      user: { name: "Олена", company_name: null, sellerType: null },
      isBusiness: false,
    });
    const verify = createCycleOlxSellerVerifier({
      peers: [lun],
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      timeoutMs: 1000,
      fetchPage: async () => ({
        status: 200,
        finalUrl: "https://www.olx.ua/d/uk/obyavlenie/orenda-ID33pQRS.html",
        bodyText: body,
      }),
    });
    const decision = await verify(lun);
    expect(decision.drop).toBe(false);
    expect(["detail_unknown", "detail_confirmed_owner"]).toContain(decision.outcome);
  });
});
