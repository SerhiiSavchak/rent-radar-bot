import { describe, expect, it } from "vitest";
import { inspectLunHtml, parseLunCard } from "../src/sources/lun/lun.parser.ts";

describe("LUN parser", () => {
  it("uses isOwner as a platform signal and GeoJSON [lng, lat]", () => {
    const listing = parseLunCard(
      {
        id: 4723362979,
        urlRaw: "https://lun.ua/uk/realty/4723362979",
        insertTime: "2026-09-13T13:35:15",
        price: 550,
        currency: "usd",
        isOwner: true,
        withoutCommission: true,
        agency: null,
        location: [24.0234476, 49.774733],
        sectionId: 2,
        text: "Оренда",
      },
      {
        "@type": ["Apartment", "Product"],
        name: "вулиця Карла Мікльоша, 20-Б",
        description: "Тест",
        address: { addressLocality: "Львів", streetAddress: "вулиця Карла Мікльоша" },
      },
    );
    expect(listing?.sellerType).toBe("owner");
    expect(listing?.location.latitude).toBeCloseTo(49.774733);
    expect(listing?.location.longitude).toBeCloseTo(24.0234476);
    expect(listing?.url).toContain("4723362979");
    expect(listing?.metadata?.originalUrl).toBe("https://lun.ua/uk/realty/4723362979");
    expect(listing?.metadata?.originalHost).toBe("lun.ua");
  });

  it("treats missing RSC cards as parser failure, not empty inventory", () => {
    const inspection = inspectLunHtml("<html><body>no listings</body></html>");
    expect(inspection.resultKind).toBe("parser_failure");
    expect(inspection.listings).toHaveLength(0);
    expect(inspection.hasRscCardsMarker).toBe(false);
  });

  it("treats present empty cards array as valid empty", () => {
    const inner = '{"realties":{"cards":[]}}';
    const encoded = JSON.stringify(inner).slice(1, -1);
    const html = `<html><script>self.__next_f.push([1,"${encoded}"])</script></html>`;
    const inspection = inspectLunHtml(html);
    expect(inspection.hasRscCardsMarker).toBe(true);
    expect(inspection.resultKind).toBe("valid_empty");
    expect(inspection.listings).toHaveLength(0);
  });
});
