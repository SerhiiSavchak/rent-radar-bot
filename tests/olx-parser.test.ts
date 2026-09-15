import { describe, expect, it } from "vitest";
import { parseOlxOffersPayload } from "../src/sources/olx/olx.parser.ts";

describe("OLX parser", () => {
  it("normalizes a fixture offer and does not invent coordinates", () => {
    const listings = parseOlxOffersPayload({
      data: [
        {
          id: 123,
          title: "Оренда квартири",
          description: "від власника",
          url: "https://www.olx.ua/d/uk/obyavlenie/test-IDabc.html",
          created_time: "2026-09-13T10:00:00+03:00",
          business: false,
          params: [{ key: "price", value: { value: 15000, currency: "UAH" } }],
          location: { city: { name: "Львів" }, district: { name: "Галицький" } },
          user: { id: 1, name: "Ivan" },
        },
      ],
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]?.source).toBe("olx");
    expect(listings[0]?.price?.amount).toBe(15000);
    expect(listings[0]?.location.latitude).toBeUndefined();
    expect(listings[0]?.sellerType).toBe("owner");
  });
});
