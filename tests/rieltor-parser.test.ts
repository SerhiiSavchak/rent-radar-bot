import { describe, expect, it } from "vitest";
import {
  buildRieltorSearchUrl,
  inspectRieltorHtml,
  parseDeclaredCount,
  sliceMainCatalog,
} from "../src/sources/rieltor/rieltor.parser.ts";

const ownerPage = catalogPage({
  title: "Зняти квартиру в Львові без посередників — Оренда квартир - RIELTOR.UA",
  heading: "Оренда квартир в Львові без посередників",
  count: "3 оголошення",
  path: "/lvov/flats-rent/",
  primary: [ownerCard()],
  extras: [realtorCard()],
});

const realtorPage = catalogPage({
  title: "Зняти квартиру в Львові, оренда квартир - RIELTOR.UA",
  heading: "Оренда квартир в Львові",
  count: "743 оголошення",
  path: "/lvov/flats-rent/",
  primary: [realtorCard(), ownerCard()],
  extras: [],
  jsonLd: true,
});

const emptyHousesOwners = catalogPage({
  title: "Зняти будинок в Львові без посередників — Оренда будинків довготривало - RIELTOR.UA",
  heading: "Оренда будинків в Львові без посередників (довготривало)",
  count: "За вашим запитом пропозицій не знайдено",
  path: "/lvov/houses-rent/",
  primary: [],
  extras: [realtorCard({ id: "999000", path: "/lvov/houses-rent/" })],
});

describe("RIELTOR parser", () => {
  it("builds Lviv routes and owner query without silently dropping the city prefix", () => {
    expect(buildRieltorSearchUrl("apartment")).toBe("https://rieltor.ua/lvov/flats-rent/");
    expect(buildRieltorSearchUrl("house", 2, true)).toBe(
      "https://rieltor.ua/lvov/houses-rent/?f-owners=1&page=2",
    );
  });

  it("uses the platform Власник label as owner evidence and ignores recommended extras", () => {
    const inspection = inspectRieltorHtml(ownerPage, {
      category: "apartment",
      pageUrl: "https://rieltor.ua/lvov/flats-rent/?f-owners=1",
    });
    expect(inspection.resultKind).toBe("ok");
    expect(inspection.listings).toHaveLength(1);
    expect(inspection.listings[0]?.sellerType).toBe("owner");
    expect(inspection.listings[0]?.sourceId).toBe("13043370");
    expect(inspection.listings[0]?.location.latitude).toBeCloseTo(49.809883117676);
    expect(inspection.listings[0]?.sellerEvidence?.some((item) => item.includes("Власник"))).toBe(
      true,
    );
  });

  it("uses the platform Рієлтор label as agent, not description text", () => {
    const inspection = inspectRieltorHtml(realtorPage, {
      category: "apartment",
      pageUrl: "https://rieltor.ua/lvov/flats-rent/",
    });
    const realtor = inspection.listings.find((item) => item.sourceId === "12966053");
    expect(realtor?.sellerType).toBe("agent");
    expect(realtor?.publishedAt).toBeInstanceOf(Date);
    expect(realtor?.publishedAt && Number.isNaN(realtor.publishedAt.getTime())).toBe(false);
    expect(realtor?.metadata?.timestampPrecision).toBe(
      "jsonld_availabilityStarts_seconds_unknown_semantics",
    );
  });

  it("keeps unrecognized role labels as unknown", () => {
    const html = catalogPage({
      title: "Зняти квартиру в Львові, оренда квартир - RIELTOR.UA",
      heading: "Оренда квартир в Львові",
      count: "1 оголошення",
      path: "/lvov/flats-rent/",
      primary: [
        ownerCard({
          id: "1",
          label: "Партнер",
          latitude: "49.84",
          longitude: "24.03",
        }),
      ],
      extras: [],
    });
    const inspection = inspectRieltorHtml(html, {
      category: "apartment",
      pageUrl: "https://rieltor.ua/lvov/flats-rent/",
    });
    expect(inspection.listings[0]?.sellerType).toBe("unknown");
    expect(inspection.listings[0]?.metadata?.filterConsidersPrivateOwner).toBe(false);
  });

  it("treats missing catalog markers as parser failure, not an empty market", () => {
    const inspection = inspectRieltorHtml(
      "<html><head><title>Оренда квартир в Львові</title></head><body>no listings</body></html>",
      {
        category: "apartment",
        pageUrl: "https://rieltor.ua/lvov/flats-rent/",
      },
    );
    expect(inspection.resultKind).toBe("parser_failure");
    expect(inspection.listings).toHaveLength(0);
    expect(inspection.hasCatalog).toBe(false);
    expect(inspection.locationResolved).toBe(true);
  });

  it("treats a structured zero-result catalog as valid empty even if extras exist", () => {
    const inspection = inspectRieltorHtml(emptyHousesOwners, {
      category: "house",
      pageUrl: "https://rieltor.ua/lvov/houses-rent/?f-owners=1",
    });
    expect(parseDeclaredCount(emptyHousesOwners)).toBe(0);
    expect(sliceMainCatalog(emptyHousesOwners)).toBeDefined();
    expect(inspection.resultKind).toBe("valid_empty");
    expect(inspection.listings).toHaveLength(0);
    expect(inspection.emptyMarket).toBe(true);
  });

  it("marks a partial first page as truncated instead of a complete scan", () => {
    const inspection = inspectRieltorHtml(realtorPage, {
      category: "apartment",
      pageUrl: "https://rieltor.ua/lvov/flats-rent/",
    });
    expect(inspection.declaredCount).toBe(743);
    expect(inspection.truncated).toBe(true);
  });

  it("refuses a non-Lviv fallback city", () => {
    const html = catalogPage({
      title: "Зняти квартиру в Києві - RIELTOR.UA",
      heading: "Оренда квартир в Києві",
      count: "10 оголошення",
      path: "/kiev/flats-rent/",
      primary: [ownerCard()],
      extras: [],
    });
    const inspection = inspectRieltorHtml(html, {
      category: "apartment",
      pageUrl: "https://rieltor.ua/kiev/flats-rent/",
    });
    expect(inspection.resultKind).toBe("parser_failure");
    expect(inspection.locationResolved).toBe(false);
    expect(inspection.listings).toHaveLength(0);
  });

  it("preserves relative card dates as uncertain when JSON-LD is absent", () => {
    const inspection = inspectRieltorHtml(ownerPage, {
      category: "apartment",
      pageUrl: "https://rieltor.ua/lvov/flats-rent/?f-owners=1",
    });
    expect(inspection.listings[0]?.publishedAt).toBeUndefined();
    expect(inspection.listings[0]?.metadata?.publishedLabel).toBe("сьогодні");
    expect(inspection.listings[0]?.metadata?.coordinatePrecision).toBe("unspecified_point");
  });
});

