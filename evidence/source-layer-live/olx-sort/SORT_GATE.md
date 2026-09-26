# OLX HTML sort gate — live evidence 2026-09-26

**Verdict: BLOCKED** (3/3 cycles). Time-stop remains **disabled**.

## Production query

Built via `buildOlxBrowserCategoryUrl("apartments")`:

- path: `/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/`
- `search[dist]=15`
- `search[order]=created_at:desc`
- pages: 1 and 2 (`OLX_BROWSER_PAGE_BUDGET=2`)

Evidence: `evidence/source-layer-live/olx-sort/summary-1790406934261.json`

## Per-cycle result

| Cycle | HTTP | Params retained | Page1 organic non-increasing | Page2 non-increasing | Page boundary | Block reason |
|---|---|---|---|---|---|---|
| 1 | 200 | dist+order+page | **NO** (breakIndex=14) | NO | NO | `page1_organic_created_not_non_increasing` |
| 2 | 200 | dist+order+page | **NO** (breakIndex=14) | NO | NO | same |
| 3 | 200 | dist+order+page | **NO** (breakIndex=14) | NO | NO | same |

## Exact failure (cycle 1, representative)

Organic `createdTime` sequence on page 1 is not newest-first. At organic index 14, an older May listing is followed by newer Sep 26 listings:

| id | page pos | createdTime |
|---|---|---|
| 924728316 | 22 | 2026-05-28T18:00:03+03:00 |
| 935998907 | 25 | 2026-09-26T08:41:00+03:00 |
| 935998905 | 26 | 2026-09-26T08:40:58+03:00 |

(Promoted cards occupy positions between 22 and 25; the organic-only epoch stream still rises.)

Sanitized listing rows (id + timestamps) for both pages are retained in the summary JSON.

## What would be required for PASS

- Organic `createdTime` non-increasing within page 1 and page 2 on **every** of ≥3 cycles
- Page2 newest organic ≤ page1 oldest organic on every cycle
- Not satisfied by HTTP 200 or URL retention alone

## Missing for a root-cause claim

- Whether OLX ranks by another field (e.g. refresh/push) despite `created_at:desc`
- Whether challenge/A-B ranking injects older organics mid-page
- Stable ordering under a different query shape (out of scope for this gate)

No fixture PASS regression tests were added (ordering not proven). Coverage notes stay `olx_browser_sort_status=blocked`; time-stop stays off.
