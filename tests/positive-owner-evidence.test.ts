import { describe, expect, it } from "vitest";
import {
  classifyOlxLinkedSellerHtml,
  createCycleOlxSellerVerifier,
} from "../src/delivery/olx-detail-seller.ts";
import { classifyRieltorDetailSeller } from "../src/delivery/rieltor-detail-seller.ts";
import {
  isPlatformConfirmedOwner,
  SELLER_INVENTORY_LIMIT_MIN,
} from "../src/delivery/seller-profile.ts";
import {
  classifyOwner,
  isSellerEligible,
  sellerAssessmentFromClassification,
  sellerRejectionReason,
} from "../src/filters/owner-filter.ts";
import type { Listing } from "../src/domain/listing.ts";
import { inspectRieltorHtml } from "../src/sources/rieltor/rieltor.parser.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";

const TOKEN = "11poe01";
const OLX_URL = `https://www.olx.ua/d/obyavlenie/orenda-ID${TOKEN}.html`;

function olxHtml(opts: {
  sellerType?: string | null;
  isBusiness?: boolean;
  title?: string;
  description?: string;
  company?: string | null;
  name?: string;
  memberSince?: string;
}): string {
  const html = derivedOracleOfferDetailHtml(
    {
      id: 42,
      url: OLX_URL,
      title: opts.title ?? "Квартира",
      description: opts.description ?? "Оренда",
      user: {
        name: opts.name ?? "Продавець",
        company_name: opts.company === undefined ? null : opts.company,
        sellerType: opts.sellerType === undefined ? null : opts.sellerType,
      },
      isBusiness: opts.isBusiness ?? false,
    },
    opts.memberSince ? { memberSince: opts.memberSince } : undefined,
  );
  return html;
}

function rieltorCatalogCard(label: string): string {
  return `<!doctype html>
<html lang="uk">
<head>
  <title>Зняти квартиру в Львові, оренда квартир - RIELTOR.UA</title>
  <link rel="canonical" href="https://rieltor.ua/lvov/flats-rent/">
</head>
<body>
  <h1><span data-listing-title>Оренда квартир в Львові</span></h1>
  <span data-listing-count>1 оголошення</span>
  <div data-listing-items>
<div class="catalog-card " data-catalog-item-id="13001" data-longitude="24.03" data-latitude="49.84">
  <a href="https://rieltor.ua/lvov/flats-rent/view/13001/" class="catalog-card-media"></a>
  <div class="catalog-card-price-title">10000 грн</div>
  <h2 class="catalog-card-address">Зелена вул., 1</h2>
  <h2 class="catalog-card-region">Львів</h2>
  <div class="catalog-card-update"><span>сьогодні</span></div>
  <div class="catalog-card-author-subtitle"><span>${label}</span></div>
</div>
  </div>
</body></html>`;
}

