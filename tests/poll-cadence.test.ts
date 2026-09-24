import { describe, expect, it } from "vitest";
import { waitMsUntilNextPollStart } from "../src/delivery/poll-cadence.ts";
import { formatListingTelegramHtml, formatPrice } from "../src/outputs/telegram-test.sink.ts";
import type { Listing } from "../src/domain/listing.ts";

describe("poll cadence", () => {
  it("waits only the remainder of the interval and never overlaps a long cycle", () => {
    expect(waitMsUntilNextPollStart(30_000, 600_000)).toBe(570_000);
    expect(waitMsUntilNextPollStart(60_000, 600_000)).toBe(540_000);
    expect(waitMsUntilNextPollStart(120_000, 600_000)).toBe(480_000);
    expect(waitMsUntilNextPollStart(540_000, 600_000)).toBe(60_000);
    expect(waitMsUntilNextPollStart(600_000, 600_000)).toBe(0);
    expect(waitMsUntilNextPollStart(600_001, 600_000)).toBe(0);
    expect(waitMsUntilNextPollStart(700_000, 600_000)).toBe(0);
    expect(waitMsUntilNextPollStart(0, 600_000)).toBe(600_000);
  });
});

describe("client Telegram price", () => {
  function listing(currency: string, amount = 600): Listing {
    return {
      source: "olx",
      sourceId: "1",
      url: "https://www.olx.ua/d/uk/obyavlenie/price-1",
      title: "Квартира",
      location: { raw: "Львів", city: "Львів", district: "Франківський" },
      propertyType: "apartment",
      sellerType: "owner",
      rooms: 2,
      areaM2: 62,
      metadata: { floor: 5, totalFloors: 9 },
      price: { amount, currency, period: "month" },
      publishedAt: new Date(),
      discoveredAt: new Date(),
    };
  }

  it("prints the source currency without conversion", () => {
    expect(formatPrice(listing("USD"))).toBe("$600 / місяць");
    expect(formatPrice(listing("EUR", 500))).toBe("€500 / місяць");
    expect(formatPrice(listing("UAH", 24000))).toBe("24 000 грн / місяць");
    const text = formatListingTelegramHtml(listing("USD"));
    expect(text).toContain("2-кімнатна квартира");
    expect(text).toContain("62 м² · 2 кімнати · 5/9 поверх");
    expect(text).toContain("сьогодні");
    expect(text).not.toContain("apartment");
    expect(text).not.toContain("Вперше помічено");
    expect(text).not.toContain("Оновлено");
  });
});
