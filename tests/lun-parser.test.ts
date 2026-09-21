import { describe, expect, it } from "vitest";
import {
  extractNextFlightPayloads,
  inspectLunHtml,
  parseLunCard,
} from "../src/sources/lun/lun.parser.ts";

function encodeFlightString(inner: string): string {
  return JSON.stringify(inner).slice(1, -1);
}

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
    const encoded = encodeFlightString(inner);
    const html = `<html><script>self.__next_f.push([1,"${encoded}"])</script></html>`;
    const inspection = inspectLunHtml(html);
    expect(inspection.hasRscCardsMarker).toBe(true);
    expect(inspection.resultKind).toBe("valid_empty");
    expect(inspection.listings).toHaveLength(0);
  });

  it("parses cards when a later __next_f.push appends trailing RSC text (regression for JSON@214432)", () => {
    const card = {
      id: 99,
      price: 10000,
      currency: "uah",
      isOwner: true,
      sectionId: 2,
      header: "Тест",
      location: [24.0, 49.8],
    };
    const cardsPayload = `prefix{"realties":{"cards":[${JSON.stringify(card)}]}}suffix`;
    const trailingRsc = '8:I["chunk",[],""]\\n0:["$","$L1",null,{}]';
    const html = [
      "<html><script>",
      `self.__next_f.push([1,"${encodeFlightString(cardsPayload)}"])`,
      `self.__next_f.push([1,"${encodeFlightString(trailingRsc)}"])`,
      "</script></html>",
    ].join("");

    // Greedy single-match would concatenate both push bodies and break JSON.parse.
    const payloads = extractNextFlightPayloads(html);
    expect(payloads.length).toBe(2);
    expect(payloads[0]).toContain('"realties":{"cards":[');
    expect(payloads[1]).toContain("8:I[");

    const inspection = inspectLunHtml(html);
    expect(inspection.cardsParseFailed).toBe(false);
    expect(inspection.resultKind).toBe("ok");
    expect(inspection.rawCardCount).toBe(1);
    expect(inspection.listings).toHaveLength(1);
    expect(inspection.listings[0]?.sourceId).toBe("99");
  });

  it("marks truncated/malformed cards array as parser_failure, not healthy empty", () => {
    // Marker present but array never closes — must not become valid_empty.
    const truncated = '{"realties":{"cards":[{"id":1,"price":1';
    const html = `<html><script>self.__next_f.push([1,"${encodeFlightString(truncated)}"])</script></html>`;
    const inspection = inspectLunHtml(html);
    expect(inspection.hasRscCardsMarker).toBe(true);
    expect(inspection.cardsParseFailed).toBe(true);
    expect(inspection.resultKind).toBe("parser_failure");
    expect(inspection.listings).toHaveLength(0);
  });

  it("skips an unclosed flight string without inventing success", () => {
    // No closing quote for the JS string literal — parser must not invent a payload.
    const html = `<html><script>self.__next_f.push([1,"{\\"realties\\":{\\"cards\\":[]}</script></html>`;
    const payloads = extractNextFlightPayloads(html);
    expect(payloads.length).toBe(0);
    const inspection = inspectLunHtml(html);
    expect(inspection.resultKind).toBe("parser_failure");
  });
});
