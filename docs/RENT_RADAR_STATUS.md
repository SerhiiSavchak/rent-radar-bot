# Rent Radar status

Date: 2026-09-21  
Commit examined: `3fd4fbcc29e025af58215a0eb0a56989bbd8aa65` (`main`)  
Phase: source layer closure + project truth freeze

Repository code is the source of truth. Older notes in `docs/SOURCE_RESEARCH.md` and `docs/PHASE_1_DECISION.md` are historical.

## Architecture (actual path)

Two entry points exist.

1. `src/index.ts` — one-shot. `ListingMonitorService.collectNewListings()` filters, then `hasSeenListing` / `saveListing`, then `output.send`. A Telegram error after `saveListing` does not retry. This is not the durable delivery path.
2. `src/scripts/test-telegram-poll.ts` → `runTelegramTestCycle` in `src/delivery/telegram-test-pipeline.ts` — the restart-capable path. Per-source `try/catch`, SQLite baseline, freshness, and `telegram_outbox`. A failed source does not stop the others. A failed send stays retryable.

| Stage             | Files                                                                        | Behavior                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Source adapters   | `src/collection/create-source-adapters.ts`                                   | Domria, Lun, Rieltor on by default. OLX HTTP only if `ENABLE_OLX`. OLX browser only if `ENABLE_OLX_BROWSER`, and then HTTP is omitted. |
| Acquisition       | `src/utils/http.ts`; OLX browser in `src/sources/olx/olx-browser.extract.ts` | Node `fetch` with timeout and bounded retries. No proxy, no CAPTCHA solver.                                                            |
| Parse / normalize | `src/sources/*/ *.parser.ts`, `src/domain/listing.ts`                        | Zod-validated cards become `Listing`.                                                                                                  |
| Seller filter     | `src/filters/owner-filter.ts`                                                | Default `reject_intermediaries`. Unknown sellers pass. Platform agent/business and explicit intermediary evidence drop.                |
| Property filter   | `src/filters/property-type.ts`, `listing-filter.ts`                          | Apartment and house. Other types become `unknown` and fail the allow-list.                                                             |
| Geo               | `src/filters/location-filter.ts`                                             | Haversine around Lviv. Default radius 15 km. Missing coordinates are excluded (`GEO_UNKNOWN_POLICY=exclude`).                          |
| Dedup             | `src/delivery/listing-dedupe-memory.ts`, outbox fingerprint                  | Same source id / fingerprint only. No cross-source fuzzy drop.                                                                         |
| Persistence       | `src/storage/db.ts`, `durable-delivery-store.ts`, `migrations.ts`            | Local SQLite. Outbox statuses: pending, sending, sent, failed.                                                                         |
| Telegram          | `src/outputs/telegram.output.ts`, `telegram-test.sink.ts`                    | Durable path enqueues before send and marks sent only after success.                                                                   |

`POLL_INTERVAL_SECONDS` defaults to 120. The Telegram poller uses `TELEGRAM_POLL_INTERVAL_MS` (default 600000). `DOMRIA_POLL_INTERVAL_SECONDS` is not a separate scheduler.

## Subsystem status

| Subsystem              | Status                       | Evidence                                                                                                                                      |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| DIM.RIA acquisition    | PASS                         | Public HTML. 6/6 page fetches HTTP 200 on 2026-09-21 (20 flats, 8 houses). Adapter 3/3 `ok`, same 8 ids. Official API not called.             |
| LUN acquisition        | PASS                         | After the `imageId` string fix: flats 24/24 validated, houses 24/24, adapter 3/3 `ok`.                                                        |
| RIELTOR.UA acquisition | PASS                         | Three cycles spaced 25s: HTTP 200, `ok`, 6 real ids, coords/rooms/price/description. A back-to-back burst produced HTTP 429 and `http_error`. |
| OLX HTTP               | FAIL                         | 3/3 CloudFront 403. `resultKind=http_error`.                                                                                                  |
| OLX browser            | PASS as browser transport    | 3/3 stock Playwright, HTTP 200, 85 listings (48 flats + 37 houses), real ids. Classification `OLX_BROWSER_REQUIRED`.                          |
| Seller gate            | PASS for the permissive rule | Unknown is sent. Confirmed platform agent/business is dropped. Five-way enum is not stored.                                                   |
| Cross-source dedup     | NOT IN THIS BATCH            | LUN cluster fields are stored and do not drop listings.                                                                                       |
| Failure isolation      | PASS                         | `inspectAll` uses `Promise.allSettled`. Telegram cycle catches each adapter.                                                                  |
| Durable outbox         | PRESENT                      | Not redesigned here. Legacy `src/index.ts` still saves before send.                                                                           |