describe("positive owner evidence — platform markers", () => {
  it("RIELTOR Ukrainian platform badge Власник → confirmed_owner", () => {
    const detail = classifyRieltorDetailSeller(
      `<div class="offer-view-rieltor-position">Власник</div>`,
    );
    expect(detail.verdict).toBe("confirmed_owner");
    const catalog = inspectRieltorHtml(rieltorCatalogCard("Власник"), {
      category: "apartment",
      pageUrl: "https://rieltor.ua/lvov/flats-rent/",
    });
    const listing = catalog.listings[0]!;
    expect(listing.sellerType).toBe("owner");
    expect(listing.metadata?.ownerEvidenceLevel).toBe("platform_confirmed");
    expect(isPlatformConfirmedOwner(listing)).toBe(true);
  });

  it("RIELTOR Russian platform badge Собственник → confirmed_owner", () => {
    const detail = classifyRieltorDetailSeller(
      `<div class="offer-view-rieltor-position">Собственник</div>`,
    );
    expect(detail.verdict).toBe("confirmed_owner");
    const catalog = inspectRieltorHtml(rieltorCatalogCard("Собственник"), {
      category: "apartment",
      pageUrl: "https://rieltor.ua/lvov/flats-rent/",
    });
    expect(catalog.listings[0]?.sellerType).toBe("owner");
    expect(catalog.listings[0]?.metadata?.ownerEvidenceLevel).toBe("platform_confirmed");
  });

  it("RIELTOR English platform badge Owner → confirmed_owner", () => {
    const detail = classifyRieltorDetailSeller(
      `<div class="offer-view-rieltor-position">Owner</div>`,
    );
    expect(detail.verdict).toBe("confirmed_owner");
    expect(
      inspectRieltorHtml(rieltorCatalogCard("Owner"), {
        category: "apartment",
        pageUrl: "https://rieltor.ua/lvov/flats-rent/",
      }).listings[0]?.sellerType,
    ).toBe("owner");
  });

  it("OLX structured user.sellerType=owner → confirmed_owner (not display name)", () => {
    const classified = classifyOlxLinkedSellerHtml(
      olxHtml({ sellerType: "owner", isBusiness: false, name: "Олена" }),
      TOKEN,
    );
    expect(classified.verdict).toBe("confirmed_owner");
    const owner = classifyOwner({ platformOwner: true });
    expect(owner.sellerType).toBe("owner");
    expect(owner.ownerEvidenceLevel).toBe("platform_confirmed");
    expect(
      isPlatformConfirmedOwner({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      }),
    ).toBe(true);
  });

  it("DOM.RIA platformOwner stays platform_confirmed; LUN aggregatorOwner does not", () => {
    const domria = classifyOwner({
      platformOwner: true,
      offerTypeLabel: "від власника",
    });
    expect(domria.sellerType).toBe("owner");
    expect(domria.ownerEvidenceLevel).toBe("platform_confirmed");
    const lun = classifyOwner({
      aggregatorOwner: true,
    });
    expect(lun.sellerType).not.toBe("owner");
    expect(lun.ownerEvidenceLevel).not.toBe("platform_confirmed");
    expect(
      isPlatformConfirmedOwner({
        sellerType: lun.sellerType,
        metadata: { ownerEvidenceLevel: lun.ownerEvidenceLevel },
      }),
    ).toBe(false);
    expect(lun.sellerEvidence.join(" ")).toMatch(/aggregator owner claim/i);
    expect(
      lun.evidenceItems.some(
        (item) => item.source === "aggregator" && item.type === "owner_claim" && item.strength === "context",
      ),
    ).toBe(true);
  });
});

describe("positive owner evidence — free text must NOT confirm", () => {
  it.each([
    "я власник квартири",
    "від власника без комісії",
    "собственник квартиры сдаёт",
    "от собственника",
    "owner rents apartment",
    "без комісії",
  ])("free-text %j is not platform_confirmed", (description) => {
    const result = classifyOwner({
      platformPrivate: true,
      text: description,
    });
    expect(result.sellerType).not.toBe("owner");
    expect(result.ownerEvidenceLevel).not.toBe("platform_confirmed");
    expect(
      isPlatformConfirmedOwner({
        sellerType: result.sellerType,
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      }),
    ).toBe(false);
    const linked = classifyOlxLinkedSellerHtml(
      olxHtml({
        sellerType: null,
        isBusiness: false,
        description,
      }),
      TOKEN,
    );
    expect(linked.verdict).not.toBe("confirmed_owner");
  });

  it("mixed: platform badge absent, free text says owner → self_declared or unknown, not confirmed", () => {
    const result = classifyOwner({
      text: "Здам квартиру від власника. я власник",
    });
    expect(result.sellerType).toBe("unknown");
    expect(["self_declared", "private_unknown"]).toContain(result.ownerEvidenceLevel);
    expect(sellerAssessmentFromClassification(result).state).not.toBe("confirmed_owner");
  });

  it("seller display name Власник without sellerType=owner is not confirmed", () => {
    const linked = classifyOlxLinkedSellerHtml(
      olxHtml({ sellerType: null, isBusiness: false, name: "Власник" }),
      TOKEN,
    );
    expect(linked.verdict).not.toBe("confirmed_owner");
  });
});

