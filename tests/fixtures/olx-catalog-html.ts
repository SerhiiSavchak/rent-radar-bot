/**
 * HTML fixtures for OLX browser/HTML structured extraction (no live network).
 */

export function olxCatalogHtmlWithPrerenderedOffers(options?: {
  includeSellerBusiness?: boolean;
  omitCreatedTime?: boolean;
  omitLocation?: boolean;
  omitMap?: boolean;
}): string {
  const includeSellerBusiness = options?.includeSellerBusiness ?? false;
  const omitCreatedTime = options?.omitCreatedTime ?? false;
  const omitLocation = options?.omitLocation ?? false;
  const omitMap = options?.omitMap ?? false;

  const ad = {
    id: 934944232,
    title: "Оренда 1-кімнатної квартири",
    url: "https://www.olx.ua/d/uk/obyavlenie/orenda-1-kimnatnoi-kvartiri-ID11gWHG.html",
    ...(omitCreatedTime ? {} : { created_time: "2026-09-15T10:00:00+03:00" }),
    last_refresh_time: "2026-09-16T10:00:00+03:00",
    business: includeSellerBusiness,
    params: [{ key: "price", value: { value: 14000, currency: "UAH" } }],
    ...(omitLocation
      ? {}
      : { location: { city: { name: "Львів" }, district: { name: "Галицький" } } }),
    ...(omitMap ? {} : { map: { lat: 49.84, lon: 24.03, radius: 1 } }),
    category: { id: 1760 },
  };

  const state = {
    listing: {
      listing: {
        ads: [ad],
      },
    },
  };
  // Live pages often use a JSON-string assignment; also emit object form via second fixture helper.
  const encoded = JSON.stringify(JSON.stringify(state));
  return `<!DOCTYPE html><html lang="uk"><head><title>OLX</title></head><body>
<div data-cy="l-card"><a href="${ad.url}">card</a></div>
<script id="olx-init-config">
window.__PRERENDERED_STATE__ = ${encoded};
</script>
</body></html>`;
}

export function olxCatalogHtmlWithPrerenderedObject(ads: unknown[]): string {
  const state = { listing: { listing: { ads } } };
  return `<!DOCTYPE html><html><body>
<script>window.__PRERENDERED_STATE__ = ${JSON.stringify(state)};</script>
</body></html>`;
}

export function olxCatalogHtmlWithMalformedPrerendered(): string {
  return `<!DOCTYPE html><html><body>
<div data-cy="l-card">card</div>
<script>window.__PRERENDERED_STATE__ = "{not-json</script>
</body></html>`;
}

export function olxCatalogHtmlCardsOnly(): string {
  return `<!DOCTYPE html><html><body>
<div data-cy="l-card" class="css-1sw7q4x listing-card">
  <a href="/d/uk/obyavlenie/test-ID11abcd.html">only card marker</a>
</div>
</body></html>`;
}

export function olxCatalogHtmlWithEmbeddedOffersApiShape(): string {
  const payload = {
    data: [
      {
        id: 111,
        title: "Квартира з API shape",
        url: "https://www.olx.ua/d/uk/obyavlenie/api-shape-ID11zzzz.html",
        created_time: "2026-09-15T12:00:00+03:00",
        business: false,
        params: [{ key: "price", value: { value: 11000, currency: "UAH" } }],
        location: { city: { name: "Львів" } },
      },
    ],
  };
  return `<!DOCTYPE html><html><body><script type="application/json">${JSON.stringify(payload)}</script></body></html>`;
}

export function olxCatalogHtmlWithNextDataOffers(): string {
  const next = {
    props: {
      pageProps: {
        offers: [
          {
            id: 222,
            title: "Будинок NextData",
            url: "https://www.olx.ua/d/uk/obyavlenie/house-ID11hhhh.html",
            created_time: "2026-09-14T18:00:00+03:00",
            business: true,
            params: [{ key: "price", value: { value: 25000, currency: "UAH" } }],
            location: { city: { name: "Солонка" } },
            map: { lat: 49.75, lon: 24.01, radius: 2 },
          },
        ],
      },
    },
  };
  return `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>
</body></html>`;
}
