import { extractInitialStateJson, parseDomriaCatalog } from "../sources/domria/domria.parser.ts";
import { inspectLunHtml } from "../sources/lun/lun.parser.ts";
import { parseOlxOffersPayload } from "../sources/olx/olx.parser.ts";
import { inspectRieltorHtml } from "../sources/rieltor/rieltor.parser.ts";
import type { Listing } from "../domain/listing.ts";
import type { FetchResultKind } from "../domain/source.ts";

export type FixtureParseResult = {
  source: string;
  fixture: string;
  bytes: number;
  elapsedMs: number;
  resultKind: FetchResultKind;
  extracted: number;
  accepted: number;
  sellerTypes: Record<string, number>;
  cities: string[];
  propertyTypes: Record<string, number>;
  withCoordinates: number;
};

function tally(listings: Listing[]): Pick<
  FixtureParseResult,
  "sellerTypes" | "cities" | "propertyTypes" | "withCoordinates" | "accepted"
> {
  const sellerTypes: Record<string, number> = {};
  const propertyTypes: Record<string, number> = {};
  const cities = new Set<string>();
  let withCoordinates = 0;
  for (const listing of listings) {
    sellerTypes[listing.sellerType] = (sellerTypes[listing.sellerType] ?? 0) + 1;
    propertyTypes[listing.propertyType] = (propertyTypes[listing.propertyType] ?? 0) + 1;
    if (listing.location.city) {
      cities.add(listing.location.city);
    }
    if (listing.location.latitude !== undefined && listing.location.longitude !== undefined) {
      withCoordinates += 1;
    }
  }
  return {
    accepted: listings.length,
    sellerTypes,
    cities: [...cities],
    propertyTypes,
    withCoordinates,
  };
}

function timed(source: string, fixture: string, body: string, run: () => { listings: Listing[]; resultKind: FetchResultKind; extracted: number }): FixtureParseResult {
  const started = Date.now();
  const result = run();
  return {
    source,
    fixture,
    bytes: new TextEncoder().encode(body).length,
    elapsedMs: Date.now() - started,
    resultKind: result.resultKind,
    extracted: result.extracted,
    ...tally(result.listings),
  };
}

export function olxRepresentativePayload(): string {
  const data = [
    {
      id: 1001,
      title: "Оренда квартири",
      url: "https://www.olx.ua/d/uk/obyavlenie/kv-IDabc123.html",
      created_time: "2026-09-15T21:00:00+03:00",
      last_refresh_time: "2026-09-15T21:05:00+03:00",
      business: false,
      params: [{ key: "price", value: { value: 15000, currency: "UAH" } }],
      location: { city: { id: 176, name: "Львів" }, district: { name: "Галицький" } },
      map: { lat: 49.8397, lon: 24.0297, radius: 1 },
      category: { id: 1760 },
    },
    {
      id: 1002,
      title: "Оренда будинку Солонка",
      url: "https://www.olx.ua/d/uk/obyavlenie/house-ID11gqaj.html",
      created_time: "2026-09-14T18:19:11+03:00",
      business: true,
      location: { city: { id: 38731, name: "Солонка" } },
      map: { lat: 49.75413, lon: 24.01337, radius: 1 },
      category: { id: 330 },
    },
  ];
  return JSON.stringify({ data });
}

export function olxWidePayload(count = 40): string {
  const data = Array.from({ length: count }, (_, index) => ({
    id: 2000 + index,
    title: index % 2 === 0 ? "Оренда квартири" : "Оренда будинку",
    url: `https://www.olx.ua/d/uk/obyavlenie/item-ID${index}.html`,
    created_time: "2026-09-15T12:00:00+03:00",
    business: index % 5 === 0,
    location: { city: { id: 176, name: "Львів" } },
    map: { lat: 49.84, lon: 24.03, radius: 2 },
    category: { id: index % 2 === 0 ? 1760 : 330 },
  }));
  return JSON.stringify({ data });
}

export function rieltorCatalogHtml(cardCount: number, paddingBytes = 0): string {
  const cards = Array.from({ length: cardCount }, (_, index) => {
    const id = 13000000 + index;
    const owner = index % 7 === 0;
    return `<div class="catalog-card " data-catalog-item-id="${id}" data-longitude="24.0297" data-latitude="49.8397">
  <a href="https://rieltor.ua/lvov/flats-rent/view/${id}/" class="catalog-card-media"></a>
  <div class="catalog-card-price-title lun-identity-font">500 $/міс</div>
  <h2 class="catalog-card-address">Тестова вул., ${index + 1}</h2>
  <h2 class="catalog-card-region">Львів , Галицький р-н</h2>
  <div class="catalog-card-update"><span>сьогодні</span></div>
  <div class="catalog-card-author-subtitle"><span>${owner ? "Власник" : "Рієлтор"}</span></div>
</div>`;
  });
  const padding =
    paddingBytes > 0
      ? `<div class="padding">${"<img alt='' src='https://example.invalid/p.jpg'/>".repeat(
          Math.ceil(paddingBytes / 52),
        )}</div>`
      : "";
  return `<!doctype html><html lang="uk"><head>
<title>Оренда квартир в Львові - RIELTOR.UA</title>
<link rel="canonical" href="https://rieltor.ua/lvov/flats-rent/">
</head><body>
<h1><span data-listing-title>Оренда квартир в Львові</span></h1>
<span data-listing-count>${cardCount} оголошення</span>
<div data-listing-items>${cards.join("\n")}</div>
<div data-listing-add-items></div>
${padding}
</body></html>`;
}