## DIM.RIA request budget

Free package used for the calculation: 1000 requests/month, 30 requests/hour.

Production mode is `DOMRIA_ACQUISITION=html` (default). A normal poll performs **0** official requests: two public HTML pages (`arenda-kvartir` and `arenda-domov`).

The previous official path, when a key was set, ran 2 searches plus up to 8 `/dom/info` calls on every poll and ignored `DOMRIA_MAX_INFO_PER_POLL`. At a 10-minute tick that is 10 × 4320 = 43200 requests/month. Even the configured cap of 2 info calls is 4 × 4320 = 17280/month.

| Interval | Polls/month | Requests/month at 2 search + 2 info | Free tier                             |
| -------- | ----------: | ----------------------------------: | ------------------------------------- |
| 5 min    |        8640 |                               34560 | over hourly and monthly               |
| 10 min   |        4320 |                               17280 | over monthly (24/hour, under 30/hour) |
| 15 min   |        2880 |                               11520 | over monthly                          |
| 30 min   |        1440 |                                5760 | over monthly                          |
| 60 min   |         720 |                                2880 | over monthly                          |

A 3-hour interval with 2 searches + 2 info calls is about 960 requests/month and fits. Nothing in the poller waits that long, so `DOMRIA_ACQUISITION=official` is refused unless the real tick (`POLL_INTERVAL_SECONDS` or `TELEGRAM_POLL_INTERVAL_MS`, whichever is faster) fits the free package. The official client remains in `DomriaSource.fetchOfficial` for that case.

## OLX classification

`OLX_BROWSER_REQUIRED`

- HTTP JSON and HTML: 3/3 status 403, 0 listings, about 1.6–2.0 s.
- Stock headless Chromium (Playwright 1.63, Chrome for Testing 153.0.8010.12): 3/3 status 200, 85 listings, 7.0–11.2 s, no challenge page, no stealth flags.
- Seller type on those 85 ads: `unknown` only.
- Default flags stay `ENABLE_OLX=false` and `ENABLE_OLX_BROWSER=false`. Turning the browser flag on does not fall back to HTTP.

Runtime requirement: `BROWSER_CAPABLE_RUNTIME`. Not migrated in this batch.

Incompatible with Cloudflare Workers (no Chromium; earlier CPU measurements already rejected Workers Free). A VM must have Node 22+, Playwright, and the matching Chromium build. `PLAYWRIGHT_BROWSERS_PATH` must point at that install. This Windows run used `%LOCALAPPDATA%\ms-playwright`.

## One full poll, approximate cost

Measured on this machine on 2026-09-21. Sources run concurrently in `inspectAll`, so wall clock is about the slowest source.

| Source      | Outbound                                      | Wall clock            | Bytes                           |
| ----------- | --------------------------------------------- | --------------------- | ------------------------------- |
| DIM.RIA     | 2 HTML GET                                    | 1.3–2.3 s             | about 1.07 MB (651 KB + 420 KB) |
| LUN         | 2 HTML GET                                    | 0.9–1.1 s             | about 1.47 MB                   |
| RIELTOR     | 2 HTML GET, 2 s gap                           | about 2.8–3.4 s       | not metered                     |
| OLX browser | 2 document navigations plus page subresources | 7.0–11.2 s            | subresources not metered        |
| OLX HTTP    | not used when the browser flag is on          | 1.6–2.0 s when probed | 403, small                      |

CPU was not sampled with a profiler. The browser launch is the heavy part.

## Source capability matrix

