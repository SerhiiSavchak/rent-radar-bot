import { describe, expect, it } from "vitest";
import { isSellerEligible } from "../src/filters/owner-filter.ts";
import { inspectDomriaCatalog, parseDomriaInfo } from "../src/sources/domria/domria.parser.ts";

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
    expect(listing ? isSellerEligible(listing) : true).toBe(false);
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
    expect(listing ? isSellerEligible(listing) : false).toBe(true);
  });

  it("preserves old publishing_date and never substitutes now", () => {
    const listing = parseDomriaInfo({
      realty_id: 99,
      beautiful_url: "realty-99.html",
      city_name_uk: "Львів",
      publishing_date: "2025-12-31 17:03:31",
      realty_type_id: 2,
      characteristics_values: { "1437": 1436 },
    });
    expect(listing?.publishedAt?.toISOString()).toBe(new Date("2025-12-31T17:03:31").toISOString());
    expect(listing?.metadata?.publishedAtProvenance).toBe("domria.publishing_date");
    expect(listing?.discoveredAt.getTime()).toBeGreaterThan(listing!.publishedAt!.getTime());
  });

  it("maps named area and floor-count fields and distinguishes an empty catalog", () => {
    const listing = parseDomriaInfo({
      realty_id: 5,
      beautiful_url: "realty-5.html",
      city_name_uk: "Львів",
      realty_type_id: 2,
      total_square_meters: 42.5,
      floors_count: 9,
      characteristics_values: { "1437": 1436 },
    });
    expect(listing?.areaM2).toBe(42.5);
    expect(listing?.metadata?.totalFloors).toBe(9);

    const empty = inspectDomriaCatalog({ catalog: { realtyForCatalog: [] } });
    expect(empty.structurePresent).toBe(true);
    expect(empty.listings).toHaveLength(0);

    const missing = inspectDomriaCatalog({ catalog: {} });
    expect(missing.structurePresent).toBe(false);
    expect(missing.listings).toHaveLength(0);
  });
});