export function lunRscHtml(): string {
  const inner = JSON.stringify({
    realties: {
      cards: [
        {
          id: 4723362979,
          urlRaw: "https://www.olx.ua/d/uk/obyavlenie/test-IDabc123.html",
          insertTime: "2026-09-13T13:35:15",
          price: 550,
          currency: "usd",
          isOwner: true,
          withoutCommission: true,
          agency: null,
          location: [24.0234476, 49.774733],
          sectionId: 2,
          text: "Оренда",
          header: "вулиця Тестова",
        },
      ],
    },
  });
  const encoded = JSON.stringify(inner).slice(1, -1);
  return `<html><head><title>LUN Львів</title></head><body><script>self.__next_f.push([1,"${encoded}"])</script></body></html>`;
}

export function domriaCatalogHtml(): string {
  const state = {
    catalog: {
      realtyForCatalog: [
        {
          realty_id: 34690408,
          beautiful_url: "realty-dolgosrochnaya-arenda-kvartira-lvov-test-34690408.html",
          city_name_uk: "Львів",
          street_name_uk: "вул. Тестова",
          latitude: 49.837,
          longitude: 24.008,
          price: 12000,
          currency_type: "грн",
          publishing_date: "2026-09-12 15:58:26",
          realty_type_id: 2,
          agency_id: 0,
          characteristics_values: { "1437": 1436 },
          description_uk: "Квартира",
        },
      ],
    },
  };
  return `<html><head><title>DIM.RIA Львів</title></head><body><script>__INITIAL_STATE__=${JSON.stringify(state)}</script></body></html>`;
}

export function largestAvailableFixture(): { name: string; body: string } {
  const representative = rieltorCatalogHtml(20, 1_200_000);
  return { name: "rieltor-20-cards-plus-1_2MiB-img-padding", body: representative };
}

export function runAllFixtureParses(): FixtureParseResult[] {
  const olxSmall = olxRepresentativePayload();
  const olxWide = olxWidePayload(40);
  const rieltorPage = rieltorCatalogHtml(20);
  const largest = largestAvailableFixture();
  const lun = lunRscHtml();
  const domria = domriaCatalogHtml();

  return [
    timed("olx", "representative-2-offers", olxSmall, () => {
      const listings = parseOlxOffersPayload(JSON.parse(olxSmall) as unknown);
      return { listings, resultKind: listings.length > 0 ? "ok" : "valid_empty", extracted: listings.length };
    }),
    timed("olx", "wide-40-offers", olxWide, () => {
      const listings = parseOlxOffersPayload(JSON.parse(olxWide) as unknown);
      return { listings, resultKind: listings.length > 0 ? "ok" : "valid_empty", extracted: listings.length };
    }),
    timed("rieltor", "catalog-20-cards", rieltorPage, () => {
      const inspection = inspectRieltorHtml(rieltorPage, {
        category: "apartment",
        pageUrl: "https://rieltor.ua/lvov/flats-rent/",
      });
      return {
        listings: inspection.listings,
        resultKind: inspection.resultKind,
        extracted: inspection.extractedCardCount,
      };
    }),
    timed("rieltor", largest.name, largest.body, () => {
      const inspection = inspectRieltorHtml(largest.body, {
        category: "apartment",
        pageUrl: "https://rieltor.ua/lvov/flats-rent/",
      });
      return {
        listings: inspection.listings,
        resultKind: inspection.resultKind,
        extracted: inspection.extractedCardCount,
      };
    }),
    timed("lun", "rsc-one-card", lun, () => {
      const inspection = inspectLunHtml(lun);
      return {
        listings: inspection.listings,
        resultKind: inspection.resultKind,
        extracted: inspection.rawCardCount,
      };
    }),
    timed("domria", "initial-state-one-listing", domria, () => {
      const listings = parseDomriaCatalog(extractInitialStateJson(domria));
      return { listings, resultKind: listings.length > 0 ? "ok" : "parser_failure", extracted: listings.length };
    }),
  ];
}
