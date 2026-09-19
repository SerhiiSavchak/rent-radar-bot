/**
 * Minimized fixtures DERIVED from the Oracle capture at commit
 * baab3230824bc4e976cae50c6ad2c9ded2e91467 (capture-1789666022490).
 *
 * Not a dump of the live page. Field names/shapes match decodedState.listing.listing.ads.
 * Descriptions and user avatars are omitted. `photos` keeps the live catalog
 * shape (`string[]` CDN URLs), which previously failed Zod `{ link }` validation.
 */

export type DerivedOlxCatalogAd = {
  id: number;
  title: string;
  url: string;
  category: { id: number; type: string };
  createdTime: string;
  lastRefreshTime: string;
  pushupTime: string | null;
  isBusiness: boolean;
  price: {
    regularPrice: { value: number; currencyCode: string };
  };
  location: {
    cityName: string;
    cityId: number;
    regionName: string;
    regionId: number;
    districtName?: string;
  };
  map: { lat: number; lon: number; radius: number; show_detailed: boolean; zoom: number };
  user: {
    id: number;
    name: string;
    company_name: string;
    sellerType: string | null;
  };
  params: Array<{ key: string; name?: string; value?: unknown; normalizedValue?: string }>;
  urlPath: string;
  photos: string[];
};

export function derivedOracleApartmentPrivateAd(): DerivedOlxCatalogAd {
  return {
    id: 935081899,
    title: "Оренда 2x кімнатної квартири",
    url: "https://www.olx.ua/d/uk/obyavlenie/orenda-2x-kmnatno-kvartiri-ID11hwv7.html",
    category: { id: 1760, type: "real_estate" },
    createdTime: "2026-09-17T08:34:26+03:00",
    lastRefreshTime: "2026-09-17T08:40:09+03:00",
    pushupTime: null,
    isBusiness: false,
    price: { regularPrice: { value: 53650, currencyCode: "UAH" } },
    location: {
      cityName: "Львів",
      cityId: 176,
      regionName: "Львівська область",
      regionId: 5,
      districtName: "Шевченківський",
    },
    map: { lat: 49.839, lon: 23.995, radius: 1, show_detailed: false, zoom: 13 },
    user: { id: 2018417314, name: "Мар'яна", company_name: "", sellerType: null },
    params: [{ key: "commission", name: "Без комісії", value: null, normalizedValue: "1" }],
    urlPath: "/d/uk/obyavlenie/orenda-2x-kmnatno-kvartiri-ID11hwv7.html",
    photos: ["https://ireland.apollo.olxcdn.com:443/v1/files/derived-private-apt-UA/image;s=1000x750"],
  };
}

export function derivedOracleApartmentBusinessAd(): DerivedOlxCatalogAd {
  return {
    id: 931996810,
    title: "Оренда стильної 1-кімнатної квартири",
    url: "https://www.olx.ua/d/uk/obyavlenie/orenda-stilno-1-kmnatno-kvartiri-po-pr-v-chornovola-ID114yVC.html",
    category: { id: 1760, type: "real_estate" },
    createdTime: "2026-08-17T01:13:35+03:00",
    lastRefreshTime: "2026-09-17T10:27:55+03:00",
    pushupTime: "2026-09-17T10:27:55+03:00",
    isBusiness: true,
    price: { regularPrice: { value: 30000, currencyCode: "UAH" } },
    location: {
      cityName: "Львів",
      cityId: 176,
      regionName: "Львівська область",
      regionId: 5,
      districtName: "Шевченківський",
    },
    map: { lat: 49.839, lon: 23.995, radius: 1, show_detailed: false, zoom: 13 },
    user: { id: 6223479, name: "Дмитро", company_name: "", sellerType: null },
    params: [{ key: "cooperate", name: "Готовий співпрацювати з ріелторами", normalizedValue: "1" }],
    urlPath: "/d/uk/obyavlenie/orenda-stilno-1-kmnatno-kvartiri-po-pr-v-chornovola-ID114yVC.html",
    photos: ["https://ireland.apollo.olxcdn.com:443/v1/files/derived-business-apt-UA/image;s=1000x750"],
  };
}

