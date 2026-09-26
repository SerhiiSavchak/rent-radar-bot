# OLX sort failure — root-cause inspection (parser vs origin)

**Verdict:** non-monotone organic `createdTime` is **already present in OLX’s prerendered `listing.listing.ads` array**. Our extract preserves that array order and maps timestamps from the ad’s own `createdTime` string. **Not a parser/timestamp-mapping bug.** Sort gate stays **BLOCKED**; time-stop stays **disabled**.

Saved captures: `summary-1790406934261.json` (3 cycles).  
Live order-honor check: `order-honor-diagnostic-1790407403951.json`.

## Method

1. Take sanitized rows from the three saved cycles (raw `position` = ads array index + 1).
2. Confirm timestamp field: probe recorded `createdTimeIso` from ad.`createdTime` only (not `lastRefreshTime`).
3. Promoted classification: `isPromoted === true` or `promotion.top_ad|highlighted|urgent`.
4. Live re-fetch: compare `search[order]=created_at:desc` vs no order param; check organic mono on `createdTime` and `lastRefreshTime`.

## Page 1 raw cards around positions 15–26 (cycle 1; cycles 2–3 same rise)

| raw pos | id | organic/promoted | createdTime (source field=`createdTime`) | lastRefreshTime |
|---|---|---|---|---|
| 15 | 934347832 | promoted | 2026-09-09T23:02:36+03:00 | 2026-09-25T22:12:38+03:00 |
| 16 | 933128280 | promoted | 2026-08-28T16:34:45+03:00 | 2026-09-25T23:55:51+03:00 |
| 17 | 924865900 | **organic** | 2026-05-30T12:41:00+03:00 | 2026-09-26T09:30:43+03:00 |
| 18 | 924732422 | organic | 2026-05-28T18:43:33+03:00 | 2026-09-26T09:29:39+03:00 |
| 19 | 924732027 | organic | 2026-05-28T18:39:18+03:00 | 2026-09-26T09:28:44+03:00 |
| 20 | 924729293 | organic | 2026-05-28T18:10:10+03:00 | 2026-09-26T09:28:40+03:00 |
| 21 | 924728761 | organic | 2026-05-28T18:04:50+03:00 | 2026-09-26T09:27:07+03:00 |
| 22 | 924728316 | organic | 2026-05-28T18:00:03+03:00 | 2026-09-26T09:26:47+03:00 |
| 23 | 936000137 | promoted | 2026-09-26T09:11:33+03:00 | 2026-09-26T09:14:09+03:00 |
| 24 | 925528176 | promoted | 2026-06-06T13:11:15+03:00 | 2026-09-26T09:09:12+03:00 |
| 25 | 935998907 | **organic** | **2026-09-26T08:41:00+03:00** | 2026-09-26T08:42:03+03:00 |
| 26 | 935998905 | organic | 2026-09-26T08:40:58+03:00 | 2026-09-26T08:44:17+03:00 |

Organic stream indices 10–18 (cycle 1) sit on raw positions 19–32 and include the rise at organicIndex 14: May `924728316` → Sep `935998907`. That rise exists in **raw ads order**, not after a re-sort in our code (`extractListingAdsFromPrerenderedState` returns `ads` as-is).

## Is `search[order]=created_at:desc` honored?

| Check | Result |
|---|---|
| Param retained in finalUrl | Yes |
| Organic `createdTime` non-increasing | **No** (3/3 saved + live diagnostic) |
| Organic `lastRefreshTime` non-increasing | **No** (live diagnostic) |
| With vs without order param | Different id sequences → param changes ranking somehow |
| createdTime newest-first under the param | **Not demonstrated** |

URL retention alone is **not** proof the catalog is newest-by-`createdTime`.

## Parser bug?

**No.** Evidence against a parser bug:

- Raw array order already has older organics before newer organics.
- Timestamp used for the gate is ad.`createdTime` ISO → epoch; `lastRefreshTime` is recorded separately and was not substituted.
- Promoted flags on the rise pair are false/false in all three captures.

No failing-then-fix parser change. Gate remains BLOCKED.

## Pagination / catch-up without verified sort

Current production walk (unchanged here):

- Page budget 2; seed commits page-1 newest organic; catch-up cursor; **time-stop off**.
- Catch-up always rechecks page 1, then resumes deeper pages.

**Why a page cursor alone does not prove no misses without sort:**

- Deeper pages are not guaranteed to be older-by-`createdTime`.
- A listing can be inserted/reordered across pages between polls; walking pages 1→N once does not certify full publication coverage.
- `coverage_degraded` + catch-up reduces backlog risk but does **not** equal sort-verified completeness.

**Assessment (not implemented in this change):** any sort-independent catch-up would need an explicit coverage criterion that does not assume age order (e.g. repeated full-budget walks until confirmed_empty / stable id set, with retained miss-risk notes). Until that is demonstrated live, sort gate and time-stop stay blocked/off; do not mark coverage PASS.

## Evidence preserved

- `summary-1790406934261.json` (unchanged)
- `SORT_GATE.md`
- `order-honor-diagnostic-1790407403951.json` (this investigation)
- `SORT_FAILURE_ANALYSIS.md` (this file)
