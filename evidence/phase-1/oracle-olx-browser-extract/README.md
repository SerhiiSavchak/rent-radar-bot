# Oracle OLX browser extract — status

## Live Oracle after `4dab997` — still FAILED extraction

Both apartments and houses reported:

| Field | Value |
|---|---|
| HTTP | 200 |
| accessibilityOk | true |
| apiResponsesCaptured | 0 |
| rawOfferCount | 0 |
| validatedListingCount | **0** |
| extractSource | **none** |
| hasPrerenderedState | **false** |
| hasNextData | **false** |
| hasOffersApiShapeInHtml | **false** |
| markerHits | `data_cy_l_card`, `offer_id_html_link` |
| browserClosed | true |

Fixtures with `__PRERENDERED_STATE__` / `__NEXT_DATA__` are **not** representative of this Oracle HTML.
**Do not claim OLX success. Do not wire OLX into Telegram.**

## What the extractor reads

- **Parser input:** rendered DOM via `page.content()` after readiness (`htmlInputKind=rendered_dom`).
- **Main-document body:** optional diagnostic capture of the navigation response text (not the sole parser input).
- **timeoutMs:** `page.goto` navigation timeout only.
- **categoryBudgetMs / totalBudgetMs:** wall-clock budgets (explains runs that exceeded 45s when only goto was capped).

## Diagnostic capture (next Oracle step)

Set `OLX_BROWSER_CAPTURE=true` on the existing `live:olx:browser-extract` command.
Artifacts go under a unique dir outside the repo, e.g.
`$HOME/rent-radar-runtime/olx-browser-extract/capture-<ts>/`:

- `apartments|houses/main-document.html`
- `apartments|houses/rendered.html`
- `apartments|houses/scripts.json`
- `apartments|houses/cards.json`
- `apartments|houses/network-meta.json` (no analytics bodies; cookies/auth redacted)
- `apartments|houses/manifest.json`
- `run-summary.json`

Parser fix still **requires** these Oracle artifacts. No additional speculative payload parser was added.
