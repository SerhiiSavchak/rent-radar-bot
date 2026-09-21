import { describe, expect, it } from "vitest";
import { classifyOwner, isOwnerEligible, isSellerEligible } from "../src/filters/owner-filter.ts";
import { detectPropertyType } from "../src/filters/listing-filter.ts";
import { hasExplicitIntermediaryText } from "../src/utils/text-evidence.ts";

describe("owner classifier", () => {
  it("does not mark owner just because the title contains owner wording", () => {
    const result = classifyOwner({
      text: "Квартира від власника в центрі Львова",
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.filterConsidersPrivateOwner).toBe(false);
    expect(result.filterConsidersSelfDeclaredOwner).toBe(true);
    expect(result.ownerEvidenceLevel).toBe("self_declared");
    expect(isSellerEligible({
      sellerType: result.sellerType,
      metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
    })).toBe(true);
  });

  it("does not treat private-account flags as property ownership", () => {
    const result = classifyOwner({
      platformPrivate: true,
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.filterConsidersPrivateOwner).toBe(false);
    expect(result.ownerEvidenceLevel).toBe("private_unknown");
    expect(isOwnerEligible({ sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } })).toBe(
      false,
    );
    expect(isSellerEligible({ sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } })).toBe(
      true,
    );
  });

  it("requires a platform owner signal for sellerType=owner", () => {
    const result = classifyOwner({
      platformOwner: true,
      text: "від власника",
    });
    expect(result.sellerType).toBe("owner");
    expect(result.filterConsidersPrivateOwner).toBe(true);
    expect(result.ownerEvidenceLevel).toBe("platform_confirmed");
  });

  it("records a clean private self-declaration without opening the default owner gate", () => {
    const result = classifyOwner({
      platformPrivate: true,
      text: "Здається в оренду будинок від власника.",
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.ownerEvidenceLevel).toBe("self_declared");
    expect(result.filterConsidersPrivateOwner).toBe(false);
    expect(result.filterConsidersSelfDeclaredOwner).toBe(true);
    const listing = {
      sellerType: result.sellerType,
      metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
    };
    expect(isOwnerEligible(listing)).toBe(false);
    expect(isOwnerEligible(listing, { acceptSelfDeclared: true })).toBe(true);
    expect(isSellerEligible(listing)).toBe(true);
  });

  it("treats business + owner phrasing as conflict, not ownership", () => {
    const result = classifyOwner({
      platformBusiness: true,
      isBusiness: true,
      agencyName: "Lviv City Estate",
      text: "Оренда квартири від власника, агентство супроводжує",
    });
    expect(result.sellerType).toBe("business");
    expect(result.ownerEvidenceLevel).toBe("conflict");
    expect(result.filterConsidersSelfDeclaredOwner).toBe(false);
  });

  it("keeps business + без комісії as intermediary rather than conflict", () => {
    const result = classifyOwner({
      platformBusiness: true,
      isBusiness: true,
      text: "Без комісії! Оренда 1кімнатної квартири в новобудові",
    });
    expect(result.sellerType).toBe("business");
    expect(result.ownerEvidenceLevel).toBe("intermediary");
    expect(result.filterConsidersSelfDeclaredOwner).toBe(false);
  });

  it("does not treat owner-seeking copy as a self-declaration", () => {
    for (const text of [
      "Looking for an owner, owners contact us",
      "Шукаємо власника цієї квартири",
      "Owners, contact us for a deal",
    ]) {
      const result = classifyOwner({
        platformPrivate: true,
        text,
      });
      expect(result.ownerEvidenceLevel).toBe("private_unknown");
      expect(result.filterConsidersSelfDeclaredOwner).toBe(false);
      expect(result.sellerEvidence.some((item) => item.includes("seeks an owner"))).toBe(true);
    }
  });

  it("does not treat без комісії or приватний будинок as self-declared ownership", () => {
    const commission = classifyOwner({
      platformPrivate: true,
      withoutCommission: true,
      text: "Оренда 2x кімнатної квартири. Без комісії.",
    });
    expect(commission.ownerEvidenceLevel).toBe("private_unknown");
    expect(commission.filterConsidersSelfDeclaredOwner).toBe(false);

    const house = classifyOwner({
      platformPrivate: true,
      text: "Оренда приватного будинку на закритій території",
    });
    expect(house.ownerEvidenceLevel).toBe("private_unknown");
  });

  it("does not promote agency_id alone to agent or owner", () => {
    const result = classifyOwner({
      agencyId: 52150,
      text: "від власника",
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.ownerEvidenceLevel).toBe("conflict");
    expect(result.filterConsidersPrivateOwner).toBe(false);
    expect(result.filterConsidersSelfDeclaredOwner).toBe(false);
    expect(result.sellerEvidence.some((item) => item.includes("agency id"))).toBe(true);
  });

  it("treats a private account with an agency id and owner phrasing as conflict", () => {
    const result = classifyOwner({
      platformPrivate: true,
      agencyId: 52150,
      text: "Здається в оренду будинок від власника.",
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.ownerEvidenceLevel).toBe("conflict");
    expect(result.filterConsidersSelfDeclaredOwner).toBe(false);
    expect(isOwnerEligible(
      { sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } },
      { acceptSelfDeclared: true },
    )).toBe(false);
    expect(isSellerEligible(
      { sellerType: result.sellerType, metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel } },
    )).toBe(false);
  });

  it("does not treat «від власника» plus owner-seeking copy as a self-declaration", () => {
    const result = classifyOwner({
      platformPrivate: true,
      text: "Від власника? Looking for an owner, owners contact us",
    });
    expect(result.ownerEvidenceLevel).toBe("private_unknown");
    expect(result.filterConsidersSelfDeclaredOwner).toBe(false);
  });

  it("keeps platform owner when an agency id is also present", () => {
    const result = classifyOwner({
      platformOwner: true,
      agencyId: 52150,
    });
    expect(result.sellerType).toBe("owner");
    expect(result.ownerEvidenceLevel).toBe("platform_confirmed");
  });

  it("classifies explicit platform agent labels as agent", () => {
    const result = classifyOwner({
      platformAgent: true,
      agencyId: 52150,
    });
    expect(result.sellerType).toBe("agent");
    expect(result.ownerEvidenceLevel).toBe("intermediary");
  });

  it("does not treat a generic business account flag as agency proof", () => {
    const result = classifyOwner({
      isBusiness: true,
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.ownerEvidenceLevel).toBe("private_unknown");
    expect(isSellerEligible({
      sellerType: result.sellerType,
      metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
    })).toBe(true);
  });

  it("allows a self-declaration without the legacy OWNER_ACCEPT_SELF_DECLARED opt-in", () => {
    const result = classifyOwner({
      text: "Здається від власника, без посередників",
    });
    expect(result.ownerEvidenceLevel).toBe("self_declared");
    expect(result.sellerType).toBe("unknown");
    expect(isSellerEligible({
      sellerType: result.sellerType,
      metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
    })).toBe(true);
  });

  it("lets explicit intermediary evidence override an owner claim", () => {
    const result = classifyOwner({
      platformAgent: true,
      text: "від власника, без комісії",
    });
    expect(result.ownerEvidenceLevel).toBe("conflict");
    expect(isSellerEligible({
      sellerType: result.sellerType,
      metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
    })).toBe(false);
  });

  it("rejects unambiguous realtor/agency copy and keeps negative phrases", () => {
    expect(hasExplicitIntermediaryText("Я рієлтор, допоможу з орендою")).toBe(true);
    expect(hasExplicitIntermediaryText("Агентство нерухомості Львів")).toBe(true);
    expect(hasExplicitIntermediaryText("Комісія агентства 50%")).toBe(true);
    expect(hasExplicitIntermediaryText("Без комісії")).toBe(false);
    expect(hasExplicitIntermediaryText("Без рієлтора")).toBe(false);
    expect(hasExplicitIntermediaryText("Агентствам не турбувати")).toBe(false);
    expect(hasExplicitIntermediaryText("Рієлторам не телефонувати")).toBe(false);
    expect(hasExplicitIntermediaryText("Приватний будинок біля парку")).toBe(false);
    expect(hasExplicitIntermediaryText("Готовий співпрацювати з ріелторами")).toBe(false);

    for (const text of ["Без комісії", "Без рієлтора", "Агентствам не турбувати", "Рієлторам не телефонувати"]) {
      const result = classifyOwner({ text, platformPrivate: true });
      expect(result.ownerEvidenceLevel).toBe("private_unknown");
      expect(isSellerEligible({
        sellerType: result.sellerType,
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      })).toBe(true);
    }
  });
});

describe("property type", () => {
  it("maps DIM.RIA realty types", () => {
    expect(detectPropertyType({ realtyTypeId: 2 })).toBe("apartment");
    expect(detectPropertyType({ realtyTypeId: 5 })).toBe("house");
  });
});
