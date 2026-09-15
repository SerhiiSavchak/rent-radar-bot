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

  it("requires a platform owner signal", () => {
    const result = classifyOwner({
      platformOwner: true,
      text: "від власника",
    });
    expect(result.sellerType).toBe("owner");
    expect(result.filterConsidersPrivateOwner).toBe(true);
  });

  it("classifies agency id as agent even if text claims owner", () => {
    const result = classifyOwner({
      agencyId: 52150,
      text: "від власника",
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
