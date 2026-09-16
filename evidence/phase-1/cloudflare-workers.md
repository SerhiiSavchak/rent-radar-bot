# Cloudflare Workers Free probe (Phase 1)

Date: 2026-09-16. Account: Workers Free (`itsavchak@gmail.com`). No paid plan, no D1, no SQLite.

Official limits: https://developers.cloudflare.com/workers/platform/limits/  
CPU **10 ms** per HTTP request and per Cron Trigger. Waiting on `fetch` is not CPU; parsing is.

## Deployed experiment (then deleted)

| Item | Value |
|------|-------|
| Worker | `rent-radar-phase1-probe` |
| URL | `https://rent-radar-phase1-probe.rrb-phase1-free.workers.dev` |
| Auth | `PROBE_TOKEN` secret; missing/wrong → 401 |
| Cron | not enabled |
| Cleanup | **deleted** 2026-09-16 after cycles |

### Hosted `/live-olx` (real `OlxSource`)

| Cycle | Time (UTC) | Apartments | Houses | Platform cpuTime |
|-------|------------|------------|--------|------------------|
| 1 | 21:25 | ok / 200 JSON / 10 / Lviv+Басівка | ok / 200 / 10 / suburbs | **45 ms** |
| 2 | 21:49 | ok / 10 / Сокільники+Lviv | ok / 10 / suburbs | **36–41 ms** |
| 3 | 22:01 | ok / 10 / Lviv+Винники | ok / 10 / suburbs | **8 ms** |

JSON artifacts: `cloudflare-hosted-live-olx-cycle*.json`, `cloudflare-hosted-live-olx-poll.log`.

### Hosted `/fixtures`

All six fixture parses `ok`. Platform **cpuTime 19 ms** (no network; parse only).

## Local (this workstation)

| Probe | Result |
|-------|--------|
| fixtures | ok |
| live-olx | JSON **403** both categories |

## Verdicts

| Gate | Verdict |
|------|---------|
| Hosted OLX access | **PASS** |
| Parser CPU vs Free 10 ms | **FAIL** for live OLX-alone (typically 28–45 ms; see `cloudflare-cpu-attribution.md`) |
| Fixture batch 19 ms | **Not** a production cycle (includes ~1.14 MiB padding fixture) |
| Full four-source Free cron | **Disqualified** (OLX-alone already usually over budget) |
| Repeated ~10 min polling (access) | **PASS** (3 cycles) |

**Decision:** reject Workers Free for the unattended poller CPU budget (verdict B). Access success does not imply Free CPU fitness.
