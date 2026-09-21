# Oracle soak review (12-cycle, commit 3af328c)

**Verdict recorded:** `DEGRADED` — 12/12 degraded, 0 complete, no early stop.  
**Wall time:** ~2h28m (`totalElapsedMs` 8896204). **maxCycleDurationMs:** 290610.

## Per-source (facts)

| Source | Rate | Notes |
|--------|------|-------|
| DIM.RIA | 0/12 | HTTP 200, `extractedCount=10`, but `resultKind=unknown` → soak `success=false` |
| LUN | 12/12 | ok |
| RIELTOR | 12/12 | ok (owner path; houses often valid_empty) |
| OLX HTTP | 0/12 | diagnostic `transport_blocked` (expected) |
| OLX browser | 12/12 | `browser_accessible` — **page structure only** |

## DIM.RIA root cause

`DomriaSource.finish()` returned listings and a healthy message (`DIM.RIA returned 10 listings…`) but **never set `resultKind`**. Soak `mapRequiredHttp` falls back to `unknown` and only treats `ok`+count or `valid_empty` as success — so Domria was marked failed despite real extraction. Logs showing `count=1`/`HTTP 200` were consistent with extraction working.

**Fix:** always set `resultKind` (`ok` when listings exist). Regression: `tests/domria-resultkind.test.ts`. Validation was not weakened.

## What OLX `browser_accessible` proves

1. **Page access:** Chromium loaded Lviv apartment/house catalog URLs (HTTP 200, normal titles).  
2. **Listing extraction (DOM signals):** HTML contained card markers (`data-cy=l-card`, offer ID links, etc.).  
3. **Validated deliverable listings:** **Not proven.** Soak `extractedCount=2` means both categories were accessible, not two `Listing` objects ready for Telegram. No owner/type/geo pipeline ran on OLX browser HTML.

## Telegram delivery implications

`npm run live:test-telegram*` uses HTTP adapters only. Default `ENABLE_OLX=false`. Even if enabled, OLX uses the **blocked HTTP** adapter — not Playwright. Do not report “four working sources” for Telegram on Oracle.
