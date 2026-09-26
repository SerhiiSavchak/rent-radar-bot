# Source-layer live coverage matrix — 2026-09-26

Evidence retained under `evidence/source-layer-live/`.
PASS requires repeated live listing-level proof (≥3 cycles). Fixtures, HTTP 200, URL retention, or a single OK request are not sufficient.

| Source | Capability | Status | Cycles | Evidence | Adapter impact |
|---|---|---|---|---|---|
| OLX browser HTML | Radius `search[dist]=15` | **PASS** | 3/3 | `olx-radius-sort/summary-1790404277589.json` — suburbs (Винники, Сокільники) on dist+order absent from city-only | Notes: `olx_browser_radius_status=live_verified_2026-09-26` |
| OLX browser HTML | Sort `search[order]=created_at:desc` | **BLOCKED** | 0/3 | `olx-sort/summary-1790406934261.json`; analysis `olx-sort/SORT_FAILURE_ANALYSIS.md` — non-monotone organic `createdTime` already in OLX ads array (not parser); order param retained but createdTime newest-first not honored; time-stop off | `olx_browser_sort_status=blocked` |
| OLX browser HTML | Full order-independent catalog scan | **BLOCKED** | depth probe | `olx-coverage-scan/depth-timing-1790407832189.json` + `COVERAGE_SCAN_LIMIT.md` + from-26 `apartments-from26-1790408583920.json` — apt 25p still novel; continue-from-26 hit `wall_cap_300s` @p222 with no empty page (`totalElements=1000`); complete-scan wall time **unproven** (do not claim exceeds ~95s extract budget); page cursor unsafe | page budget 2 sample only; time-stop off; no deep-scan implement |
| LUN | Pagination `?page=2` novel ids | **PASS** | 3/3 | `lun-pagination/summary-1790404020575.json` — path `/page/2`=404; `?offset=24` duplicates page1 | `LUN_POLL_PAGE_BUDGET=2` + `buildLunCategoryPageUrl` |
| DIM.RIA | Current searchEngine JSON | **PASS_CURRENT** | 3/3 | `domria-search/summary-1790404032352.json` — apartment/house page0 + apartment page1 parse ok | Body-kind classifier in notes on PF |
| DIM.RIA | Sep 25 historical parser_failure root cause | **UNRESOLVED** | n/a | No retained Sep 25 response body; current OK must not be labeled historical resolution | Notes: `historical_root_cause=unresolved` |

## Probe commands

```bash
RENT_RADAR_COMMIT=$(git rev-parse --short HEAD) npx tsx src/scripts/olx-live-radius-sort-evidence.ts
RENT_RADAR_COMMIT=$(git rev-parse --short HEAD) npx tsx src/scripts/olx-live-sort-evidence.ts
RENT_RADAR_COMMIT=$(git rev-parse --short HEAD) npx tsx src/scripts/lun-live-pagination-evidence.ts
RENT_RADAR_COMMIT=$(git rev-parse --short HEAD) npx tsx src/scripts/domria-live-search-evidence.ts
```

## Unit tests (narrow)

```bash
npm test -- --run tests/lun-pagination.test.ts tests/domria-newest.test.ts tests/olx-coverage-and-decision-trace.test.ts tests/lun-parser.test.ts
```
