# Release candidate — coverage, lifecycle, 24h observation

Branch: `incident-2026-09-25-investigation`  
Scope: gates for collection coverage, process lifecycle, observability, and a prepared 10-minute soak.  
Does **not** change seller policy, hosting, SQLite, or `TELEGRAM_POLL_INTERVAL_MS` (keeps 600000).

## 1. Coverage matrix (adapters that feed Telegram)

| Source | Queries / geography | Apt / house / long-term | Sort evidence | Pagination | Budgets | Stop | First-run | Recovery | Empty vs PF | Truncation | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **OLX browser** | Lviv long-term paths + requested `search[dist]=15` / `search[order]=created_at:desc` | Separate apartments / houses walks; house wall-clock reserve | Radius **PASS** (suburb listing evidence 2026-09-26 ×3); sort **BLOCKED** — organic created/refresh not monotone | Seed page 1; steady/catch-up up to `OLX_BROWSER_PAGE_BUDGET` (2); catch-up cursor in `schema_meta` | Pages + category/total ms; acquired cap 120/cat | Seed commits monitoring newest; time-stop **disabled** until HTML sort verified; confirmed_empty closes; else catch-up | Silent baseline + seed commit; no historical “new” flood | Catch-up resumePage persists across restarts; page 1 rechecked | confirmed_empty vs parse_failed / unknown | `coverage_degraded`, no boundary past acquired-cap discards | **PARTIAL** (radius PASS; sort BLOCKED; autonomous seed/catch-up PASS in tests) |
| **RIELTOR** | Lviv rent search `sort=bycreated` | apartment / house | Live newest-first noted 2026-09-22 | Up to 3 pages/cat; seed page 1; catch-up cursor | Page budget + request gap | `stopAt = target−30m`; empty/crossed/HTTP | Seed commits newest | Catch-up across polls | VE vs PF classified | `coverage_degraded` | **PASS** (sort evidence dated; keep monitoring) |
| **LUN** | Bare flats + houses Lviv URLs + live-verified `?page=N` | Two categories × `LUN_POLL_PAGE_BUDGET` (2) | Site default only — **no explicit sort param** | **PASS** `?page=2` novel ids 2026-09-26 ×3 (`/page/2` 404; offset duplicates) | Acquired cap 120/cat | End of bounded page sample (no catch-up cursor) | Silent baseline | No watermark/catch-up — deeper than page budget still unwalked | VE: RSC + 0 cards; PF: marker/parse | Cap / deeper-page fail → degraded | **PARTIAL** — page1+2 wired; deep backlog beyond budget not claimed |
| **DIM.RIA** | Newest search `sort=created_at` + bounded details | Apt/house caps | UI “Спочатку нові” mapping in code | Search page 0 only + detail cap | Detail caps / poll budget | Cap / deferred / fail | Known-id retention | Retained ids skip re-detail | VE vs PF distinguished; body_kind classifier on PF; **historical Sep 25 PF cause unresolved** | Truncated when deferred/fail | **PARTIAL** — current live PASS_CURRENT ×3; history **UNRESOLVED** |

**Historical incident A:** evidence was not retained; do not re-investigate the same dead end. Traces help *future* missing-listing forensics only.

## 2. Autonomous OLX bootstrap (no manual SQL)

1. **Fresh DB / no OLX keys:** seed page 1 → commit `olx_incremental_boundary_*` to newest organic → catch-up cleared. Baseline suppresses historical as “new”.
2. **Existing baseline, no OLX watermark:** `olxBootstrapTarget` from `source_baselines.established_at` until a boundary/catch-up exists.
3. **More pages than budget:** walk stores `olx_incremental_catchup_*` `{target, resumePage}`; next poll rechecks page 1 (new listings) then resumes deeper pages.
4. **Restart mid catch-up:** cursor survives in SQLite; no manual edit.
5. **Acquired-card cap:** discards cannot commit `committedBoundary` past dropped cards.

Time-based stop stays off while `olx_browser_sort_status=blocked` (radius is live-verified separately).

## 3. Lifecycle (isolated only — do not touch customer DB)

Unit covering lock/recovery: `tests/poller-lock.test.ts`, `tests/durable-recovery.test.ts`.

Isolated exercise (copy-paste on a **test** host/dir):

