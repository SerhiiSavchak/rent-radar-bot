# LUN original URLs vs OLX (first-page sample)

Date: 2026-09-15  
Command: `npm run research:lun-origins` (`inspectLatest` limit=24, apartments + houses)  
Transport: LUN Next.js RSC `realties.cards` + JSON-LD  
Direct OLX browser baseline: **NOT TESTED** (no Playwright/Chromium in repo)

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

## What this does **not** prove

- Partial overlap (22/24 first-page cards pointing at olx.ua) is **not** complete OLX coverage.
- Original URLs were not opened in a browser; ads may have been taken down, geo-blocked, or rewritten.
- JSON-LD and RSC cards are paired by index; titles and original URLs can disagree on a given card.
- First page ≠ full LUN or RIELTOR inventory. No dedicated RIELTOR adapter exists.
- Switching product scope to “OLX via LUN only” would be a scope change, not an approved replacement for an OLX adapter.
