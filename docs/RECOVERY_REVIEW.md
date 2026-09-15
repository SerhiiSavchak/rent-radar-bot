# Recovery review (2026-09-16)

Branch: `cursor/phase-1-source-layer-closure-8797`  
Verified HEAD at review start: `689e6d9`  
Repo: `SerhiiSavchak/rent-radar-bot`  
Reviewer method: inspect repository first; treat prior chat claims as leads only.

## Baseline

| Command | Result |
|---------|--------|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` | **35** then **38** after regression tests |
| `npm run probe:cf:fixtures` | 6 fixture parses `ok` |
| `npm run probe:cf:olx` (this PC) | JSON **403** both categories; HTML 200; `parser_failure` |
| `npm run live:domria` | **PASS** |
| `npm run live:lun` | **PASS** |
| `npm run live:rieltor` | **PASS** |

No Telegram messages were sent.

## Inventory classification

| Component | Class |
|-----------|--------|
| OLX adapter (`olx.source` / `olx.parser`) | **Implemented and verified** locally for parse/query; **hosted live verified** on Workers Free (3 cycles) |
| DIM.RIA adapter | **Implemented and verified** live HTML; official API key unset |
| LUN adapter | **Implemented and verified** live |
| RIELTOR adapter | **Implemented and verified** live first-page; full catalog pagination **incomplete** |
| Cloudflare Workers probe | **Implemented and verified** (deployed, auth, fixtures, live-olx) |
| PostgreSQL persistent state | **Missing** (SQLite prototype present; Phase 3) |
| Telegram delivery | **Implemented but unverified** this session (not exercised) |
| Hosted zero-cost full 4-source soak | **Incomplete** / **OPEN** |
| `AGENTS.md` | **Missing** |

## Findings

### Critical

1. **Workers Free CPU budget exceeded for OLX-only live cycle**  
   Evidence (`wrangler tail` platform `cpuTime`, not wall time):
   - `/live-olx` cycle 1: **45 ms**
   - cycle 2: **36–41 ms** (two samples)
   - later sample: **28 ms**
   - cycle 3: **8 ms** (under 10 ms once)
   - `/fixtures` (all parsers, no network parse-heavy): **19 ms**  
   Free limit is **10 ms** CPU per request. Occasional overrun may succeed, but **consistent** OLX-only work is already above budget. Four-source HTML parse is **not** feasible on Free cron.  
   Consequence: Cloudflare Workers Free is **unsuitable** as the unattended 10-minute host for the full source layer.

### High

2. **`agencyId` forced `sellerType=agent`** in `classifyOwner`  
   Contradicted Phase 1 rule that `agency_id` is evidence only (DIM.RIA). LUN also passed `agencyId`, so owner+agency cards could become agents.  
   **Fixed**: `platformOwner` wins; `agencyId` is evidence-only; explicit `platformAgent` still classifies agent.

3. **Probe `blocked` flag false-negative / false-positive**  
   - Before: HTML 200 hid JSON 403 (`blocked=false` while CloudFront blocked API).  
   - Intermediate bug: any “CloudFront” string marked blocked (CDN appears on 200 JSON).  
   **Fixed**: `isOlxTransportBlocked()` looks for `api/v1/offers` → 403/429 specifically.

4. **Stale decision docs** claimed wrangler unauthenticated and remote stuck at `dd8280c`.  
   Verified: wrangler OAuth logged in; remote HEAD `689e6d9`.

### Medium

5. **SQLite / `DATABASE_PATH`** still in runtime (`src/storage/db.ts`, `.env.example`). PostgreSQL remains the planned store; no D1 migration attempted. Acceptable for Phase 1 prototype only.

6. **OLX `propertyType` sometimes `unknown`** on live hosted samples (3 of 10 apartments). Title-only detection misses some long-term rent flats.

7. **RIELTOR catalog truncation** — first-page scans remain incomplete by design (`TRUNCATED`).

8. **LUN first-page only** — no deep pagination; OLX-via-LUN incomplete (prior evidence).

9. **README** still says “Phase 0” and documents SQLite as production-ish.

### Low / notes

10. Commit `689e6d9` message is `"фвв"` (noise).  
11. Latest commit author on branch is the operator’s identity; recovery preserved all commits.

## Hosted Cloudflare experiment (bounded)

| Item | Value |
|------|-------|
| Account | Free Workers (authorized); plan not upgraded |
| URL | `https://rent-radar-phase1-probe.rrb-phase1-free.workers.dev` |
| Auth | `/fixtures` and `/live-olx` require `x-probe-token`; wrong/missing → 401; POST → 405 |
| Cron | not enabled |
| OLX apartments | 200 JSON, `ok`, 10 listings, Lviv + suburbs (Басівка, Винники, Сокільники…) |
| OLX houses | 200 JSON, `ok`, 10 listings, Lviv + ~15 km suburbs |
| Polling | 3 cycles (~10 min spacing between 2 and 3); all `ok` |
| CPU | platform `cpuTime` 8–45 ms (see Critical #1) |
| Cleanup | Worker deleted after evidence capture |

Cursor WebFetch success is **not** cited as hosted proof. Hosted Workers egress is the evidence.

## Source verdicts (Phase 1)

| Source | Access (this PC) | Access (Workers Free) | Parser / role evidence | Phase 1 gate |
|--------|------------------|------------------------|------------------------|--------------|
| OLX | JSON 403 | **PASS** (3×) | private≠owner; map coords; created_time | Access OK; **runtime CPU FAIL** on Free |
| DIM.RIA | HTML PASS | not hosted-tested | char 1437; agency_id evidence-only | Local OK |
| LUN | PASS | not hosted-tested | isOwner / agency | Local OK |
| RIELTOR | PASS (truncated) | not hosted-tested | Власник/Рієлтор; ignore “поруч” | Local OK, pagination open |

## What was fixed this session

- `isOlxTransportBlocked` + regression test  
- `classifyOwner` agency_id / owner priority + tests  
- Evidence + decision docs updated to match repository  

## Remaining Phase 1 blockers

1. **Hosted zero-cost runtime that fits CPU + OLX access** — Workers Free **disqualified** by measured CPU. Do **not** provision Oracle in this task; next session must pick the next already-documented HTTP candidate **only after** this verdict is recorded.  
2. Full four-source hosted cycle not measured (would exceed Free further).  
3. RIELTOR full pagination / multi-day soak.  
4. DIM.RIA free API quota incompatible with 10-minute polls (HTML fallback OK).  

## Phase 1 status

**NOT COMPLETE.** Mandatory hosted-autonomy gate remains open after Workers Free CPU failure.
