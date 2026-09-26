# OLX order-independent coverage — budget limit (BLOCKED)

**Verdict: BLOCKED.** Catalog end for apartments was **not** established (`confirmed_empty` never observed). Do **not** claim that a complete scan exceeds the ~95 s OLX budget — complete-scan wall time is still unproven. Time-stop remains **disabled**. Sort gate remains **BLOCKED**. No deploy. Poller / frequency / source settings unchanged.

## ~95 s OLX budget — what it is

| Item | Value | Nature |
|---|---|---|
| Default `OLX_BROWSER_TIMEOUT_MS` | 45 000 | Per-navigation timeout default |
| Default `OLX_BROWSER_CATEGORY_BUDGET_MS` | same as timeout (45 000) | Per-category wall abort in extract |
| Default `OLX_BROWSER_TOTAL_BUDGET_MS` | `category×2 + 5 000` → **95 000** | Hard **configured** extract abort for apartments+houses (`resolveOlxBrowserBudgets` / `olx-browser.extract.ts`) |
| Env override | yes | Not fixed in code forever; defaults are hard abort when unset |
| `TELEGRAM_POLL_INTERVAL_MS` | **600 000** (10 min) | Separate poll cadence; **not** the OLX extract budget |

So ~95 s is a **hard default extract/total budget** (env-overridable), not the poll interval and not an inherent OLX site limit.

## Measured result set

### Prior depth (`depth-timing-1790407832189.json`)

| Category | Pages | Unique ids | Stop | Elapsed | Notes |
|---|---|---|---|---|---|
| apartments | 1–25 | 1004 | `max_pages_cap` | 74 903 ms | **40 novel ids still on page 25** |
| houses | 1–4 | 89 | `confirmed_empty` @4 | 8 562 ms | End proven for houses only |

### Continue-from-26 (`apartments-from26-1790408583920.json`)

Same query builder (`dist=15`, `order=created_at:desc`), respectful 500 ms gap, wall cap 300 s. Stop rules: **only** `confirmed_empty` or `wall_cap_300s` (no zero-novel early stop).

| Field | Value |
|---|---|
| Pages fetched | **197** (page **26 → 222**) |
| Stop reason | **`wall_cap_300s`** |
| `confirmedEmptyAt` | **null** (no empty/end page) |
| `totalElements` (metadata) | **1000** on every page |
| Novel ids this segment | **51** (all on page **26**); pages **27–222** = 52 cards, **0 novel** |
| Elapsed | **300 255 ms** |
| navMs | min 657 / max 2838 / avg **985** |
| Empty pages | **none** through page 222 |

Page-26 sample: status 200, 52 cards, 51 novel, navMs≈2838, `totalElements=1000`. Tail (218–222): still 52 cards / 0 novel / `totalElements=1000`.

## Complete-scan time vs ~95 s and 600 s poll

| Question | Answer |
|---|---|
| Was a terminal empty page found? | **No** — stopped on 300 s cap at page 222 |
| Measured **complete** apartments scan time | **Unknown** — end not established |
| Claim “complete scan exceeds ~95 s budget”? | **Not allowed yet** — would require a proven end marker |
| Pages 1–25 alone | ~75 s (still novel) — already near default category/total budget pressure |
| Novelty plateau (observational only) | Last new ids in this continue-run on page 26; after that OLX keeps returning duplicate full pages |
| vs 600 s poll | Poll window is large enough for deep walks in wall-clock terms, but without `confirmed_empty` a walker has **no honest stop** other than caps/budgets |

**Multi-cycle complete scans / page-shift risk:** **not run**. Prerequisite was a terminal page within budget; that prerequisite failed.

## Miss risks (unchanged; page cursor still unsafe)

1. Insertions during a deep walk shift offsets.
2. Promotion / non-monotone ranking reshuffles page membership.
3. Duplicate ids across pages (observed: pages 27+ fully non-novel while still non-empty).
4. `totalElements=1000` looks like a result-window cap, **not** a proven last page (pages past that still return 52 cards).
5. Houses `confirmed_empty` does not rescue apartments.

Production remains `OLX_BROWSER_PAGE_BUDGET=2`, time-stop off, catch-up cursor — a **bounded sample**, not coverage PASS.

## What would lift BLOCKED

Live `confirmed_empty` (or equivalent stable end) for apartments **and** repeated full two-category scans fitting the configured OLX total budget with margin — **or** an id-set / watermark strategy that does not assume page order, similarly proven. None demonstrated here.

## Guarantee (honest)

| Claim | Status |
|---|---|
| Radius listing evidence | PASS (prior) |
| Sort / time-stop | BLOCKED / disabled |
| Apartments catalog end established | **No** (`wall_cap_300s` @ page 222; never empty) |
| Full order-independent catalog coverage per poll | **BLOCKED** |
| “Complete scan exceeds ~95 s” | **Not claimed** — complete time unproven |
| Partial page-1..2 sample per category | Operational; **not** completeness |