Codes: `VERIFIED_CODE` means the adapter maps the field. `VERIFIED_LIVE` means this batch observed it in public data. `PARTIAL` means the raw page has something the adapter does not fully map, or the live sample was incomplete. `UNAVAILABLE` means we did not find a usable field. `UNKNOWN` means not checked far enough to decide.

| Field                     | DIM.RIA HTML                                                          | LUN                                                                  | RIELTOR                                                                                  | OLX                                                                           |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Source listing id         | VERIFIED_CODE + VERIFIED_LIVE                                         | VERIFIED_CODE + VERIFIED_LIVE                                        | VERIFIED_CODE + VERIFIED_LIVE                                                            | VERIFIED_LIVE via browser ids; HTTP UNAVAILABLE                               |
| Canonical URL             | VERIFIED_CODE                                                         | VERIFIED_CODE (`lun.ua/uk/realty/{id}`)                              | VERIFIED_CODE + VERIFIED_LIVE                                                            | VERIFIED_CODE                                                                 |
| Title                     | VERIFIED_CODE                                                         | VERIFIED_CODE                                                        | VERIFIED_CODE + VERIFIED_LIVE                                                            | VERIFIED_CODE                                                                 |
| Description               | VERIFIED_CODE                                                         | VERIFIED_CODE                                                        | VERIFIED_LIVE (6/6 and 8/8)                                                              | VERIFIED_CODE; not re-counted in the browser sample                           |
| Price                     | VERIFIED_LIVE 84/84 + CODE                                            | VERIFIED_CODE                                                        | VERIFIED_LIVE                                                                            | VERIFIED_CODE                                                                 |
| Currency                  | VERIFIED_LIVE + CODE                                                  | VERIFIED_CODE                                                        | VERIFIED_CODE                                                                            | VERIFIED_CODE                                                                 |
| Rooms                     | UNAVAILABLE in the normalized listing (unnamed characteristics exist) | VERIFIED_LIVE 24/24 + CODE                                           | VERIFIED_LIVE                                                                            | VERIFIED_CODE only if the offer payload has it; not re-counted live           |
| Area                      | VERIFIED_LIVE `total_square_meters` + CODE                            | VERIFIED_LIVE `areaTotal` + CODE                                     | PARTIAL (page text contains area; adapter does not map it)                               | UNKNOWN live / not mapped as `areaM2`                                         |
| Floor                     | UNAVAILABLE (no verified current-floor field)                         | VERIFIED_LIVE + CODE `metadata.floor`                                | UNAVAILABLE                                                                              | UNAVAILABLE                                                                   |
| Total floors              | VERIFIED_LIVE `floors_count` + CODE                                   | VERIFIED_LIVE + CODE `metadata.totalFloors`                          | UNAVAILABLE                                                                              | UNAVAILABLE                                                                   |
| Property type             | VERIFIED_CODE                                                         | VERIFIED_CODE                                                        | VERIFIED_CODE (search category)                                                          | VERIFIED_CODE                                                                 |
| Address                   | VERIFIED_CODE when `street_name_*` is present                         | PARTIAL (JSON-LD street when present)                                | VERIFIED_CODE                                                                            | VERIFIED_CODE city/district                                                   |
| District                  | VERIFIED_CODE when `district_name_*` is present                       | PARTIAL                                                              | VERIFIED_CODE from the region line                                                       | VERIFIED_CODE                                                                 |
| Coordinates               | VERIFIED_LIVE 84/84 + CODE                                            | VERIFIED_CODE GeoJSON `[lng, lat]`                                   | VERIFIED_LIVE                                                                            | VERIFIED_CODE (`map`, sometimes approximate)                                  |
| Publication time          | VERIFIED_LIVE `publishing_date` + CODE                                | VERIFIED_CODE `insertTime` (naive local)                             | PARTIAL (`availabilityStarts` semantics are not proven; relative labels also exist)      | VERIFIED_CODE `created_time`                                                  |
| Seller id / profile       | VERIFIED_LIVE `user_id` + CODE                                        | PARTIAL (`agency.id` when present)                                   | UNAVAILABLE as a stable id; role label is present                                        | VERIFIED_CODE `user` when the payload has it                                  |
| Explicit owner flag       | VERIFIED_LIVE characteristic 1437 + CODE                              | VERIFIED_CODE `isOwner`                                              | VERIFIED_CODE label `Власник`; not seen on the live flats page sampled (20/20 `Рієлтор`) | Not seen in the 85-ad browser sample                                          |
| Explicit realtor / agency | VERIFIED_LIVE same characteristic + CODE                              | VERIFIED_CODE `agency` object                                        | VERIFIED_LIVE label `Рієлтор`                                                            | `user.sellerType` / `business` are parsed; this sample was entirely `unknown` |
| Phone                     | UNAVAILABLE                                                           | PARTIAL (`phones` was null; `hiddenPhones` exists and is not copied) | UNAVAILABLE                                                                              | UNAVAILABLE in this sample                                                    |
| Photos                    | PARTIAL (gallery in JSON; adapter keeps `main_photo`)                 | VERIFIED_CODE numeric `imageId`, including strings                   | PARTIAL (hundreds of `<img>` tags; adapter stores none)                                  | VERIFIED_CODE `photos` when present                                           |
| Original source           | UNAVAILABLE (this is the origin)                                      | VERIFIED_LIVE `site.internalName`                                    | UNAVAILABLE (this is the origin)                                                         | UNAVAILABLE                                                                   |
| External source URL       | UNAVAILABLE                                                           | VERIFIED_LIVE `urlRaw`                                               | UNAVAILABLE                                                                              | UNAVAILABLE                                                                   |
| Duplicate count           | UNAVAILABLE                                                           | PARTIAL (`hasDuplicates` boolean, not a count)                       | UNAVAILABLE                                                                              | UNAVAILABLE                                                                   |
| Related listings          | UNAVAILABLE                                                           | VERIFIED_LIVE `similarPageIds` + CODE                                | UNAVAILABLE                                                                              | UNAVAILABLE                                                                   |
| Property / cluster id     | UNAVAILABLE                                                           | VERIFIED_LIVE `groupId` on 48/48 + CODE                              | UNAVAILABLE                                                                              | UNAVAILABLE                                                                   |