/**
 * Extra catalog keys observed on a real baab323 / live-shape apartment ad.
 * Descriptions, phones, avatars and the original photo set are omitted.
 */
export function derivedOracleApartmentLiveShapeAd(): Record<string, unknown> {
  return {
    ...derivedOracleApartmentBusinessAd(),
    description: "Sanitized derived catalog description.",
    isHighlighted: true,
    isPromoted: true,
    promotion: {
      highlighted: true,
      top_ad: true,
      options: ["bundle_optimum"],
      premium_ad_page: false,
      urgent: false,
      b2c_ad_page: false,
    },
    externalUrl: null,
    protectPhone: false,
    validToTime: "2026-10-17T01:13:35+03:00",
    isActive: true,
    status: "active",
    itemCondition: null,
    salary: null,
    partner: null,
    isJob: false,
    shop: null,
    safedeal: null,
    searchReason: null,
    isGpsrAvailable: false,
    payAndShip: null,
    isNewFavouriteAd: false,
  };
}

export function derivedOracleHousePrivateAd(): DerivedOlxCatalogAd {
  return {
    id: 924128798,
    title: "Здається в оренду будинок від власника.",
    url: "https://www.olx.ua/d/uk/obyavlenie/zdatsya-v-orendu-budinok-vd-vlasnika-ID10xy7c.html",
    category: { id: 330, type: "real_estate" },
    createdTime: "2026-05-22T11:45:42+03:00",
    lastRefreshTime: "2026-09-17T13:47:30+03:00",
    pushupTime: null,
    isBusiness: false,
    price: { regularPrice: { value: 44708, currencyCode: "UAH" } },
    location: {
      cityName: "Львів",
      cityId: 176,
      regionName: "Львівська область",
      regionId: 5,
      districtName: "Залізничний",
    },
    map: { lat: 49.839, lon: 23.996, radius: 1, show_detailed: false, zoom: 13 },
    user: { id: 108193232, name: "Андрій", company_name: "", sellerType: null },
    params: [{ key: "commission", name: "Без комісії", normalizedValue: "1" }],
    urlPath: "/d/uk/obyavlenie/zdatsya-v-orendu-budinok-vd-vlasnika-ID10xy7c.html",
    photos: ["https://ireland.apollo.olxcdn.com:443/v1/files/derived-private-house-UA/image;s=1000x750"],
  };
}

export function wrapQuotedPrerenderedAds(ads: unknown[]): string {
  const state = { listing: { listing: { ads } } };
  return JSON.stringify(JSON.stringify(state));
}

export function derivedOracleMainDocumentHtml(ads: unknown[]): string {
  const encoded = wrapQuotedPrerenderedAds(ads);
  const first = ads[0] as { url?: string } | undefined;
  return `<!DOCTYPE html><html lang="uk"><head><title>OLX</title></head><body>
<div data-cy="l-card"><a href="${first?.url ?? "/d/uk/obyavlenie/x-ID11aaaa.html"}">card</a></div>
<script>window.__PRERENDERED_STATE__ = ${encoded};</script>
</body></html>`;
}

export function derivedOracleRenderedHtmlWithoutState(ads: unknown[]): string {
  const first = ads[0] as { url?: string } | undefined;
  return `<!DOCTYPE html><html lang="uk"><head><title>OLX</title></head><body>
<div data-cy="l-card"><a href="${first?.url ?? "/d/uk/obyavlenie/x-ID11aaaa.html"}">card</a></div>
</body></html>`;
}

/** Truncated quoted assignment — not a successful full-state parse. */
export function derivedOracleTruncatedMainDocumentHtml(): string {
  const complete = wrapQuotedPrerenderedAds([derivedOracleApartmentBusinessAd()]);
  const cut = complete.slice(0, Math.floor(complete.length / 3));
  return `<!DOCTYPE html><html><body>
<div data-cy="l-card">card</div>
<script>window.__PRERENDERED_STATE__ = ${cut}</script>
</body></html>`;
}

export function derivedOracleMalformedPrerenderedHtml(): string {
  return `<!DOCTYPE html><html><body>
<div data-cy="l-card">card</div>
<script>window.__PRERENDERED_STATE__ = "{not-json";</script>
</body></html>`;
}
