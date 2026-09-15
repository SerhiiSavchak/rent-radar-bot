# Source research (Phase 0)

Tested: **2026-09-13** from a Node.js 24 HTTP client (ordinary `curl`/`fetch`, no proxies, no CAPTCHA bypass, no fingerprint spoofing).

Lviv search intent: long-term rent, apartments and houses, city + ~15 km, prefer owners.

---

## OLX

Current date tested: 2026-09-13

Access method: ordinary Node/curl GET to public HTML and to `https://www.olx.ua/api/v1/offers/` (the JSON endpoint the website is widely reported to use). Official Partner API (`developer.olx.ua`, OAuth) exists for **advertisers managing their own ads**, not for searching third-party rentals.

Official API available for this use case: **No** (Partner API is not a rental search API).

Authentication required: none attempted for public search; Partner API would require partner credentials.

Live test result: **FAIL** (ordinary Node HTTP). During one aggregated run, `category_id=1758` briefly returned HTTP 200 `application/json` from nginx with **zero parsed offers**; a follow-up curl of the same URL was **403**. Treat 200 as unstable, not as a working integration.

HTTP status: **403** for apartment HTML and `category_id=1760`. One house-category request (`category_id=1758`, Lviv ids assumed, **unverified**) returned HTTP **200** with `{"data":[],"metadata":{"total_elements":0,...}}` — empty, not usable listings. Follow-up curl of the same URL was sometimes **403**. Category IDs are therefore unconfirmed.

Listings returned: **0**

Seller type available: unknown in this environment (OLX payloads typically include a `business` flag; not observed live)

Publication date available: not observed live

Coordinates available: not observed live

Pagination: not observed live

Rate limit: not reached; requests were blocked before application logic

Anti-bot behavior observed: CloudFront 403 on datacenter-like Node HTTP with a normal Chrome User-Agent. No challenge HTML body beyond CloudFront error page.

Reliability assessment: **LOW**

Maintenance risk: **HIGH** — even if it works from a residential IP today, WAF policy can change without notice.

Recommended production approach: do **not** depend on OLX scraping. If OLX is mandatory, only a legally contracted data/partner channel would be acceptable. Playwright was **not** adopted as architecture; it would still hit the same WAF and would be a production cost/reliability risk.

---

## DIM.RIA

Current date tested: 2026-09-13

Access method:

1. Official API `https://developers.ria.com/dom/search` and `/dom/info/{id}` — documented at https://developers.ria.com/docs/ ; **API key required**.
2. Public website HTML `https://dom.ria.com/uk/arenda-kvartir/lvov/` and `.../arenda-domov/lvov/` — HTTP 200, listings in `window.__INITIAL_STATE__.catalog.realtyForCatalog`.

Official API available for this use case: **Yes** (search + listing info; `exclude_agencies`; `characteristic[1437]` offer type; coordinates on info payload).

Authentication required: `api_key` query parameter. Unauthenticated search returned HTTP **403** JSON:

```json
{"error":{"code":"API_KEY_MISSING","message":"No api_key was supplied. Get one at https://developers.ria.com"}}
```

Live test result: **PASS** via public HTML embedded JSON (official API not used: no `DOMRIA_API_KEY` in this environment).

HTTP status: public HTML **200**; official API without key **403**

Listings returned: apartments catalog **20** objects on the first search page; houses catalog **7** on the first houses page (counts from 2026-09-13 HTML).

Seller type available: **Yes**, evidence-based:

- `characteristics_values["1437"]`: `1436` = від власника, `1434` = від посередника, plus developer values
- `agency_id` (non-zero ⇒ agency)

Publication date available: **Yes** (`publishing_date`)

Coordinates available: **Yes** (`latitude`, `longitude` in correct WGS84 order for Lviv)

Pagination: official API `page=`; public HTML is first catalog page only in Phase 0

Rate limit: official free tier documented as **30 requests/hour**, **1000/month**. Search returns IDs only, so hydrating N listings costs N+search calls.

Anti-bot behavior observed: public HTML allowed ordinary HTTP. Official API rejects missing keys cleanly.

Reliability assessment: **MEDIUM** for official API (documented, but quota-tight for naive polling). **MEDIUM** for HTML fallback (schema can change). Not HIGH: HTML is unofficial; free API quota is small.

Maintenance risk: **MEDIUM**

Recommended production approach: register at developers.ria.com, use official search+info, keep HTML as emergency fallback, respect `exclude_agencies` / characteristic 1436, use listing coordinates + Haversine for the 15 km radius. Do not harvest the frontend `search.apiKey` from HTML.

---

## LUN

Current date tested: 2026-09-13

Access method: public HTML

- `https://lun.ua/rent/lviv/flats` (rewrite: `geo_id=10012684&section_id=2`)
- `https://lun.ua/rent/lviv/flats-bez-poserednykiv` (`is_without_fee=true`)
- `https://lun.ua/rent/lviv/houses` (`section_id=4`). Slug `houses-bez-poserednykiv` returned **404** on 2026-09-13; owner preference for houses uses card `isOwner` on the general houses page.

JSON-LD `ItemList`/`RealEstateListing` is present. Richer card objects are in the Next.js `self.__next_f.push` RSC payload (`realties.cards`).

`developers.lun.ua` is a **new-build feed validator**, not a rental search API.

Official API available for this use case: **No**

Authentication required: no

Live test result: **PASS** (structured embedded data; not a stable public API)

HTTP status: **200** (after following HTTPS redirects; `/uk/rent/...` 301s to `/rent/...`)

Listings returned: JSON-LD `numberOfItems` 2756 flats / 162 no-fee flats / 163 houses; first page embeds **24** card objects

Seller type available: **Yes** on cards: `isOwner`, `agency`, `withoutCommission`, `rieltorContact`. `withoutCommission` is **not** treated as owner by itself.

Publication date available: card `insertTime` / `downloadTime` (platform ingest time, not necessarily original publication)

Coordinates available: **Yes**. Cards use GeoJSON-like `[longitude, latitude]`. JSON-LD `geo.latitude`/`geo.longitude` were **swapped** on 2026-09-13 (values ~24 / ~49). Adapter prefers card coordinates and has a swap guard.

Pagination: not implemented in Phase 0 (first page only). Total counts exist in JSON-LD.

Rate limit: unknown; Cloudflare in front, but HTML was served without a challenge for these few requests.

Anti-bot behavior observed: none for a handful of GETs. Cloudflare headers present (`cf-ray`). Aggressive crawling would likely trip protection.

Reliability assessment: **MEDIUM**

Maintenance risk: **HIGH** — RSC payload shape is unpublished and can break without notice; JSON-LD is more semantic but lacked listing URLs and had swapped coordinates.

Recommended production approach: keep parsing JSON-LD as a fallback, prefer `realties.cards` while it works, poll slowly, treat LUN as best-effort. Canonical URL `https://lun.ua/uk/realty/{id}` (many `urlRaw` values point at rieltor.ua).

---

## Comparison

| Source | Live access | Official API | Owner detection | Reliability | Maintenance risk |
|--------|-------------|--------------|-----------------|-------------|------------------|
| OLX | No (403) | No (not for search) | Unknown here | LOW | HIGH |
| DIM.RIA | Yes | Yes (key required) | Yes (characteristic 1437 + agency_id) | MEDIUM | MEDIUM |
| LUN | Yes | No | Yes (`isOwner`, not text-only) | MEDIUM | HIGH |