```bash
export RUNTIME_DIR=/tmp/rent-radar-rc-$$
export DATABASE_PATH=$RUNTIME_DIR/rc.sqlite
export HEARTBEAT_PATH=$RUNTIME_DIR/heartbeat.json
mkdir -p "$RUNTIME_DIR" && chmod 700 "$RUNTIME_DIR"
# Use TEST credentials only — never production telegram-test.env against customer DB
cp /path/to/telegram-test.env "$RUNTIME_DIR/env" && chmod 600 "$RUNTIME_DIR/env"
set -a && source "$RUNTIME_DIR/env" && set +a
export TELEGRAM_POLL_CYCLES=2 TELEGRAM_POLL_INTERVAL_MS=600000 ENABLE_OLX=false
# Start once
node --import tsx ./src/scripts/test-telegram-poll.ts &
PID=$!
# SIGTERM through the same tree you will use in systemd (KillMode=control-group)
kill -TERM $PID; wait $PID || true
# Confirm single lock holder after restart; no second concurrent poller
```

**VM reboot:** prepare only — do **not** reboot the customer VM in this task. Simulated `boot_id` tests ≠ real reboot.

Production unit template: `deploy/systemd/rent-radar-telegram.service` (`KillSignal=SIGTERM`, `TimeoutStopSec=45`, `KillMode=control-group`).

## 4. Observability (reuse existing)

Already present:

- Heartbeat JSON (`HEARTBEAT_PATH`) updated each cycle in `test-telegram-poll.ts`
- Poller lock: holder, PID, boot_id, heartbeat_at
- Source health + `coverage_degraded`
- Listing decision trace with `truncated` / `dropped` / `totalAttempted`
- `collectedSourceIdsComplete` on source attempts

Independent heartbeat watcher should read `HEARTBEAT_PATH` (or a sidecar), not the stuck poll loop. Test alerts → non-customer destination only.

**Resources:** measure the full tree including Chromium children — do not infer browser RSS from Node alone.

## 5. 24-hour observation procedure (10 minutes — do not start until approved)

Configuration:

- `TELEGRAM_POLL_INTERVAL_MS=600000` (unchanged)
- No overlapping cycles; one systemd unit
- No code changes during the window
- Expected starts ≈ `floor(observation_ms / 600000)` (≈144 over a clean 24h)

Report separately:

1. Process stability (restarts, lock steals, missed/late starts)
2. Collection quality (per-source ok / degraded / PF / blocked)
3. Delivery (sent / retry / uncertain Telegram outcomes)

Do **not** claim 24 hours passed during implementation.

## 6. Five-minute frequency — prepare only

Keep **10 minutes**. Five minutes ≈ 288 cycles/day vs 144. After a green 10-minute soak, compare measured:

- p50/p95/max cycle and source durations vs 300s headroom
- requests / pages / profile probes / retries per cycle
- 403/429 rates
- Oracle Always Free CPU/memory/network caps for the **actual** VM shape

Do not assume linear scaling. Propose a **separate** 5-minute trial only after the 10-minute baseline passes.

## 7. Migration / rollback (schema 11)

**Forward:** `applyMigrations` → 11 (adds `profile_likely_intermediary` via table rebuild).

**Rollback of code onto a DB that already stored `profile_likely_intermediary`:** blank “map all to unknown” is **not** proven safe — it can weaken `reject_intermediaries` for cached multi-address sellers until re-probed. Prefer: keep schema 11 CHECK; only roll application if needed. If CHECK must shrink: inspect rows, re-probe or hold, then migrate — do not blanket-downgrade without policy review.

**Deploy:** fixes take effect only after explicit pull + validate + restart. This document does **not** authorize that restart.

## 8. Candidate readiness

| Gate | Status |
|---|---|
| 1 OLX autonomous bootstrap / safer stop | Implemented + tests (sort still BLOCKED) |
| 2 Four-source audit | Documented; LUN/DIM.RIA/OLX radius **PARTIAL/BLOCKED** |
| 3 Lifecycle | Isolated procedure prepared; production not exercised |
| 4 Observability | Existing instrumentation reused; Chromium tree measurement is operator-side |
| 5 24h observation | Procedure ready; **not started** |

**Overall:** not a blanket PASS — observation may begin only after explicit deploy approval with known PARTIAL/BLOCKED items accepted.
