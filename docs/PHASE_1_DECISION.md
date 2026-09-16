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
| Free CPU budget (10 ms / request, [limits](https://developers.cloudflare.com/workers/platform/limits/)) | **FAIL** for measured OLX-alone work |
| Full four-source live cycle on Free | **Not measured**; not needed to reject (OLX-alone already usually over budget) |
| Browser required for OLX | **Not claimed** — ordinary HTTP worked on Workers |

Attribution detail: `evidence/phase-1/cloudflare-cpu-attribution.md`.

Supporting CPU samples (platform `cpuTime`, not Node wall time):

- `/live-olx` cycle 1 (`a3bab41d5a2c324d`): **45 ms**
- Further `/live-olx` samples: **36 ms, 41 ms, 28 ms**
- `/live-olx` cycle 3 (`a3bae986fdf29ce0`): **8 ms** (one under-limit sample; not headroom)
- `/fixtures` padded batch: **19 ms** (includes artificial ~1.14 MiB fixture — **not** a production cycle)

No credible single optimization closes Free CPU for OLX + DIM.RIA + LUN + RIELTOR + later normalize/dedup/persist/delivery. Redeploy skipped.

Temporary Worker was deleted after the earlier experiment; no new deploy in this decision pass.

## Oracle Always Free E2.1.Micro — OLX HTTP experiment

**Executed** on operator VM (public IP recorded by operator: `92.5.160.179`): Ubuntu, Node 22.23.2, x64, `npm run live:olx:experiment`, cycle 1 only.

| Scope | Result |
|-------|--------|
| Process / script start | OK |
| OLX `api/v1/offers` (apartments + houses) | **FAIL** — HTTP 403, CloudFront `text/html` |
| HTML fallback | HTTP 200, **no** parseable listings → not PASS |
| Experiment classification | API 403 → `transport_blocked`; bare HTML 200 ≠ success |
| Further HTTP cycles / bypass / proxies | **Not run** |

Evidence: `evidence/phase-1/oracle-olx/oracle-cycle-1-review.md` (raw `cycle-1.json` commit when available).

Compare: Cloudflare Workers egress had OLX JSON **PASS**; this Always Free Micro egress matched workstation-style **403** CloudFront for ordinary Node HTTP.

## Oracle Always Free — OLX browser probe (prepared)

Isolated script: `npm run live:olx:browser-experiment` (stock Playwright Chromium; no stealth/proxies/CAPTCHA/WAF bypass; not wired into production `OlxSource`).

| Scope | Result |
|-------|--------|
| Probe implemented in repo | **YES** |
| Run from Oracle IP | **NOT TESTED** (awaiting operator one-cycle run) |
| Browser transport PASS/FAIL | **NOT TESTED** |

Evidence directory: `evidence/phase-1/oracle-olx-browser/`.

## Source layer status

| Source | Status |
|--------|--------|
| OLX | Query/parser verified; **Workers HTTP PASS**; **Oracle Micro HTTP FAIL** (403); workstation 403; **Oracle browser NOT TESTED** |
| DIM.RIA | Live HTML OK; char 1437 ownership; free API quota incompatible with 10-min polls |
| LUN | Live OK; first-page / unofficial RSC |
| RIELTOR | Live OK; **owner-filtered** market is small (2026-09-16: apt `declared=3` complete, houses `valid_empty`); unfiltered 743≈38 pages is **not** the owner product path. `OWNER_ONLY` now drives `f-owners=1`. Suburb coverage on owner apartments still thin (n=3). Multi-day soak open. |

## Remaining Phase 1 blockers

1. Hosted zero-cost runtime where OLX works **and** CPU/cost fit (Workers Free rejected on CPU; Oracle Micro ordinary HTTP rejected on 403).  
2. Whether stock Chromium from the Oracle IP can load OLX catalogs with listing payload — **not measured yet**.  
3. Multi-day source soak from a controlled host that can reach OLX.  
4. Optional: deeper non-owner RIELTOR pagination only if product scope drops `OWNER_ONLY`.

## Recommended next action (one)

On the Oracle VM, install Chromium deps and run **one** browser cycle only:

```bash
npx playwright install --with-deps chromium
OLX_BROWSER_OUT_DIR=evidence/phase-1/oracle-olx-browser npm run live:olx:browser-experiment
```

Then commit `evidence/phase-1/oracle-olx-browser/cycle-1.json`. Do not add bypass techniques.
