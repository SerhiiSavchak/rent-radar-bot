import { describe, expect, it } from "vitest";
import type { Listing } from "../src/domain/listing.ts";
import { formatPrice } from "../src/outputs/telegram-test.sink.ts";
import {
  applyOlxDisplayPrice,
  parseOlxDisplayPrice,
} from "../src/sources/olx/olx-display-price.ts";

function listing(): Listing {
  return {
    source: "olx",
    sourceId: "1",
    url: "https://www.olx.ua/d/uk/obyavlenie/price-ID1.html",
    title: "Квартира",
    location: { raw: "Львів", city: "Львів" },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: new Date("2026-09-23T08:00:00.000Z"),
    price: { amount: 58342, currency: "UAH", period: "month" },
  };
}

describe("OLX displayed price", () => {
  it("reads the listing-page currency and leaves the catalog amount for dedupe", () => {
    expect(parseOlxDisplayPrice("1 300 $")).toEqual({ amount: 1300, currency: "USD" });
    expect(parseOlxDisplayPrice("€500")).toEqual({ amount: 500, currency: "EUR" });
    expect(parseOlxDisplayPrice("24 000 грн")).toEqual({ amount: 24000, currency: "UAH" });
    const card = listing();
    applyOlxDisplayPrice(card, "1 300 $");
    expect(card.price).toEqual({ amount: 58342, currency: "UAH", period: "month" });
    expect(card.displayPrice).toEqual({ amount: 1300, currency: "USD", period: "month" });
    expect(formatPrice(card)).toBe("$1 300 / місяць");
    expect(formatPrice(listing())).toBe("58 342 грн / місяць");
  });
});