describe("positive owner evidence — intermediary conflict", () => {
  it("owner-like free text + platform intermediary → intermediary wins", () => {
    const result = classifyOwner({
      platformAgent: true,
      offerTypeLabel: "Рієлтор",
      text: "я власник, від власника",
    });
    expect(result.sellerType).toBe("agent");
    expect(["intermediary", "conflict"]).toContain(result.ownerEvidenceLevel);
    expect(
      isSellerEligible({
        sellerType: result.sellerType,
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      }),
    ).toBe(false);
  });

  it("Business account plus a clean owner claim is self-declared, not a platform owner", () => {
    const result = classifyOwner({
      isBusiness: true,
      text: "я власник. від власника без посередників",
    });
    expect(result.sellerType).toBe("unknown");
    expect(result.ownerEvidenceLevel).toBe("self_declared");
    expect(
      classifyOlxLinkedSellerHtml(
        olxHtml({
          sellerType: null,
          isBusiness: true,
          description: "я власник квартири",
        }),
        TOKEN,
      ).verdict,
    ).not.toBe("confirmed_intermediary");
  });
});

describe("positive owner evidence — OR vs AND contract", () => {
  it("sellerType=owner already requires trusted platformOwner; AND is the explicit gate", () => {
    const onlyOwnerType = isPlatformConfirmedOwner({
      sellerType: "owner",
      metadata: { ownerEvidenceLevel: "self_declared" },
    });
    const onlyLevel = isPlatformConfirmedOwner({
      sellerType: "unknown",
      metadata: { ownerEvidenceLevel: "platform_confirmed" },
    });
    const both = isPlatformConfirmedOwner({
      sellerType: "owner",
      metadata: { ownerEvidenceLevel: "platform_confirmed" },
    });
    expect(onlyOwnerType).toBe(false);
    expect(onlyLevel).toBe(false);
    expect(both).toBe(true);
    // classifyOwner never emits the split states above from free text.
    const textOnly = classifyOwner({ text: "від власника" });
    expect(textOnly.sellerType === "owner" && textOnly.ownerEvidenceLevel === "platform_confirmed").toBe(
      false,
    );
  });

  it("classifyOlxLinkedSellerHtml uses AND (isPlatformConfirmedOwner), not OR", () => {
    expect(
      classifyOlxLinkedSellerHtml(olxHtml({ sellerType: "owner", isBusiness: false }), TOKEN)
        .verdict,
    ).toBe("confirmed_owner");
    expect(
      classifyOlxLinkedSellerHtml(
        olxHtml({ sellerType: null, isBusiness: false, description: "від власника" }),
        TOKEN,
      ).verdict,
    ).not.toBe("confirmed_owner");
  });
});

