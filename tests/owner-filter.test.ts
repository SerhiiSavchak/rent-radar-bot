import { describe, expect, it } from "vitest";
import { classifyOwner, isOwnerEligible } from "../src/filters/owner-filter.ts";
import { detectPropertyType } from "../src/filters/listing-filter.ts";

describe("owner classifier", () => {
  it("does not mark owner just because the title contains owner wording", () => {
    const result = classifyOwner({
      text: "Квартира від власника в центрі Львова",
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.filterConsidersPrivateOwner).toBe(false);
    expect(result.filterConsidersSelfDeclaredOwner).toBe(false);
    expect(result.ownerEvidenceLevel).toBe("private_unknown");
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
});

describe("property type", () => {
  it("maps DIM.RIA realty types", () => {
    expect(detectPropertyType({ realtyTypeId: 2 })).toBe("apartment");
    expect(detectPropertyType({ realtyTypeId: 5 })).toBe("house");
  });
});
