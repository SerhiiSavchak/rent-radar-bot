# LUN original URLs vs OLX (first-page sample)

Date: 2026-09-15  
Command: `npm run research:lun-origins` (`inspectLatest` limit=24, apartments + houses)  
Transport: LUN Next.js RSC `realties.cards` + JSON-LD  
Direct OLX browser baseline: **NOT TESTED** (no Playwright/Chromium in repo); a direct OLX
**HTTP** baseline from a second environment was captured instead — see the intersection
section below and `olx-http.md`.

## Census

- `resultKind`: ok  
- HTTP: 200  
- listings: 24  
- original hosts:
  - `olx.ua`: **22**
  - `dom.ria.com`: **2**
  - `rieltor.ua`: **0** in this sample
- sampled OLX IDs from `urlRaw`: `11gWHG`, `11gUma`, `11gTXI`, `11gN5k`, `11gMCP`, `11gFMT`, `SLiOZ`, `11gvYU`, `11gsHT`, `11gr7V`

Live `npm run live:lun` (limit 10) also PASS: `resultKind=ok`, integrity notes:

- flats-bez-poserednykiv: rsc=true jsonld=true rawCards=24 validated=20
- houses: rsc=true jsonld=true rawCards=24 validated=14

## Intersection with direct OLX (same observation window, 2026-09-15 ~21:40–21:50)

Samples compared by **URL token string** (`ID<token>.html`), not by numeric decoding
(see the token caveat in `olx-http.md`):

- LUN flats page (`flats-bez-poserednykiv`, first page): 20 listings, **19 olx.ua originals**.
- Direct OLX apartments window (`category_id=1760`, Lviv + 15 km, limit 40 → 52 records
  incl. promoted, organic part covering ≈17:05–21:30 the same day).
- **Matched: 3 / 19** (`11gWHG`, `11gUma`, `11gTXI` — all created 17:48–18:41 that evening;
  one of them `business:false`).
- Unmatched 16: their creation times fall **outside** the short organic window of an
  unfiltered created_at-sorted page — Lviv apartments get ~50 new OLX listings per
  ~4.5 hours, while LUN's owner-filtered first page spans several days. This is a window
  mismatch, not proof of missing coverage; it does show a first-page LUN scan cannot
  substitute polling OLX directly at 10-minute cadence without deeper pagination.
- LUN houses page: 14 listings, 10 olx.ua + 4 dom.ria originals.
- First-observed delay: the matched `11gWHG` was created 18:41 and present on LUN's first
  page by ~21:40 (≤3 h). No new OLX listing appeared during the 10-minute repeat window,
  so a precise LUN ingest delay remains **unknown**.

## What this does **not** prove

- Partial overlap (22/24 first-page cards pointing at olx.ua) is **not** complete OLX coverage.
- Original URLs were not opened in a browser; ads may have been taken down, geo-blocked, or rewritten.
- JSON-LD and RSC cards are paired by index; titles and original URLs can disagree on a given card.
- First page ≠ full LUN or RIELTOR inventory. No dedicated RIELTOR adapter exists.
- Switching product scope to “OLX via LUN only” would be a scope change, not an approved replacement for an OLX adapter.