describe("OLX Business vs Private account type", () => {
  it("isBusiness=true without owner evidence fails closed and is not a seller role", () => {
    const result = classifyOwner({ isBusiness: true });
    expect(result.sellerType).toBe("unknown");
    expect(result.ownerEvidenceLevel).toBe("business_ambiguous");
    expect(
      sellerRejectionReason({
        sellerType: result.sellerType,
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      }),
    ).toBe("business_without_positive_owner_evidence");
    const linked = classifyOlxLinkedSellerHtml(olxHtml({ sellerType: null, isBusiness: true }), TOKEN);
    expect(linked.evidence).toContain("business_without_positive_owner_evidence");
  });

  it("trusted Private alone is NOT confirmed_owner", () => {
    const result = classifyOwner({ platformPrivate: true, isBusiness: false });
    expect(result.sellerType).toBe("unknown");
    expect(result.ownerEvidenceLevel).toBe("private_unknown");
    expect(
      classifyOlxLinkedSellerHtml(olxHtml({ sellerType: null, isBusiness: false }), TOKEN)
        .verdict,
    ).toBe("unknown");
  });

  it("Private + platform-confirmed owner → confirmed_owner allowed", () => {
    const result = classifyOwner({
      platformOwner: true,
      platformPrivate: true,
      isBusiness: false,
    });
    expect(result.sellerType).toBe("owner");
    expect(result.ownerEvidenceLevel).toBe("platform_confirmed");
    expect(
      classifyOlxLinkedSellerHtml(
        olxHtml({ sellerType: "owner", isBusiness: false }),
        TOKEN,
      ).verdict,
    ).toBe("confirmed_owner");
  });

  it("free-text business/private words are not account-type classification", () => {
    const result = classifyOwner({
      text: "This is a private business deal with my private landlord business",
    });
    expect(result.sellerType).not.toBe("business");
    expect(result.ownerEvidenceLevel).not.toBe("intermediary");
    expect(
      classifyOlxLinkedSellerHtml(
        olxHtml({
          sellerType: null,
          isBusiness: false,
          description: "private business owner account",
        }),
        TOKEN,
      ).verdict,
    ).toBe("unknown");
  });

  it("Private + inventory >=5 → inventory reject wins", async () => {
    const listing: Listing = {
      source: "olx",
      sourceId: TOKEN,
      url: OLX_URL,
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "unknown",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: {
        urlToken: TOKEN,
        ownerEvidenceLevel: "private_unknown",
        distinctPreciseRealEstateProperties: SELLER_INVENTORY_LIMIT_MIN,
      },
    };
    const verify = createCycleOlxSellerVerifier({
      peers: [listing],
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      timeoutMs: 1000,
      probeProfile: async () => {
        throw new Error("inventory metadata must short-circuit");
      },
    });
    const decision = await verify(listing);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_inventory_limit");
  });

  it("Private + registration year 2026 → registration reject wins", async () => {
    const listing: Listing = {
      source: "olx",
      sourceId: TOKEN,
      url: OLX_URL,
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "unknown",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: {
        urlToken: TOKEN,
        ownerEvidenceLevel: "private_unknown",
        accountRegistrationYear: 2026,
      },
    };
    const verify = createCycleOlxSellerVerifier({
      peers: [listing],
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      timeoutMs: 1000,
      probeProfile: async () => {
        throw new Error("registration metadata must short-circuit");
      },
    });
    const decision = await verify(listing);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_registration_year_excluded");
  });

  it("Private + linked strong intermediary evidence → intermediary wins", async () => {
    const lun: Listing = {
      source: "lun",
      sourceId: "lun-poe",
      url: "https://lun.ua/uk/realty/lun-poe",
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "owner",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: {
        ownerEvidenceLevel: "platform_confirmed",
        originalUrl: OLX_URL,
      },
    };
    const verify = createCycleOlxSellerVerifier({
      peers: [lun],
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      timeoutMs: 1000,
      fetchPage: async () => ({
        status: 200,
        finalUrl: OLX_URL,
        bodyText: olxHtml({
          sellerType: null,
          isBusiness: false,
          company: "West Realty",
          name: "West Realty",
        }),
      }),
    });
    const decision = await verify(lun);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_confirmed_agent");
  });
});

describe("positive owner evidence — cross-source precedence", () => {
  it("LUN platform owner does not override incomplete/reject OLX linked state", async () => {
    const lun: Listing = {
      source: "lun",
      sourceId: "lun-cross",
      url: "https://lun.ua/uk/realty/lun-cross",
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "owner",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: {
        ownerEvidenceLevel: "platform_confirmed",
        originalUrl: OLX_URL,
      },
    };
    const incompletePeer: Listing = {
      source: "olx",
      sourceId: TOKEN,
      url: OLX_URL,
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: "unknown",
      discoveredAt: new Date("2026-09-22T10:00:00.000Z"),
      publishedAt: new Date("2026-09-22T09:00:00.000Z"),
      metadata: { urlToken: TOKEN, ownerEvidenceLevel: "private_unknown" },
    };
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      peers: [lun, incompletePeer],
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      timeoutMs: 1000,
      fetchPage: async () => {
        fetches += 1;
        return {
          status: 200,
          finalUrl: OLX_URL,
          bodyText: olxHtml({ sellerType: "agency", isBusiness: true, name: "Агент" }),
        };
      },
    });
    const decision = await verify(lun);
    expect(fetches).toBeGreaterThan(0);
    expect(decision.outcome).not.toBe("same_cycle_resolved");
    expect(decision.drop).toBe(true);
  });
});
