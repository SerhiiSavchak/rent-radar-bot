import { describe, expect, it } from "vitest";
import { applySellerProfileGate, assessSellerProfile, shouldRejectSellerProfile } from "../src/delivery/seller-profile.ts";
import { classifyOwner, isSellerEligible } from "../src/filters/owner-filter.ts";
import {
  extractOlxAccountRegistrationYear,
  sellerRegistrationYearRejectionReason,
} from "../src/sources/olx/olx-account-registration.ts";
import {
  classifyOlxProfileInventory,
  extractOlxSellerAboutText,
  parseOlxProfileInventory,
} from "../src/sources/olx/olx-seller-profile.ts";
import { classifySellerText } from "../src/utils/text-evidence.ts";
import type { Listing } from "../src/domain/listing.ts";

function preciseAd(id: number, city: string, street: string, offer?: "rent" | "sale"): unknown {
  return {
    id,
    category: { type: "real_estate", offer },
    location: { city: { name: city }, district: { name: "центр" }, streetName: street },
  };
}

function coarseAd(id: number, city: string, district: string): unknown {
  return {
    id,
    category: { type: "real_estate" },
    location: { city: { name: city }, district: { name: district } },
  };
}

function inventory(ads: unknown[]) {
  return parseOlxProfileInventory({
    userListing: { userListing: { totalPages: 1, totalElements: ads.length, ads } },
  });
}

function card(id: string, street: string): Listing {
  return {
    source: "olx",
    sourceId: id,
    url: `https://www.olx.ua/d/uk/obyavlenie/${id}`,
    title: "Квартира",
    location: { raw: street, city: "Львів" },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: new Date("2026-09-23T08:00:00.000Z"),
    metadata: { olxUserId: "same-seller" },
  };
}

describe("seller inventory threshold", () => {
  it("does not hard-reject 3 or 4 precise properties, or 3 coarse locations", () => {
    const threePrecise = inventory([
      preciseAd(1, "Львів", "вул. А 1"),
      preciseAd(2, "Київ", "вул. Б 2"),
      preciseAd(3, "Одеса", "вул. В 3"),
    ]);
    const fourPrecise = inventory([
      ...[preciseAd(1, "Львів", "вул. А 1"), preciseAd(2, "Київ", "вул. Б 2"), preciseAd(3, "Одеса", "вул. В 3")],
      preciseAd(4, "Харків", "вул. Г 4"),
    ]);
    const threeCoarse = inventory([
      coarseAd(1, "Львів", "Галицький"),
      coarseAd(2, "Львів", "Сихівський"),
      coarseAd(3, "Львів", "Франківський"),
    ]);
    for (const snap of [threePrecise, fourPrecise, threeCoarse]) {
      const decision = classifyOlxProfileInventory(snap);
      expect(decision.verdict).toBe("unknown");
      expect(decision.verdict).not.toBe("profile_likely_intermediary");
      expect(decision.verdict).not.toBe("seller_inventory_limit");
      expect(shouldRejectSellerProfile(decision.verdict)).toBe(false);
    }
    expect(threeCoarse.precisePropertyKeys).toHaveLength(0);
    expect(threeCoarse.coarseLocationKeys).toHaveLength(3);
    const gated = applySellerProfileGate(
      [card("a", "Львів, вул. Зелена, 1"), card("b", "Львів, вул. Городоцька, 20"), card("c", "Львів, вул. Третя, 3")],
      undefined,
      new Date("2026-09-23T08:00:00.000Z"),
    );
    expect(assessSellerProfile({
      confirmedOwner: false,
      addresses: ["a", "b", "c"],
      now: new Date("2026-09-23T08:00:00.000Z"),
    }).verdict).toBe("unknown");
    expect(gated.dropped).toBe(0);
    expect(gated.kept).toHaveLength(3);
  });

  it("hard-rejects 5 distinct precise properties and ignores duplicates and non-real-estate", () => {
    const mixed = inventory([
      preciseAd(1, "Львів", "вул. Одна 10", "rent"),
      preciseAd(2, "Львів", "вул. Одна 10", "sale"),
      preciseAd(3, "Київ", "вул. Дві 2", "sale"),
      preciseAd(4, "Одеса", "вул. Три 3", "rent"),
      preciseAd(5, "Харків", "вул. Чотири 4", "rent"),
      preciseAd(6, "Дніпро", "вул. П'ять 5", "sale"),
      { id: 7, category: { type: "electronics" }, title: "телефон", location: { cityName: "Львів" } },
      coarseAd(8, "Львів", "Сихівський"),
    ]);
    expect(mixed.precisePropertyKeys).toHaveLength(5);
    const decision = classifyOlxProfileInventory(mixed);
    expect(decision.verdict).toBe("seller_inventory_limit");
    expect(decision.evidence).toContain("seller_inventory_limit");
    expect(shouldRejectSellerProfile(decision.verdict)).toBe(true);
  });
});

