import { describe, expect, it } from "vitest";
import type { Listing } from "../src/domain/listing.ts";
import { formatPrice } from "../src/outputs/telegram-test.sink.ts";
import {
  applyOlxDisplayPrice,
  applyOlxAccountRegistrationYear,
  parseOlxDisplayPrice,
} from "../src/sources/olx/olx-display-price.ts";
import {
  OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
  sellerRegistrationYearRejectionReason,
} from "../src/sources/olx/olx-account-registration.ts";
import {
  registrationYearDecisionFromMetadata,
  shouldRejectSellerProfile,
} from "../src/delivery/seller-profile.ts";
import { classifyOlxLinkedSellerHtml } from "../src/delivery/olx-detail-seller.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";
import { derivedOracleHousePrivateAd } from "./fixtures/olx-prerendered-oracle-derived.ts";

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

  it("stores platform registration year from member-since without inventing missing years", () => {
    const withYear = listing();
    applyOlxAccountRegistrationYear(
      withYear,
      `<p data-testid="member-since">на OLX з <span>січень 2026 р.</span></p>`,
    );
    expect(withYear.metadata?.accountRegistrationYear).toBe(2026);
    expect(
      sellerRegistrationYearRejectionReason(withYear.metadata?.accountRegistrationYear as number),
    ).toBe(OLX_SELLER_REGISTRATION_YEAR_2026_REASON);

    const missing = listing();
    applyOlxAccountRegistrationYear(missing, "<html><body>Опубліковано 2026</body></html>");
    expect(missing.metadata?.accountRegistrationYear).toBeUndefined();
  });
});

describe("linked OLX / LUN registration year exclusion", () => {
  it("rejects linked OLX HTML when member-since year is exactly 2026", () => {
    const ad = {
      ...derivedOracleHousePrivateAd(),
      url: "https://www.olx.ua/d/uk/obyavlenie/x-ID11reg26.html",
      urlPath: "/d/uk/obyavlenie/x-ID11reg26.html",
    };
    const html = derivedOracleOfferDetailHtml(ad, { memberSince: "лютий 2026 р." });
    const classified = classifyOlxLinkedSellerHtml(html, "11reg26");
    expect(classified.verdict).toBe("seller_registration_year_2026");
    expect(classified.evidence).toBe(OLX_SELLER_REGISTRATION_YEAR_2026_REASON);
  });

  it("does not reject linked OLX HTML for registration year 2025", () => {
    const ad = {
      ...derivedOracleHousePrivateAd(),
      url: "https://www.olx.ua/d/uk/obyavlenie/x-ID11reg25.html",
      urlPath: "/d/uk/obyavlenie/x-ID11reg25.html",
    };
    const html = derivedOracleOfferDetailHtml(ad, { memberSince: "червень 2025 р." });
    const classified = classifyOlxLinkedSellerHtml(html, "11reg25");
    expect(classified.verdict).not.toBe("seller_registration_year_2026");
  });

  it("applies the same metadata decision for LUN listings enriched from OLX", () => {
    const decision = registrationYearDecisionFromMetadata({ accountRegistrationYear: 2026 });
    expect(decision?.verdict).toBe("seller_registration_year_2026");
    expect(shouldRejectSellerProfile(decision!.verdict)).toBe(true);
    expect(
      registrationYearDecisionFromMetadata({ accountRegistrationYear: 2025 }),
    ).toBeUndefined();
    expect(registrationYearDecisionFromMetadata({})).toBeUndefined();
  });
});
