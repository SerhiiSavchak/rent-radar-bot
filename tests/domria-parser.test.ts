import { describe, expect, it } from "vitest";
import { parseDomriaInfo } from "../src/sources/domria/domria.parser.ts";

describe("DIM.RIA parser", () => {
  it("uses characteristic 1436 as owner evidence", () => {
    const listing = parseDomriaInfo({
      realty_id: 34690408,
      beautiful_url: "realty-dolgosrochnaya-arenda-kvartira-lvov-test-34690408.html",
      city_name_uk: "Львів",
      street_name_uk: "вул. Тестова",
      latitude: 49.837,
      longitude: 24.008,
      price: 12000,
      currency_type: "грн",
      publishing_date: "2026-09-12 15:58:26",
      realty_type_id: 2,
      agency_id: 0,
      characteristics_values: { "1437": 1436 },
      description_uk: "Квартира",
    });
    expect(listing?.sellerType).toBe("owner");
    expect(listing?.propertyType).toBe("apartment");
    expect(listing?.location.latitude).toBeCloseTo(49.837);
  });

  it("marks characteristic 1434 as agent", () => {
    const listing = parseDomriaInfo({
      realty_id: 1,
      beautiful_url: "realty-1.html",
      city_name_uk: "Львів",
      agency_id: 0,
      characteristics_values: { "1437": 1434 },
      realty_type_id: 2,
    });
    expect(listing?.sellerType).toBe("agent");
  });

  it("does not treat agency_id as ownership proof", () => {
    const listing = parseDomriaInfo({
      realty_id: 2,
      beautiful_url: "realty-2.html",
      city_name_uk: "Львів",
      agency_id: 52150,
      realty_type_id: 2,
    });
    expect(listing?.sellerType).toBe("unknown");
    expect(listing?.sellerEvidence?.some((item) => item.includes("agency_id=52150"))).toBe(true);
  });

  it("keeps unrecognized characteristic 1437 as unknown", () => {
    const listing = parseDomriaInfo({
      realty_id: 3,
      beautiful_url: "realty-3.html",
      city_name_uk: "Львів",
      agency_id: 0,
      characteristics_values: { "1437": 9999 },
      realty_type_id: 2,
    });
    expect(listing?.sellerType).toBe("unknown");
    expect(listing?.metadata?.characteristic1437Recognized).toBe(false);
  });

  it("trusts 1436 even when agency_id is present", () => {
    const listing = parseDomriaInfo({
      realty_id: 4,
      beautiful_url: "realty-4.html",
      city_name_uk: "Львів",
      agency_id: 99,
      characteristics_values: { "1437": 1436 },
      realty_type_id: 2,
    });
    expect(listing?.sellerType).toBe("owner");
  });
});
