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

  it("marks intermediaries as agents", () => {
    const listing = parseDomriaInfo({
      realty_id: 1,
      beautiful_url: "realty-1.html",
      city_name_uk: "Львів",
      agency_id: 52150,
      characteristics_values: { "1437": 1434 },
      realty_type_id: 2,
    });
    expect(listing?.sellerType).toBe("agent");
  });
});
