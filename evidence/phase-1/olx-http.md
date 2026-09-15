# OLX ordinary HTTP

Bypass / proxies / CAPTCHA / headed browser: **not used** in any probe below.

## Environment 1: Windows Node.js `fetch` (this workstation)

Date: 2026-09-15, command `npm run live:olx`, default Chrome-like User-Agent from `src/utils/http.ts`.

`resultKind=http_error`, listings=0, overall verdict FAIL.

| URL | HTTP | Body |
|-----|------|------|
| `api/v1/offers` apartments `category_id=1760` | **403** | CloudFront HTML (`server=CloudFront`, `x-cache=Error from cloudfront`) |
| `api/v1/offers` houses (then `category_id=1758`) | **200** | JSON `{"data":[],...}` — empty (see root cause below) |
| HTML Lviv long-term apartments | **403** | CloudFront HTML |

Retested the same evening with **corrected** query params (`region_id=5&city_id=176`):
still **403** CloudFront. The block on this workstation is per-environment, not per-query.

## Environment 2: isolated fetch server (non-residential), 2026-09-15 ~21:35–21:50 EEST

Ordinary GET requests to the same public endpoints, no special headers, no bypass.

| Probe | Result |
|-------|--------|
| `api/v1/offers` apartments, old params `region_id=12&city_id=13` | **200 JSON, `data:[]`** — response targeting shows `region=lug, subregion=krasnodon`: the old hardcoded ids point at **Краснодон, Луганська обл.**, not Lviv |
| `api/v1/geo-encoder/regions/` | 200; **5 = Львівська область** (12 = Черкаська) |
| `api/v1/geo-encoder/regions/5/cities/` | 200; **176 = Львів** (13 = Краснодон) |
| apartments `category_id=1760&region_id=5&city_id=176` | **200, 8 real listings**, `total_elements=1000`, fresh records created the same evening (21:07) |
| old houses `category_id=1758` with Lviv ids | 200 but returns **«Продаж квартир»** (sales) — wrong category |
| houses `category_id=330&region_id=5&city_id=176&distance=15` | **200, real long-term house rentals**, `total_elements=80`, suburbs included (Солонка, Сокільники, Брюховичі, Зимна Вода, Великий Дорошів) |
| `distance=15` | verified to expand the search ~15 km around Lviv; suburbs have their own `city_id`s, so `city_id=176` alone under-covers the radius |
| single offer `api/v1/offers/934822999` | 200; contains `category.id`, `business`, `user.created`, `map{lat,lon,radius}`, `created_time` + `last_refresh_time` |

### Repeat / freshness validation (same environment)

- Identical apartments query run at ~21:37 and ~21:47 (≈10 min apart): both 200 with live
  windows; 4 of 8 ids shared, the promoted carousel rotated; distinct `search_id` values, so
  responses are not a shared cache.
- A 52-record window fetched at ~21:47 contained a listing created at **21:30:14** the same
  evening → the public API surfaces new listings within minutes.
- Each fetch from this environment is an independent process; a long-lived-session test and a
  multi-day soak from a runtime we control are still **not done**.

### URL token caveat (identity matching)

The `ID<token>.html` URL suffix looks like base62 of the numeric id and matched exactly on
3 sampled records, but a 4th record disproved the mapping (offer 934944232 carries token
`11gWHG`, offer 934948076 carries token `11gVHG`). **Match identities by comparing the token
string** (`extractOlxUrlToken`), never by decoding it to a numeric id.

## Conclusions

1. The CloudFront 403 is **specific to some environments** (this workstation), not a universal
   OLX property: ordinary unauthenticated HTTP worked from the isolated fetch server with zero
   anti-bot measures.
2. The previously recorded "houses 200 empty" was **not** WAF behaviour — the hardcoded query
   pointed at Краснодон with a sales category. Fixed in `src/sources/olx/olx.source.ts`
   (region 5, city 176, categories 1760/330, `distance=15`) with regression tests.
3. What remains unproven: that a specific **hosted zero-cost runtime** (e.g. Oracle Always
   Free) is among the environments OLX does not block, and stability over days. That requires
   running `npm run live:olx` from such a host.