describe("seller text families and false positives", () => {
  it("rejects explicit realtor identity across UA/RU/EN", () => {
    for (const text of [
      "Я рієлтор, допоможу з орендою",
      "риэлтор по недвижимости",
      "real estate agency West",
      "пропозиція від АН",
      "предложение от АН",
      "I am a rieltor",
      "real-estate agent",
      "real estate consultant",
    ]) {
      expect(classifySellerText(text).level, text).toBe("confirmed");
      const classified = classifyOwner({ text, platformPrivate: true });
      expect(classified.ownerEvidenceLevel, text).toBe("intermediary");
      expect(
        isSellerEligible({
          sellerType: classified.sellerType,
          metadata: { ownerEvidenceLevel: classified.ownerEvidenceLevel },
        }),
        text,
      ).toBe(false);
    }
  });

  it("does not reject negated realtor copy or generic words outside that context", () => {
    for (const text of [
      "я не рієлтор",
      "я не риелтор",
      "рієлторам не дзвонити",
      "риелторам не звонить",
      "без ріелторів",
      "без риелторов",
      "без посередників",
      "без посредников",
      "без комісії",
      "без комиссии",
      "агентам не турбувати",
      "не агентство",
      "не АН",
      "не співпрацюю з АН",
      "Іван шукає вариант",
      "пані з банку",
      "стан квартири і дані лічильника",
      "private house",
      "business class apartment",
      "bank commission",
      "комісія банку",
      "OLX commission",
      "our manager is an expert in services",
    ]) {
      const judged = classifySellerText(text);
      expect(judged.level, text).not.toBe("confirmed");
      const classified = classifyOwner({ text, platformPrivate: true });
      expect(classified.ownerEvidenceLevel, text).not.toBe("intermediary");
      expect(classified.sellerType, text).not.toBe("owner");
    }
  });

  it("counts several hits inside one family as a single family", () => {
    const judged = classifySellerText("є інші варіанти. маю інші варіанти. база об'єктів. інші об'єкти");
    expect(judged.supportingFamilies).toEqual(["inventory"]);
    expect(judged.level).toBe("unknown");
  });
});

describe("registration year, OLX account type, and conflict", () => {
  it("rejects only a trusted member-since year of 2026", () => {
    expect(sellerRegistrationYearRejectionReason(2026)).toBe("seller_registration_year_2026");
    expect(sellerRegistrationYearRejectionReason(2025)).toBeUndefined();
    expect(sellerRegistrationYearRejectionReason(2027)).toBeUndefined();
    expect(sellerRegistrationYearRejectionReason(undefined)).toBeUndefined();
    const description = `<html><body><p>Здаю квартиру, на OLX з 2026 року.</p></body></html>`;
    expect(extractOlxAccountRegistrationYear(description)).toBeUndefined();
    expect(
      sellerRegistrationYearRejectionReason(extractOlxAccountRegistrationYear(description)),
    ).toBeUndefined();
    const trusted = `<p data-testid="member-since">на OLX з <span>січень 2026 р.</span></p>`;
    expect(extractOlxAccountRegistrationYear(trusted)).toBe(2026);
  });

  it("treats OLX Private as not-owner and OLX Business as a reject", () => {
    const priv = classifyOwner({ platformPrivate: true, text: "Оренда квартири" });
    expect(priv.sellerType).not.toBe("owner");
    expect(priv.ownerEvidenceLevel).toBe("private_unknown");
    expect(
      isSellerEligible({
        sellerType: priv.sellerType,
        metadata: { ownerEvidenceLevel: priv.ownerEvidenceLevel },
      }),
    ).toBe(true);
    const business = classifyOwner({ isBusiness: true, platformPrivate: false });
    expect(business.sellerType).toBe("business");
    expect(business.ownerEvidenceLevel).toBe("intermediary");
    expect(
      isSellerEligible({
        sellerType: business.sellerType,
        metadata: { ownerEvidenceLevel: business.ownerEvidenceLevel },
      }),
    ).toBe(false);
  });

  it("does not read a seller bio from the rest of a profile document", () => {
    const html = `<html><body><h1>Про автора</h1><p>я рієлтор, на OLX з 2026</p></body></html>`;
    expect(extractOlxSellerAboutText(html)).toBeUndefined();
  });

  it("fail-closes when a platform owner also has explicit intermediary evidence", () => {
    const conflict = classifyOwner({ platformOwner: true, text: "я рієлтор" });
    expect(conflict.ownerEvidenceLevel).toBe("conflict");
    expect(conflict.sellerType).not.toBe("owner");
    expect(
      isSellerEligible({
        sellerType: conflict.sellerType,
        metadata: { ownerEvidenceLevel: conflict.ownerEvidenceLevel },
      }),
    ).toBe(false);
  });
});
