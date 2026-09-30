import { describe, expect, it } from "vitest";
import type { Listing } from "../src/domain/listing.ts";
import {
  formatListingTelegramHtml,
  formatListingTelegramPlain,
  formatSellerLabel,
  formatSellerVerificationLine,
  OWNER_SEARCH_TAG_CONFIRMED,
  OWNER_SEARCH_TAG_UNVERIFIED,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../src/outputs/telegram-test.sink.ts";

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    source: "olx",
    sourceId: "42",
    url: "https://www.olx.ua/d/obyavlenie/orenda-ID11card.html",
    title: "Квартира",
    price: { amount: 450, currency: "USD", period: "month" },
    location: {
      raw: "Львів, Франківський",
      city: "Львів",
      district: "Франківський",
    },
    propertyType: "apartment",
    rooms: 2,
    areaM2: 58,
    sellerType: "unknown",
    discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
    publishedAt: new Date("2026-09-22T18:34:00.000Z"),
    metadata: { floor: 4, totalFloors: 9 },
    ...overrides,
  };
}

describe("Telegram card search tags and seller UX", () => {
  it("confirmed card has unique tag and human label", () => {
    const card = formatListingTelegramHtml(
      listing({
        sellerType: "owner",
        metadata: { floor: 4, totalFloors: 9, ownerEvidenceLevel: "platform_confirmed" },
      }),
    );
    expect(formatSellerLabel(listing({
      sellerType: "owner",
      metadata: { ownerEvidenceLevel: "platform_confirmed" },
    }))).toContain("Власник підтверджений");
    expect(card).toContain(OWNER_SEARCH_TAG_CONFIRMED);
    expect(card).not.toContain(OWNER_SEARCH_TAG_UNVERIFIED);
    expect(card).toContain("Власник підтверджений");
    expect(card).toContain("Перевірка: підтверджено платформою");
    expect(card).toMatch(/👤\s*✅/);
  });

  it("unverified card has unique tag and never confirmed tag", () => {
    const card = formatListingTelegramHtml(
      listing({
        sellerType: "unknown",
        metadata: { floor: 4, totalFloors: 9, ownerEvidenceLevel: "private_unknown" },
      }),
    );
    expect(card).toContain(OWNER_SEARCH_TAG_UNVERIFIED);
    expect(card).not.toContain(OWNER_SEARCH_TAG_CONFIRMED);
    expect(card).toContain("Власник не підтверджений");
    expect(card).toContain("Перевірка: недостатньо даних");
    expect(card).toMatch(/👤\s*⚠️/);
  });

  it("sellerType=owner without platform_confirmed is unverified in UI", () => {
    const label = formatSellerLabel(listing({ sellerType: "owner" }));
    expect(label).toContain(OWNER_SEARCH_TAG_UNVERIFIED);
    expect(label).not.toContain(OWNER_SEARCH_TAG_CONFIRMED);
    expect(formatSellerVerificationLine(listing({ sellerType: "owner" }))).toContain(
      "недостатньо даних",
    );
  });

  it("search tags are unique and neither is a substring of the other", () => {
    expect(OWNER_SEARCH_TAG_CONFIRMED.includes(OWNER_SEARCH_TAG_UNVERIFIED)).toBe(false);
    expect(OWNER_SEARCH_TAG_UNVERIFIED.includes(OWNER_SEARCH_TAG_CONFIRMED)).toBe(false);
    const confirmed = formatListingTelegramHtml(
      listing({
        sellerType: "owner",
        metadata: { ownerEvidenceLevel: "platform_confirmed" },
      }),
    );
    const unverified = formatListingTelegramHtml(listing());
    expect(confirmed.includes(OWNER_SEARCH_TAG_CONFIRMED)).toBe(true);
    expect(confirmed.includes(OWNER_SEARCH_TAG_UNVERIFIED)).toBe(false);
    expect(unverified.includes(OWNER_SEARCH_TAG_UNVERIFIED)).toBe(true);
    expect(unverified.includes(OWNER_SEARCH_TAG_CONFIRMED)).toBe(false);
  });

  it("escapes HTML-special characters in listing fields", () => {
    const card = formatListingTelegramHtml(
      listing({
        title: "A & B <C>",
        location: { raw: "Lviv > center & district", city: "Lviv & Co > Area", district: "A < B" },
      }),
    );
    expect(card).toContain("&amp;");
    expect(card).toContain("&lt;");
    expect(card).toContain("&gt;");
    expect(card).not.toMatch(/Lviv > center/);
  });

  it("keeps message within Telegram length via fitting", () => {
    const card = formatListingTelegramHtml(
      listing({ location: { raw: "x".repeat(8000), city: "x".repeat(100) } }),
    );
    expect(card.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
  });

  it("plain-text fallback preserves search tags", () => {
    const confirmed = formatListingTelegramPlain(
      listing({
        sellerType: "owner",
        metadata: { ownerEvidenceLevel: "platform_confirmed" },
      }),
    );
    const unverified = formatListingTelegramPlain(listing());
    expect(confirmed).toContain(OWNER_SEARCH_TAG_CONFIRMED);
    expect(confirmed).not.toContain(OWNER_SEARCH_TAG_UNVERIFIED);
    expect(unverified).toContain(OWNER_SEARCH_TAG_UNVERIFIED);
    expect(unverified).not.toContain(OWNER_SEARCH_TAG_CONFIRMED);
    expect(confirmed).not.toContain("<b>");
  });

  it("keeps compact useful fields already on the listing", () => {
    const card = formatListingTelegramHtml(
      listing({
        sellerType: "owner",
        metadata: { floor: 4, totalFloors: 9, ownerEvidenceLevel: "platform_confirmed" },
      }),
    );
    expect(card).toContain("58 м²");
    expect(card).toContain("2 кімнати");
    expect(card).toContain("4/9 поверх");
    expect(card).toContain("Львів, Франківський район");
    expect(card).not.toContain("🏡");
    expect(card).toContain("OLX");
  });
});

describe("Telegram card address detail", () => {
  it("renders city+district+street+house", () => {
    const card = formatListingTelegramHtml(
      listing({
        metadata: {
          floor: 4,
          totalFloors: 9,
          street: "вул. Наукова",
          houseNumber: "12",
        },
      }),
    );
    expect(card).toContain("📍 Львів, Франківський район");
    expect(card).toContain("🏡 вул. Наукова, 12");
  });

  it("renders city+district+street only", () => {
    const card = formatListingTelegramHtml(
      listing({
        metadata: { street: "вул. Наукова" },
      }),
    );
    expect(card).toContain("📍 Львів, Франківський район");
    expect(card).toContain("🏡 вул. Наукова");
    expect(card).not.toMatch(/🏡 вул\. Наукова,/);
  });

  it("renders city/district only without address line", () => {
    const card = formatListingTelegramHtml(listing());
    expect(card).toContain("📍 Львів, Франківський район");
    expect(card).not.toContain("🏡");
  });

  it("renders street without district", () => {
    const card = formatListingTelegramHtml(
      listing({
        location: { raw: "Львів, вул. Личаківська", city: "Львів" },
        metadata: { street: "вул. Личаківська", houseNumber: "5" },
      }),
    );
    expect(card).toContain("📍 Львів");
    expect(card).not.toContain("район");
    expect(card).toContain("🏡 вул. Личаківська, 5");
  });

  it("omits address line when street metadata is missing", () => {
    const card = formatListingTelegramHtml(
      listing({
        location: { raw: "unknown" },
        metadata: { floor: 1 },
      }),
    );
    expect(card).not.toContain("🏡");
  });

  it("does not duplicate city/district inside the address detail line", () => {
    const card = formatListingTelegramHtml(
      listing({
        metadata: {
          streetAddress: "Львів, Франківський район, вул. Наукова, 12",
        },
      }),
    );
    expect(card).toContain("📍 Львів, Франківський район");
    expect(card).toContain("🏡 вул. Наукова, 12");
    expect(card).not.toContain("🏡 Львів, Франківський район, вул. Наукова, 12");
  });

  it("escapes HTML in street/house fields", () => {
    const card = formatListingTelegramHtml(
      listing({
        metadata: {
          street: "вул. A & B <C>",
          houseNumber: "1 > 2",
        },
      }),
    );
    expect(card).toContain("&amp;");
    expect(card).toContain("&lt;");
    expect(card).toContain("&gt;");
    expect(card).not.toContain("вул. A & B <C>");
  });

  it("keeps length fitting with long street metadata", () => {
    const card = formatListingTelegramHtml(
      listing({
        metadata: { street: "вул. ".concat("Довга".repeat(2000)), houseNumber: "1" },
      }),
    );
    expect(card.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
  });
});