function ownerCard(
  overrides: {
    id?: string;
    label?: string;
    latitude?: string;
    longitude?: string;
    path?: string;
  } = {},
): string {
  const id = overrides.id ?? "13043370";
  const path = overrides.path ?? "/lvov/flats-rent/";
  return `
<div class="catalog-card " data-catalog-item-id="${id}" data-longitude="${overrides.longitude ?? "24.063571929932"}" data-latitude="${overrides.latitude ?? "49.809883117676"}">
  <a href="https://rieltor.ua${path}view/${id}/" class="catalog-card-media"></a>
  <div class="catalog-card-price-title lun-identity-font">570 $/міс</div>
  <h2 class="catalog-card-address">Зелена вул., 10</h2>
  <h2 class="catalog-card-region">Львів , Сихівський р-н</h2>
  <div class="catalog-card-update"><span>сьогодні</span></div>
  <div class="catalog-card-author-subtitle"><span>${overrides.label ?? "Власник"}</span></div>
</div>`;
}

function realtorCard(
  overrides: { id?: string; path?: string } = {},
): string {
  const id = overrides.id ?? "12966053";
  const path = overrides.path ?? "/lvov/flats-rent/";
  return `
<div class="catalog-card " data-catalog-item-id="${id}" data-longitude="24.030723571777344" data-latitude="49.86826705932617">
  <a href="https://rieltor.ua${path}view/${id}/" class="catalog-card-media"></a>
  <div class="catalog-card-price-title lun-identity-font">750 $/міс</div>
  <h2 class="catalog-card-address">Анатолія Лупиноса вул., 22</h2>
  <h2 class="catalog-card-region">Львів , Галицький р-н</h2>
  <div class="catalog-card-update"><span>4 тиж. тому</span></div>
  <div class="catalog-card-author-subtitle"><span>Рієлтор</span></div>
  <div class="catalog-card-author-company"><button>PRODIM</button></div>
</div>`;
}

function catalogPage(input: {
  title: string;
  heading: string;
  count: string;
  path: string;
  primary: string[];
  extras: string[];
  jsonLd?: boolean;
}): string {
  const jsonLd = input.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify({
        "@type": "ItemList",
        numberOfItems: 743,
        itemListElement: [
          {
            "@type": "ListItem",
            item: {
              url: "https://rieltor.ua/lvov/flats-rent/view/12966053/",
              name: "Анатолія Лупиноса вул., 22",
              geo: { latitude: 49.86826705932617, longitude: 24.030723571777344 },
              address: { addressLocality: "Львів" },
              offers: {
                price: 750,
                priceCurrency: "USD",
                availabilityStarts: "2026-09-12 17:21:14",
              },
            },
          },
        ],
      })}</script>`
    : "";
  return `<!doctype html>
<html lang="uk">
<head>
  <title>${input.title}</title>
  <link rel="canonical" href="https://rieltor.ua${input.path}">
</head>
<body>
  <h1><span data-listing-title>${input.heading}</span></h1>
  <span data-listing-count>${input.count}</span>
  ${jsonLd}
  <div data-listing-items>${input.primary.join("\n")}</div>
  <div data-listing-add-items>${input.extras.join("\n")}</div>
</body>
</html>`;
}
