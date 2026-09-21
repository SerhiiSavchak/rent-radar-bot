# Oracle OLX browser extract — status

`ENABLE_OLX` (HTTP) stays false. Browser extract is wired to collection/Telegram only behind `ENABLE_OLX_BROWSER` (default false). No HTTP API fallback.

## 219316f live probe — adapter failure, not Oracle access

Live extract on `219316f` had `htmlInputKind=main_document`, complete prerendered `listing.listing.ads` (apartments raw 51, houses raw 38), and **uniqueIdCount=0**. Every candidate was `embedded_offers_partial_schema_failure`. Accessibility succeeded; the browser closed.

Root cause: `olxOfferSchema` required `photos: { link }[]`. The catalog payload uses `photos: string[]`. See `cycle-219316f-schema-failure.json`. The adapter now maps string photos and keeps per-candidate Zod paths.

These two later results are **different snapshots**. Do not copy the ownership table onto the live 75f7384 run.

## A. Live catalog extract (`75f7384`) — 2026-09-18

| field | value |
| --- | --- |
| generating commit | `75f738457d386173b9c554e0a3d069f04e681ddc` |
| recorded from | Oracle `live:olx:browser-extract` 2026-09-18T20:27:56.395Z |
| capture on disk | none (houses `captureSkipped`; no full ads dump in git) |
| apartments raw / unique / validated | **52 / 51 / 51** (`duplicate_id`: 1) |
| houses raw / unique / validated | **39 / 38 / 38** (`duplicate_id`: 1) |
| `ownerEligibleCount` | 0 |
| sampleListings | 5, all `sellerType=business` |

Source file: `cycle-75f7384.json` (preserved). Timing fix `1446347` (skip rendered capture after success) was later live-checked on `2daa290`.

This run does **not** include an ownership distribution. There is no salvaged ads array from 75f7384.

## B. Diagnostic capture + offline ownership audit (`baab323`) — 2026-09-17

| field | value |
| --- | --- |
| generating commit | `baab3230824bc4e976cae50c6ad2c9ded2e91467` |
| live extract then | `extractionOk=false`, `validatedListingCount=0` (parser not yet adapted) |
| capture id | `capture-1789666022490` |
| apartments capture startedAt | 2026-09-17T17:27:05.353Z |
| houses capture startedAt | 2026-09-17T17:28:22.151Z |
| live extract JSON | `startedAt` 2026-09-17T17:27:02.490Z |
| apartments prerendered | `totalElements=1000`, `totalPages=25`; **52** complete first-page ads salvaged |
| houses prerendered | `totalElements=37`, `visibleElements=37`, `totalPages=1`; **37** complete ads salvaged |
| unique IDs in salvage | 52 apartments + 37 houses (89) |
| validated listings at capture time | **0** |
| later offline reclassify (8620ab1 classifier) | 89 parsed listings (not a live extract) |

Houses 37 vs live-75f7384 houses 39 is a **different day's catalog**, not a truncated copy of the 75f7384 payload.

### Ownership counts (baab323 salvage only)

`user.sellerType` was **null on every salvaged ad**. `isBusiness`: 85 true / 4 false.

| evidence level | count | what it is |
| --- | --- | --- |
| platform-confirmed owner | **0** | catalog has no owner flag |
| explicit self-declared owner | **3** | private + «від власника» / «без посередників» |
| private account, unknown ownership | **1** | `934070005` «приватного будинку» is the building |
| intermediary / business | **85** | `isBusiness=true` |
| conflict | **0** | no business ad + «від власника» |

Self-declared ids: `924128798`, `933587870` (title); `935081899` (description). Default `OWNER_ONLY` still ignores these.

## C. Live catalog extract (`2daa290`) — 2026-09-19 timing overrun

Oracle verify on `2daa290d95f6dba49f3a52290202059266c3283a`: `extractionOk=true`, `validatedListingCount=84` (apartments 46, houses 38), `htmlInputKind=main_document`, `extractSource=prerendered_state`, `browserClosed=true`. Owner-detail: HTTP 200, `sellerType=null`, `isBusiness=false`, self-declaration only; default owner gate rejected.

Remaining defect: `wallClockMs=189873` vs `totalBudgetMs=95000`. Apartments 56700ms, houses 122716ms. Both categories were `timedOut` after a successful parse because cleanup/`page.title()`/`page.close()` were unbounded and `timedOut` was flipped just because the clock passed the deadline. Extraction success is now separate from `budgetExceeded`; cleanup is bounded and timed.

## D. Bounded owner-detail diagnostic (implemented; live 2daa290)

One private self-declared candidate from capture **B**, not from run **A**:

- id `924128798`
- URL `https://www.olx.ua/d/uk/obyavlenie/zdatsya-v-orendu-budinok-vd-vlasnika-ID10xy7c.html`
- catalog: `isBusiness=false`, `user.sellerType=null`, evidence `self_declared`

Diagnostic: one stock Playwright navigation of that URL, original `response.body()` only, no `/api/v1/offers` intercept, no pagination/retry. Telegram gate unchanged.

**Live Oracle result (`2daa290`):** HTTP 200, `sellerType=null`, `isBusiness=false`, seller self-declaration present, no stronger platform-confirmed ownership. Default owner gate rejected. This ownership investigation is **closed** — no further speculative OLX owner probes.

Operator sequence: `scripts/oracle-olx-verify/README.md`.

## Freshness / persistence (unchanged)

7-day age window is not a new publication. Delivery needs silent baseline + unseen + `publishedAt` after monitoring start. In-memory baseline/dedupe do not survive restart.

**Before production acceptance:** durable baseline, dedupe, outbox, and restart recovery are required. TEST in-memory state is not enough.

## Next source task

RIELTOR access (see `evidence/phase-1/rieltor.md`). Not another OLX catalog experiment.
