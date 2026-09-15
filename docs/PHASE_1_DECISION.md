# Phase 1 decision (source layer)

Date: 2026-09-16  
Branch: `cursor/phase-1-source-layer-closure-8797`  
Repo: `rent-radar-bot` at `origin` GitHub `SerhiiSavchak/rent-radar-bot`  
Verified HEAD: `689e6d9` (local = `origin/cursor/phase-1-source-layer-closure-8797`)

This document records what is **in this repository**, what was **claimed elsewhere**, and what was **verified in recovery**. Phase 1 is **not complete**.

## Inventory of reported claims

| Claim | Repository evidence | Verdict |
|-------|---------------------|---------|
| Branch `cursor/phase-1-source-layer-closure-8797` | Present; tracks origin | **Verified** |
| Remote stuck at `dd8280c` | Remote HEAD is `689e6d9` including `dd8280c`…`ab63b81` | **Contradicted** (was stale) |
| 35 tests | `npm test` → 35, then 38 after recovery fixes | **Verified** (was 35 at start) |
| `wrangler` unauthenticated | `wrangler whoami` → logged in as `itsavchak@gmail.com` | **Contradicted** (docs were stale) |
| Hosted OLX NOT TESTED | Workers Free probe ran 3× `/live-olx` | **Superseded** — see below |
| Workers Free CPU OK | Platform `cpuTime` 8–45 ms on OLX-only | **FAIL** vs 10 ms Free limit |
| `AGENTS.md` | Not present | **Missing** |
| RIELTOR adapter | Present; live PASS; truncated catalogs | **Adapter present** |
| DIM.RIA characteristic 1437 | Parser + types | **Verified** |
| `agency_id` must not establish ownership | Fixed again 2026-09-16: evidence-only | **Verified + fixed** |
| OLX `business=false` ≠ owner | Parser | **Verified** |
| Hosted autonomous zero-cost full cycle | Not demonstrated | **OPEN** |

## Critical source corrections

### DIM.RIA

Ownership only from `characteristics_values["1437"]` (1436 owner, 1434/1435 agent, 1473/1506 business, else unknown).  
`agency_id` is evidence only.

### Owner classifier (2026-09-16)

`classifyOwner` no longer promotes `agencyId` alone to `agent`. Explicit `platformAgent` still does. `platformOwner` wins over agency id.

### OLX

- Geo/category: region **5**, city **176**, categories **1760/330**, `distance=15`.  
- Coords from `map.{lat,lon}`; `publishedAt` = `created_time`; URL token opaque string.  
- `business: false` → private-account evidence, not ownership.

### LUN

`inspectLunHtml` distinguishes `parser_failure` / `valid_empty` / `ok`.

### RIELTOR

Primary catalog only (`data-listing-items`); ignore recommended blocks; location validated; truncation recorded.

## OLX access (2026-09-16)

| Environment | Apartments | Houses |
|-------------|------------|--------|
| This workstation Node | JSON **403** | JSON **403** |
| Cursor WebFetch (prior) | 200 (not a host) | 200 (not a host) |
| **Cloudflare Workers Free** (egress) | **200 JSON, ok, 10 listings ×3 cycles** | **200 JSON, ok, 10 ×3** |

Hosted Workers proves OLX HTTP works from that egress. It does **not** prove Free-plan CPU headroom.

## Cloudflare Workers Free (bounded probe)

Probe: `probe/cloudflare-workers/` + `src/probe/`. No D1/SQLite/Telegram/cron.

| Gate | Verdict |
|------|---------|
| Deploy + auth | **PASS** |
| Hosted OLX apartments + houses | **PASS** (3 cycles ~10 min apart) |
| Platform CPU for OLX-only | **FAIL** (typically 28–45 ms; Free limit 10 ms; one sample 8 ms) |
| Fixture-only parse CPU | **19 ms** (already > 10 ms) |
| Full four-source live cycle | **OPEN** / expected worse |
| Unattended 10-minute Free cron | **Disqualified** |

Worker deleted after the bounded experiment (or pending cleanup if delete blocked — see `docs/RECOVERY_STATUS.md`).

## Remaining Phase 1 blockers

1. Need a **hosted zero-cost runtime** where OLX works **and** CPU/wall budget fits four sources every ~10 minutes. Workers Free is **not** that runtime.  
2. Do **not** provision Oracle from an interrupted session without operator confirmation; next action is recorded below.  
3. RIELTOR full pagination / soak.  
4. DIM.RIA official free quota incompatible with 144 cycles/day.  
5. Telegram not exercised in this review (by design).

## Recommended next action (one)

**Record Workers Free as CPU-disqualified for the full poller.** Next operator step: decide whether to test the next documented HTTP-only Always Free candidate (Oracle `E2.1.Micro` in `evidence/phase-1/http-runtime.md`) in a **new explicit task**, or accept a paid Workers plan (out of project zero-cost scope). Do not restart broad hosting research in parallel.

Phase 1 source layer is **not** marked complete.
