# Rent Radar status

Date: 2026-09-21  
Branch: core-logic batch on top of `a9d6eaf` (`cursor/source-layer-closure`)  
Phase: seller evidence, provenance, and conservative cross-source dedup

Issue #2 accepts the source-layer gate as already proven, including the hosted OLX cycles on the existing VM. This batch does not repeat that proof and does not change acquisition.

Repository code is the source of truth. Older notes in `docs/SOURCE_RESEARCH.md` and `docs/PHASE_1_DECISION.md` are historical.

## Source status

| Source     | Acquisition                                                                                                               | Status                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| DIM.RIA    | Public HTML, repeated live from this workstation                                                                          | PASS                           |
| LUN        | Public HTML/RSC, repeated live from this workstation                                                                      | PASS                           |
| RIELTOR.UA | Public HTML, 2 s request gap, one bounded 429/5xx retry                                                                   | PASS                           |
| OLX        | Issue #2 accepts the hosted browser proof from the preceding phase. This batch did not re-run it. Ordinary HTTP stays off | accepted, not re-measured here |

`SOURCE LAYER GATE: accepted by issue #2`. This batch did not change acquisition and did not turn `ENABLE_OLX` or `ENABLE_OLX_BROWSER` on.

## Canonical production path

One poll/delivery path:

`deploy/systemd/rent-radar-telegram.service` → `src/scripts/test-telegram-poll.ts` → `runTelegramTestCycle` (`src/delivery/telegram-test-pipeline.ts`) with `openDurableRuntime` (`src/storage/durable-runtime.ts`).

Delivery order:

1. listing accepted by the filters
2. durable SQLite state and a pending `telegram_outbox` row
3. Telegram attempt
4. success marks the row sent

If Telegram fails, the row stays retryable. Reopening the same database retries it. A later success does not send it again.

`src/index.ts` exits 2 and does not collect, persist, or send. `ListingMonitorService.collectNewListings()` throws. `package.json` production poll script is `live:test-telegram:poll`. There is no cron unit besides `deploy/systemd/rent-radar-telegram.timer` (`OnBootSec=1min`), which starts that same service.

## Architecture (actual path)

| Stage             | Files                                                                         | Behavior                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Source adapters   | `src/collection/create-source-adapters.ts`                                    | Domria, Lun, Rieltor on by default. OLX HTTP only if `ENABLE_OLX`. OLX browser only if `ENABLE_OLX_BROWSER`, and then HTTP is omitted. |
| Acquisition       | `src/utils/http.ts`; OLX browser in `src/sources/olx/olx-browser.extract.ts`  | Node `fetch` with timeout and bounded retries. No proxy, no CAPTCHA solver.                                                            |
| Parse / normalize | `src/sources/*/ *.parser.ts`, `src/domain/listing.ts`                         | Zod-validated cards become `Listing`.                                                                                                  |
| Seller filter     | `src/filters/owner-filter.ts`                                                 | Default `reject_intermediaries`. Unknown sellers pass. Platform agent/business and explicit intermediary evidence drop.                |
| Property filter   | `src/filters/property-type.ts`, `listing-filter.ts`                           | Apartment and house. Other types become `unknown` and fail the allow-list.                                                             |
| Geo               | `src/filters/location-filter.ts`                                              | Haversine around Lviv. Default radius 15 km. Missing coordinates are excluded (`GEO_UNKNOWN_POLICY=exclude`).                          |
| Dedup             | `src/delivery/cross-source-dedup.ts`, `src/storage/durable-delivery-store.ts` | Same source id, explicit `urlRaw` identity, and LUN `groupId` can suppress. Attribute overlap and text do not.                         |
| Persistence       | `src/storage/db.ts`, `durable-delivery-store.ts`, `migrations.ts`             | Local SQLite. Outbox statuses: pending, sending, sent, failed.                                                                         |
| Telegram          | `src/outputs/telegram.output.ts`, `telegram-test.sink.ts`                     | Durable path enqueues before send and marks sent only after success.                                                                   |

`POLL_INTERVAL_SECONDS` defaults to 120. The Telegram poller uses `TELEGRAM_POLL_INTERVAL_MS` (default 600000). `DOMRIA_POLL_INTERVAL_SECONDS` is not a separate scheduler.

## Subsystem status

| Subsystem              | Status                       | Evidence                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DIM.RIA acquisition    | PASS                         | Public HTML. 6/6 page fetches HTTP 200 on 2026-09-21 (20 flats, 8 houses). Adapter 3/3 `ok`, same 8 ids. Official API not called.                                                                                                                       |
| LUN acquisition        | PASS                         | After the `imageId` string fix: flats 24/24 validated, houses 24/24, adapter 3/3 `ok`.                                                                                                                                                                  |
| RIELTOR.UA acquisition | PASS                         | 2026-09-21 20:29:31Z, 20:29:59Z, 20:30:27Z: HTTP 200, `ok`, 10 ids, 2 requests per cycle, ~2.9–3.1 s. Same ids across the three cycles.                                                                                                                 |
| OLX HTTP               | FAIL                         | 3/3 CloudFront 403. `resultKind=http_error`. Not a production path.                                                                                                                                                                                     |
| OLX browser            | FAIL on the target VM        | Local 3/3 Playwright PASS (85 listings) remains historical. Hosted classification this batch: `OLX_HOSTED_BROWSER_BLOCKED`. Flag stays off.                                                                                                             |
| Seller gate            | PASS for the permissive rule | Unknown is sent. OLX `isBusiness` stays `sellerType=unknown` and is sent. Platform agent/business and explicit «я рієлтор» drop.                                                                                                                        |
| Cross-source dedup     | PASS for the v1 hierarchy    | Explicit LUN→OLX and LUN→RIELTOR identity suppresses. `groupId` does not match a foreign id. Similar rooms/area/price stay sendable. Identity survives reopening SQLite. Proved by `tests/cross-source-dedup.test.ts`, not by a new live overlap count. |
| Failure isolation      | PASS                         | `inspectAll` uses `Promise.allSettled`. Telegram cycle catches each adapter.                                                                                                                                                                            |
| Durable outbox         | PASS                         | Only production path. Failed Telegram send stays retryable across a reopened SQLite file and is not sent twice after success.                                                                                                                           |

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