## Source relationship graph

Observed on 2026-09-21 from LUN catalog cards (24 flats + 24 houses):

| Relation               | Class                           | Evidence                                                                                                                            |
| ---------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| LUN → RIELTOR.UA       | EXPLICIT_SOURCE_LINK            | 35/48 cards: `site.internalName=rieltor.ua` and `urlRaw` host `rieltor.ua`                                                          |
| LUN → OLX              | EXPLICIT_SOURCE_LINK            | 13/48 cards: `site.internalName=olx.ua` and `urlRaw` host `olx.ua`                                                                  |
| LUN → DIM.RIA          | UNKNOWN                         | No `dom.ria` / `ria.com` host in that card set. One detail HTML probe did not contain a DIM.RIA mention.                            |
| LUN internal cluster   | EXPLICIT_SOURCE_LINK inside LUN | `groupId` on 48/48, `hasDuplicates=true` on 26/48, non-empty `similarPageIds` on 27/48. These are LUN ids, not foreign listing ids. |
| RIELTOR ↔ OLX directly | UNKNOWN                         | Not present in the RIELTOR card parser.                                                                                             |
| DIM.RIA ↔ the others   | UNKNOWN                         | Catalog JSON inspected here has no external listing URL.                                                                            |

LUN is an aggregator/index of other platforms' listings. That is not an official write-integration, and it is not proof that the same apartment was cross-posted by the user. The stored fields are future high-confidence dedup evidence. This batch does not drop on them.

## Seller evidence

