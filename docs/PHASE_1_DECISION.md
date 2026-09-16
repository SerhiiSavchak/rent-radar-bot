# Phase 1 decision (source layer)

Date: 2026-09-17  
Branch: `cursor/phase-1-source-layer-closure-8797`  
Repo: `rent-radar-bot` / `SerhiiSavchak/rent-radar-bot`

Phase 1 is **not complete**.

## Cloudflare Workers Free — final Phase 1 hosting decision

**Verdict: B — REJECT the current poller workload on Workers Free.**

| Scope | Result |
|-------|--------|
| OLX HTTP access from Workers egress | **PASS** (3 hosted `/live-olx` cycles) |
| Free CPU budget (10 ms / request) | **FAIL** for measured OLX-alone work |
| Browser required for OLX on Workers | **Not claimed** — ordinary HTTP worked |

Detail: `evidence/phase-1/cloudflare-cpu-attribution.md`.

## Oracle Always Free E2.1.Micro — HTTP vs browser

Operator VM: Ubuntu, Node 22, `VM.Standard.E2.1.Micro` (public IP recorded earlier: `92.5.160.179`).

| Scope | Result |
|-------|--------|
| OLX direct HTTP `api/v1/offers` | **FAIL** — CloudFront HTTP 403 HTML |
| OLX HTML without browser | HTTP 200, no supported listing payload → not PASS |
| OLX stock Playwright Chromium | **PASS** (preliminary) — apartments + houses `browser_accessible` in **3 consecutive** cycles ~10 min apart; evidence under `evidence/phase-1/oracle-olx-browser/` |
| Unattended multi-source soak (~2 h / 12 cycles) | **NOT TESTED** — harness ready: `npm run live:oracle:soak` |

Three browser cycles are preliminary only; they do **not** prove multi-day reliability.

## Source layer status

| Source | Status |
|--------|--------|
| OLX | Workers HTTP PASS; Oracle HTTP FAIL; Oracle browser preliminary PASS (3 cycles); soak unproven |
| DIM.RIA | Live HTML OK historically; soak unproven on Oracle |
| LUN | Live OK historically; soak unproven on Oracle |
| RIELTOR | Owner-filtered path historically OK (small inventory); soak unproven on Oracle |

## Remaining Phase 1 blockers

1. Unattended Oracle soak across all four sources (~2 h) — next gate.  
2. Multi-day reliability still unproven after any two-hour run.  
3. Production wiring (Telegram/DB/scheduler) remains out of Phase 1 soak scope.

## Recommended next action (one)

On the Oracle VM:

```bash
SOAK_CYCLES=12 \
SOAK_INTERVAL_MS=600000 \
SOAK_OUT_DIR=evidence/phase-1/oracle-soak \
npm run live:oracle:soak
```

Then commit `evidence/phase-1/oracle-soak/summary.json` + cycle files. No bypass techniques.
