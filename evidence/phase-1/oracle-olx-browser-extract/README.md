# Oracle OLX browser extract — status

## Live Oracle result (2026-09-17) — NOT SUCCESS

Source: `evidence/phase-1/oracle-olx-browser-extract/cycle-1.json` (and matching runtime under `~/rent-radar-runtime/olx-browser-extract`).

| Field | Value |
|---|---|
| accessibilityOk | **true** |
| HTTP | 200 |
| apiResponsesCaptured | **0** |
| rawOfferCount | 0 |
| validatedListingCount | **0** |
| extractionOk | **false** |
| rejections | `no_offers_api_payload_captured`, `dom_fallback_insufficient` |

**Verdict:** browser can open the public catalog and see card markers; that is **not** validated Listing extraction. **Do not** claim OLX success. **Do not** wire OLX into Telegram.

## Root cause (code + evidence)

1. Extractor listened only for `/api/v1/offers` XHR/fetch.
2. On Oracle, stock Chromium loaded SSR HTML with listing card signals, but **no** `/api/v1/offers` response was intercepted (`apiResponsesCaptured=0`).
3. Likely SSR embeds offer data in page hydration (`window.__PRERENDERED_STATE__` / similar) so the client never calls the JSON API — or the API remains blocked while HTML is allowed.
4. Card-marker DOM alone was correctly rejected (no fabricated Listings).

## Code follow-up (this revision)

- Parse structured public HTML payloads: `__PRERENDERED_STATE__`, `__NEXT_DATA__`, embedded `{data:[…]}` offers shape.
- Keep network intercept as primary when present.
- Add bounded `networkJsonProbes` + `htmlDiagnostics` to the extract report.
- Still refuse weak DOM-only cards.
- OLX remains `ENABLE_OLX=false` for Telegram until a live run reports `validatedListingCount > 0`.

## Re-run (bounded, no Telegram)

```bash
set -euo pipefail
cd ~/rent-radar-bot
# ensure no Telegram/soak pollers are running first
export OLX_BROWSER_EXTRACT=true
export OLX_BROWSER_OUT_DIR="$HOME/rent-radar-runtime/olx-browser-extract"
export OLX_BROWSER_TIMEOUT_MS=45000
export OLX_BROWSER_MAX_PAGES=1
npm run live:olx:browser-extract
# Inspect outPath JSON: validatedListingCount, extractSource, htmlDiagnostics, networkJsonProbes, rejections
```
