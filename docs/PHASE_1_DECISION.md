# Phase 1 decision (source layer)

Date: 2026-09-16  
Branch: `cursor/phase-1-source-layer-closure-8797`  
Repo: `rent-radar-bot` / `SerhiiSavchak/rent-radar-bot`  
Verified HEAD at decision update: see latest commit on this branch (recovery + CPU attribution).

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

## Next host candidate (docs only — not provisioned)

From `evidence/phase-1/http-runtime.md`: **Oracle Always Free `VM.Standard.E2.1.Micro`**.  
Unresolved until an explicit provisioning task: OLX/CloudFront on that IP, capacity, idle-reclaim, cycle RSS/CPU. Do not register or create VMs from this task.

## Source layer status

| Source | Status |
|--------|--------|
| OLX | Query/parser verified; hosted HTTP OK; workstation 403 |
| DIM.RIA | Live HTML OK; char 1437 ownership; free API quota incompatible with 10-min polls |
| LUN | Live OK; first-page / unofficial RSC |
| RIELTOR | Live OK; **owner-filtered** market is small (2026-09-16: apt `declared=3` complete, houses `valid_empty`); unfiltered 743≈38 pages is **not** the owner product path. `OWNER_ONLY` now drives `f-owners=1`. Suburb coverage on owner apartments still thin (n=3). Multi-day soak open. |

## Remaining Phase 1 blockers

1. Hosted zero-cost runtime other than Workers Free (Oracle candidate not provisioned).  
2. Multi-day source soak from a controlled host.  
3. Optional: deeper non-owner RIELTOR pagination only if product scope drops `OWNER_ONLY`.

## Recommended next action (one)

**Open an explicit task to provision and smoke-test Oracle Always Free `E2.1.Micro` with `npm run live:olx` only** (ordinary HTTP, no proxies). Do not reopen Workers Free CPU validation unless the Free limit or workload changes with new measurements.
