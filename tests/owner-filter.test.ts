import { describe, expect, it } from "vitest";
import { classifyOwner } from "../src/filters/owner-filter.ts";
import { detectPropertyType } from "../src/filters/listing-filter.ts";

describe("owner classifier", () => {
  it("does not mark owner just because the title contains owner wording", () => {
    const result = classifyOwner({
      text: "Квартира від власника в центрі Львова",
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.filterConsidersPrivateOwner).toBe(false);
    expect(result.sellerEvidence.some((item) => item.includes("owner/no-intermediary"))).toBe(true);
  });

  it("does not treat private-account flags as property ownership", () => {
    const result = classifyOwner({
      platformPrivate: true,
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.filterConsidersPrivateOwner).toBe(false);
  });

  it("requires a platform owner signal", () => {
    const result = classifyOwner({
      platformOwner: true,
      text: "від власника",
    });
    expect(result.sellerType).toBe("owner");
    expect(result.filterConsidersPrivateOwner).toBe(true);
  });

  it("does not promote agency_id alone to agent or owner", () => {
    const result = classifyOwner({
      agencyId: 52150,
      text: "від власника",
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.sellerEvidence.some((item) => item.includes("agency id"))).toBe(true);
  });

  it("keeps platform owner when an agency id is also present", () => {
    const result = classifyOwner({
      platformOwner: true,
      agencyId: 52150,
    });
    expect(result.sellerType).toBe("owner");
  });

  it("classifies explicit platform agent labels as agent", () => {
    const result = classifyOwner({
      platformAgent: true,
      agencyId: 52150,
    });
    expect(result.sellerType).toBe("agent");
  });
});

describe("property type", () => {
  it("maps DIM.RIA realty types", () => {
    expect(detectPropertyType({ realtyTypeId: 2 })).toBe("apartment");
    expect(detectPropertyType({ realtyTypeId: 5 })).toBe("house");
  });
});