Runtime requirement: `BROWSER_CAPABLE_RUNTIME`. The 2026-09-21 hosted attempt did not install Chromium or run a cycle. Classification of that attempt: `OLX_HOSTED_BROWSER_BLOCKED`. `ENABLE_OLX_BROWSER` stays false.

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

LUN is an aggregator/index of other platforms' listings. That is not an official write-integration. v1 drops a listing only when `urlRaw` parses to the same OLX token, RIELTOR `/view/{id}`, or DIM.RIA id as a listing already stored, or when two LUN cards share `groupId`. `similarPageIds` and `hasDuplicates` stay on the record and do not drop. Image hashing and AI similarity are not implemented.

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
- RIELTOR: 403 and a Cloudflare challenge are `http_error` even if an earlier page returned cards. HTTP 429 is `rate_limited` after at most one retry, and it is not `valid_empty` or `ok`. A located catalog with zero cards is `valid_empty`.
- OLX HTTP: API 403 stays `http_error`. An HTML 200 does not count as success.
- OLX browser: a failed extract (`extractionOk=false`, no listings) is `parser_failure` or `http_error`, never `valid_empty`.
- One adapter throwing does not cancel the others.

## Tests

2026-09-21 20:31Z (source-layer closure): `tsc --noEmit` exit 0, eslint exit 0, `vitest run` 26 files, 221 tests, 0 failures.

2026-09-21 21:35Z (this core-logic batch): `npm run typecheck` exit 0, `npm run lint` exit 0, `npm test` 27 files, 236 tests, 0 failures. No live source fetch was required for this gate.

The 11 Vitest failures, plus the separate `sellerPolicy` type error, were:

| Test                                                                               | Class                  | Cause                                                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| owner title «від власника»                                                         | TEST_EXPECTATION_STALE | The phrase is a self-declaration. `sellerType` stays `unknown` and the listing is sent.                                  |
| «Я рієлтор»                                                                        | PRODUCTION_CODE_BUG    | JavaScript `\b` does not treat Cyrillic as a word character, so a leading «Я» never matched.                             |
| Telegram unknown label (`domria-resultkind`, `telegram-test-sink`)                 | PRODUCTION_CODE_BUG    | The label did not contain «не підтверджено». It is now exactly «Власник не підтверджено».                                |
| OLX parser and four browser-extract assertions that required `sellerType=business` | TEST_EXPECTATION_STALE | `isBusiness` is an account flag, not platform realtor proof. The flag is stored. The seller stays `unknown` and is sent. |
| OLX detail `defaultOwnerGateWouldAccept` and the delivery-gate self-declared row   | TEST_EXPECTATION_STALE | Self-declared unknown listings are accepted by the default policy. Legacy `isOwnerEligible` still rejects them.          |
| `sellerPolicy` missing on the startup fixture (typecheck)                          | TYPE/MODEL_DRIFT       | The startup message requires `sellerPolicy`. The fixture now passes `reject_intermediaries`.                             |

## Hosted OLX attempt

The only host in `~/.ssh/known_hosts` is `92.5.160.179`. SSH answered and rejected `ubuntu` and `opc` with `Permission denied (publickey)`. `~/.ssh` has no private key. `$HOME/rent-radar-phase1-oracle` is absent, so the provisioner key is not on this workstation. No browser dependency was installed on the VM. No cycle was run. Resource budget, reboot, and systemd restart were not measured.

`ENABLE_OLX_BROWSER` was not turned on.

## Closure live evidence (2026-09-21, this workstation)

| Time (UTC)                   | Source                 | HTTP | Kind | Normalized | Notes                                                                           |
| ---------------------------- | ---------------------- | ---- | ---- | ---------- | ------------------------------------------------------------------------------- |
| 20:29:05, 20:29:11, 20:29:17 | DIM.RIA adapter ×3     | 200  | ok   | 10         | same ids `34690408` …; 1.4–2.2 s                                                |
| 20:29:18, 20:29:23, 20:29:28 | LUN adapter ×3         | 200  | ok   | 10         | same ids `4725239863` …; 1.0–1.5 s                                              |
| 20:29:31, 20:29:59, 20:30:27 | RIELTOR ×3, 25 s apart | 200  | ok   | 10         | 2 requests/cycle, ~3 s, declared catalog ≥ 777, truncated by the existing limit |

## Blockers

- Historical closure note: this file's hosted-OLX section above was written before issue #2 accepted the source layer. This core-logic batch did not SSH to the VM and did not change `ENABLE_OLX` or `ENABLE_OLX_BROWSER`.
- RIELTOR can still return 429. The adapter makes at most one extra attempt, waits at most 3 s, and does not wait out a long `Retry-After`.
- Cross-source identity rows are not pruned. Retention cleanup is a later batch.
- `similarPageIds` is stored and does not suppress. A shared LUN `groupId` does suppress inside LUN only.

## Remaining work

1. Keep DIM.RIA on `DOMRIA_ACQUISITION=html`.
2. Leave paid scraping APIs, proxies, CAPTCHA solvers, and stealth tooling out.
3. Add retention cleanup for `cross_source_identities` only when a later batch defines the policy.
4. Do not add image hashing or AI similarity to the dedup hierarchy.
