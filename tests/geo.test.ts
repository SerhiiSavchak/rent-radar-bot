import { describe, expect, it } from "vitest";
import { haversineKm, normalizeLatLng } from "../src/utils/geo.ts";
import { filterByLocation } from "../src/filters/location-filter.ts";

describe("haversine", () => {
  it("returns ~0 for the same point", () => {
    expect(haversineKm(49.8397, 24.0297, 49.8397, 24.0297)).toBeLessThan(0.001);
  });

  it("places Vynnyky roughly within 15 km of Lviv center", () => {
    const km = haversineKm(49.8397, 24.0297, 49.8156, 24.1447);
    expect(km).toBeGreaterThan(5);
    expect(km).toBeLessThan(15);
  });

  it("swaps inverted LUN JSON-LD coordinates", () => {
    const normalized = normalizeLatLng(24.02, 49.84);
    expect(normalized.latitude).toBeCloseTo(49.84);
    expect(normalized.longitude).toBeCloseTo(24.02);
  });
});

describe("location filter", () => {
  const config = { centerLat: 49.8397, centerLng: 24.0297, radiusKm: 15 };

  it("does not treat the word Lviv as a radius match", () => {
    const result = filterByLocation({ city: "Lviv" }, config);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("no-coordinates");
  });

  it("matches coordinates inside the radius", () => {
    const result = filterByLocation({ latitude: 49.84, longitude: 24.03 }, config);
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("within-radius");
  });
});