| Source  | What we actually have                                                                                                                                                                                                      | Gate                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| DIM.RIA | Characteristic 1437: owner / intermediary / developer. Live adapter sample: 2 owner, 6 agent. Missing or unknown 1437 stays `unknown` and is sent. `agency_id` alone is not ownership and is not an agent drop.            | Confirmed agent/business dropped. Unknown sent.                |
| LUN     | `isOwner=true` is platform owner. An `agency` object is platform agent and is dropped. `withoutCommission` is not ownership. A card with `isOwner=false` and `agency=null` stays unknown even when `site` is `rieltor.ua`. | Unknown sent.                                                  |
| RIELTOR | Card subtitle `Власник` or `Рієлтор`. Live flats page 1: 20/20 `Рієлтор`.                                                                                                                                                  | Those realtors are dropped. An unknown label is sent.          |
| OLX     | Browser sample: 85/85 `sellerType=unknown`. A null `user.sellerType` is not ownership.                                                                                                                                     | Unknown sent. No confirmed-agent drop occurred in this sample. |

## Repeated live evidence (2026-09-21)

| Time (UTC)                   | Source                 | HTTP | Kind       | Normalized                                       | Notes                                       |
| ---------------------------- | ---------------------- | ---- | ---------- | ------------------------------------------------ | ------------------------------------------- |
| 19:54:05–19:54:12            | DIM.RIA HTML ×3        | 200  | ok         | 20 flats + 8 houses each cycle                   | ~0.7–1.1 s/page                             |
| 20:04:53, 20:04:56, 20:04:59 | DIM.RIA adapter ×3     | 200  | ok         | 8                                                | same ids; 0 official API calls              |
| 20:05:01, 20:05:04, 20:05:07 | LUN adapter ×3         | 200  | ok         | 8                                                | 24/24 cards validated on each category page |
| 19:58:21, 19:58:49, 19:59:17 | RIELTOR ×3, 25 s apart | 200  | ok         | 6                                                | coords, rooms, price, description           |
| 19:54:23                     | RIELTOR burst          | 429  | http_error | 8 kept in the payload but the cycle is unhealthy | blocked status wins over earlier 200s       |
| 19:54:25–19:54:29            | OLX HTTP ×3            | 403  | http_error | 0                                                | CloudFront                                  |
| 20:03:54, 20:04:03, 20:04:10 | OLX browser ×3         | 200  | extract ok | 85                                               | ids stable across the half-minute           |

## Failure semantics

`valid_empty` is healthy. `parser_failure` is not.

- LUN: missing `realties.cards` or an unreadable array is `parser_failure`. An empty array is `valid_empty`. Cards that all fail schema used to be reported as success/empty; they are now `parser_failure`. The live flats page was in that state while `imageId` was a string.
- DIM.RIA: missing `__INITIAL_STATE__` or missing `realtyForCatalog` is `parser_failure`. An empty catalog array is `valid_empty`. Non-200 is `http_error`.
- RIELTOR: 403, 429, and a Cloudflare challenge are `http_error` even if an earlier page returned cards. A located catalog with zero cards is `valid_empty`.
- OLX HTTP: API 403 stays `http_error`. An HTML 200 does not count as success.
- One adapter throwing does not cancel the others.

## Blockers

- OLX cannot be polled with ordinary Node HTTP from this environment.
- OLX browser acquisition needs a Chromium-capable host. Hosting was not migrated.
- RIELTOR returns 429 if several full cycles are fired back to back. A 10-minute poll with the existing 2 s gap is inside the successful pattern; a tight retry loop is not.
- Cross-source dedup is not implemented. LUN provenance is stored only.
- Eleven existing tests were already failing on files this batch did not change (`owner-filter`, OLX seller type vs `business`, Telegram wording `не підтверджено`). They were not edited and were not weakened.

## Batch 2

1. Choose a browser-capable free host and install Playwright Chromium there. Do not use Cloudflare Workers Free for the OLX leg.
2. Turn on `ENABLE_OLX_BROWSER` only after that host repeats the 85-listing extract. Leave `ENABLE_OLX` off.
3. Keep DIM.RIA on `DOMRIA_ACQUISITION=html`.
4. Map RIELTOR photos only if a stable card attribute is identified. Do not guess.
5. Use LUN `groupId`, `similarPageIds`, `hasDuplicates`, and `urlRaw` as high-confidence dedup evidence. Do not drop fuzzy matches.
6. Keep the permissive seller gate: unknown is sent; only confirmed intermediary evidence is dropped.
