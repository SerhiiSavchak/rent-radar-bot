# RIELTOR.UA ordinary HTTP (Phase 1)

Date: 2026-09-15. Bypass / proxies / CAPTCHA / stealth: **not used**.
Requests were sequential, one at a time, from this workstation.

## Routes verified live

| URL | HTTP | Resolved location | Notes |
|-----|------|-------------------|-------|
| `https://rieltor.ua/lvov/flats-rent/` | 200 | Title/H1 Львів, canonical `/lvov/flats-rent/` | Long-term apartments. `data-listing-count` = **743**. Primary catalog = 20 cards/page. |
| `https://rieltor.ua/lvov/houses-rent/` | 200 | H1 **«Довготривала оренда будинків в Львові»** | Houses. `data-listing-count` = **53**. Page 1 localities included Львів plus Сокільники, Зимна Вода, Брюховичі, Винники, Муроване, Малі Підліски, Запитів. |
| `https://rieltor.ua/lvov/flats-rent/?f-owners=1` | 200 | H1 «без посередників», city still `lvov` | **3** primary cards, all platform label **Власник**. JSON-LD ItemList **absent**. |
| `https://rieltor.ua/lvov/houses-rent/?f-owners=1` | 200 | H1 Львів, canonical `/lvov/houses-rent/` | **VALID EMPTY**: `За вашим запитом пропозицій не знайдено`, 0 primary cards. |

`f-owners=1` is a real platform filter, but only if the parser reads `data-listing-items`. The page also injects `data-listing-add-items` (“оголошення поруч”) — 17 realtor cards on the owner-flats page and 20 extras on empty owner-houses. Treating extras as the catalog would **falsely** report рієлтор listings as owner-filtered results.

## Owner / realtor labels

Platform evidence is the card subtitle `<div class="catalog-card-author-subtitle"><span>Власник|Рієлтор</span></div>`. JSON-LD has no seller role. Description text is not used. Unrecognized labels stay `unknown`.

Unfiltered first page of apartments and houses was **all Рієлтор** in this sample. Owner evidence was only seen on `f-owners=1` apartments (n=3). Owner houses around Lviv: **zero** in this observation (valid empty, not a parser miss).

## Pagination / completeness

- Page size 20. URL page 1 has no `page` param; page 2 is `?page=2`.
- **Unfiltered** apartments: 743 declared ⇒ ~38 pages. A first-page unfiltered fetch is **truncated**.
- **Owner filter (`f-owners=1`) recheck 2026-09-16:** apartments `declared=3`, 3 primary cards, `truncated=false`, 1 request; houses `declared=0` / `valid_empty`, `truncated=false`. Recommendations in `data-listing-add-items` remain excluded. The 38-page figure applies to the **unfiltered** catalogue, not the owner-filtered product path when `OWNER_ONLY` / `preferOwners` is used.
- Adapter default (2026-09-16): `preferOwners` falls back to `getConfig().ownerOnly` so production owner mode does not inherit unfiltered 743 totals.

## Dates and coordinates

- Cards show relative labels (`сьогодні`, `2 тиж. тому`) — day-level / vague. These are stored as `metadata.publishedLabel`, not invented into `publishedAt`.
- JSON-LD `offers.availabilityStarts` (`2026-09-12 17:21:14` style) is used as `publishedAt` when present. Semantics (created vs refreshed vs available-from) are **unknown**; precision is seconds-on-clock without timezone.
- Coordinates: `data-latitude` / `data-longitude` on cards; JSON-LD `geo` when present. No radius field. Stored as an unspecified point (`coordinatePrecision=unspecified_point`). Missing coords stay missing.

## Geographic coverage (~15 km)

Houses catalog on `/lvov/houses-rent/` already includes several suburbs inside ~15 km (see localities above). Apartment first page in this sample was **city of Lviv only** (districts, not suburb towns). Whether later apartment pages include the same suburbs is **unverified**. There is no `distance=` query analogous to OLX. Radius filtering remains a later Haversine step on coordinates, not a platform radius parameter.

## Repeated polling

One-shot `npm run live:rieltor` and three scripted cycles, this workstation, ordinary HTTP, no concurrency.

| Run | Start (UTC) | HTTP | Listings | Kind | Requests | Truncated | Verdict |
|-----|-------------|------|----------|------|----------|-----------|---------|
| oneshot | 2026-09-15T20:02:30Z | 200 | 10 | ok | 2 | yes (747+53) | PASS |
| cycle 1 | 2026-09-15T20:03:37Z | 200 | 10 | ok | 2 | yes | PASS |
| cycle 2 | 2026-09-15T20:13:40Z | 200 | 10 | ok | 2 | yes | PASS |
| cycle 3 | 2026-09-15T20:23:43Z | 200 | 10 | ok | 2 | yes | PASS |

Intervals: 10 min 0 s (cycle 1→2) and 10 min 3 s (cycle 2→3). Total cycle-script requests: **6**. No 403/429. The same 10 apartment ids appeared in all three cycles (first-page window did not move in 20 minutes). Houses were fetched each cycle (20 cards, declared 53) but sliced off by `limit=10`.

This short run does **not** prove multi-day reliability.
