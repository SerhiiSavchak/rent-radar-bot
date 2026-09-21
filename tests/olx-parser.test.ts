import { describe, expect, it } from "vitest";
import { diagnoseOlxOfferParse, extractOlxUrlToken, parseOlxOffersPayload } from "../src/sources/olx/olx.parser.ts";
import {
  buildOlxOffersUrl,
  OLX_CATEGORY_APARTMENTS_LONG_TERM_RENT,
  OLX_CATEGORY_HOUSES_LONG_TERM_RENT,
} from "../src/sources/olx/olx.source.ts";

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
    expect(listings[0]?.sellerType).toBe("unknown");
    expect(listings[0]?.metadata?.ownerEvidenceLevel).toBe("self_declared");
    expect(listings[0]?.metadata?.filterConsidersPrivateOwner).toBe(false);
    expect(listings[0]?.sellerEvidence?.some((item) => item.includes("private account"))).toBe(true);
  });

  it("takes approximate coordinates from map and keeps the approximation radius", () => {
    // Real api/v1/offers payloads put coordinates in `map`, not `location` (verified 2026-09-15).
    const listings = parseOlxOffersPayload({
      data: [
        {
          id: 934822999,
          title: "Здам в оренду будинок, Львів- Солонка",
          url: "https://www.olx.ua/d/uk/obyavlenie/zdam-v-orendu-budinok-lvv-solonka-ID11gqaj.html",
          created_time: "2026-09-14T18:19:11+03:00",
          last_refresh_time: "2026-09-14T18:22:44+03:00",
          business: true,
          map: { zoom: 12, lat: 49.75413, lon: 24.01337, radius: 1, show_detailed: false },
          location: { city: { id: 38731, name: "Солонка" }, region: { name: "Львівська область" } },
        },
      ],
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]?.location.latitude).toBeCloseTo(49.75413);
    expect(listings[0]?.location.longitude).toBeCloseTo(24.01337);
    expect(listings[0]?.metadata?.coordinatesRadiusKm).toBe(1);
    // publishedAt is the creation time; the refresh bump is preserved separately.
    expect(listings[0]?.publishedAt?.toISOString()).toBe(new Date("2026-09-14T18:19:11+03:00").toISOString());
    expect(listings[0]?.refreshedAt?.toISOString()).toBe(new Date("2026-09-14T18:22:44+03:00").toISOString());
    expect(listings[0]?.metadata?.lastRefreshTime).toBe("2026-09-14T18:22:44+03:00");
    expect(listings[0]?.metadata?.urlToken).toBe("11gqaj");
    expect(listings[0]?.sellerType).toBe("business");
  });

  it("accepts catalog photos as URL strings without requiring { link } objects", () => {
    const listings = parseOlxOffersPayload({
      data: [
        {
          id: 935081899,
          title: "Оренда 2x кімнатної квартири",
          url: "https://www.olx.ua/d/uk/obyavlenie/orenda-2x-kmnatno-kvartiri-ID11hwv7.html",
          created_time: "2026-09-17T08:34:26+03:00",
          last_refresh_time: "2026-09-17T08:40:09+03:00",
          business: false,
          params: [{ key: "price", value: { value: 53650, currency: "UAH" } }],
          location: { city: { name: "Львів" } },
          photos: ["https://ireland.apollo.olxcdn.com:443/v1/files/derived-private-apt-UA/image;s=1000x750"],
          category: { id: 1760 },
        },
      ],
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]?.images).toEqual([
      "https://ireland.apollo.olxcdn.com:443/v1/files/derived-private-apt-UA/image;s=1000x750",
    ]);
  });

  it("names the exact schema path when a catalog photo is not a URL string or link object", () => {
    expect(
      diagnoseOlxOfferParse({
        id: 1,
        title: "x",
        url: "https://www.olx.ua/d/uk/obyavlenie/x-ID11aaaa.html",
        photos: [123],
      }),
    ).toMatch(/offer_schema photos\.0/);
  });

  it("extracts URL tokens for exact identity matching", () => {
    expect(
      extractOlxUrlToken("https://www.olx.ua/d/uk/obyavlenie/zdam-1-kmnatnu-kvartiru-ID11gWHG.html"),
    ).toBe("11gWHG");
    expect(extractOlxUrlToken("https://www.olx.ua/uk/obyavlenie/no-token-here")).toBeUndefined();
  });
});

describe("OLX search query", () => {
  it("targets Lviv and ~15 km around it with verified geo/category ids", () => {
    const apartments = buildOlxOffersUrl(OLX_CATEGORY_APARTMENTS_LONG_TERM_RENT);
    const houses = buildOlxOffersUrl(OLX_CATEGORY_HOUSES_LONG_TERM_RENT);
    for (const url of [apartments, houses]) {
      const params = new URL(url).searchParams;
      // region 5 = Львівська область, city 176 = Львів (geo-encoder, 2026-09-15).
      expect(params.get("region_id")).toBe("5");
      expect(params.get("city_id")).toBe("176");
      expect(params.get("distance")).toBe("15");
      expect(params.get("sort_by")).toBe("created_at:desc");
    }
    // 1760 = довгострокова оренда квартир; 330 = довгострокова оренда будинків.
    expect(new URL(apartments).searchParams.get("category_id")).toBe("1760");
    expect(new URL(houses).searchParams.get("category_id")).toBe("330");
    // Regression: the old hardcoded query pointed at Краснодон (Луганська обл.) and
    // «Продаж квартир»; make sure those ids are gone.
    expect(apartments).not.toContain("region_id=12");
    expect(apartments).not.toContain("city_id=13");
    expect(houses).not.toContain("category_id=1758");
  });
});
