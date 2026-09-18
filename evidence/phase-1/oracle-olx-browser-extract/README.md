# Oracle OLX browser extract — status

## Live Oracle after `219316f` — original document available, adapter rejected ads

Live probe on `219316f` showed the original navigation HTML and listing state are present:

- `htmlInputKind=main_document`
- `hasPrerenderedState=true`, `prerenderedStateComplete=true`, `prerenderedAdsPathFound=true`
- apartments `rawObjectCount=51`, houses `rawObjectCount=38`
- `uniqueIdCount=0`, `normalizedListingCount=0`
- every candidate lumped as `embedded_offers_partial_schema_failure`
- accessibility succeeded; extraction failed; `browserClosed=true`

Root cause (from the captured `listing.listing.ads` objects, not fixtures): catalog `photos` is a `string[]` of CDN URLs (`ireland.apollo.olxcdn.com:443/...`). The adapter copied that array as-is into a Zod schema that expected `{ link }` objects, so every offer failed `safeParse`.

**Do not claim live OLX success. Do not wire OLX into Telegram** until a live Oracle extract reports `validatedListingCount > 0` after this parser change.

## What the extractor reads now

- **Parser input:** original Playwright navigation body first (`htmlInputKind=main_document`). Rendered DOM is fallback only when that document has no structured state.
- Quoted `__PRERENDERED_STATE__` is decoded with `JSON.parse` only (no `eval`).
- Catalog camelCase ads are adapted: `id`, `title`, `url`/`urlPath`, `category`, `location.cityName`, `price.regularPrice`, `createdTime` → `publishedAt`, `lastRefreshTime` / `pushupTime` kept separate, `photos` string URLs normalized to `{ link }`.
- `isBusiness=false` = private account, **not** verified property ownership (`sellerType=unknown`).
- `map.show_detailed=false` is recorded as approximate coordinates.
- Evidence JSON keeps `uniqueRawIdCount`, `uniqueIdCount`, `rejectionReasonCounts`, and a sample of `candidateRejections`.
- A category deadline after a successful parse is reported as `timedOut` / `post_extract_deadline` without flipping a validated extract to parser failure.

Offline fixtures for this adapter are labeled **derived** from the Oracle capture; they include sanitized `string[]` photos matching the live catalog shape.
