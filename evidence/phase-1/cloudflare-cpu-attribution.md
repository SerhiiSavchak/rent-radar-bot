# Cloudflare Workers Free — CPU attribution (2026-09-16)

Official Free limit (checked): **10 ms CPU time per request** and per Cron Trigger.  
Source: https://developers.cloudflare.com/workers/platform/limits/  
Waiting on `fetch` is not CPU; parsing/serialization/logging is.

Platform `cpuTime` / `wallTime` came from `wrangler tail --format json` during the 2026-09-15 hosted run.  
Client wall times and listing outcomes come from `evidence/phase-1/cloudflare-hosted-*.json`.  
Cold/warm isolate status was **not** exposed in the logs — left blank.

## Invocation table

| # | Timestamp (UTC) | ID (cf-ray) | Endpoint | Kind | Apt req | House req | HTTP / parser | Size notes | Platform cpuTime | Client/platform wall | Cold/warm | Outcome |
|---|-----------------|-------------|----------|------|---------|-----------|---------------|------------|------------------|----------------------|-----------|---------|
| 1 | 2026-09-15T21:25:22Z | `a3bab41d5a2c324d` | `/live-olx` | Live OLX (apt+house sequential) | 1 | 1 | both 200 JSON / `ok` / 10+10 | JSON offers (limit=10 each); response body not sized | **45 ms** | client 644 ms; platform wallTime 607 | unknown | ok (no exceededCpu) |
| 2 | 2026-09-15T21:42:04Z | (fixtures sample) | `/fixtures` | Fixture batch (6 parsers) | 0 | 0 | all fixture `ok` | 775 + 11412 + 12002 + **1 142 802** + 483 + 538 bytes | **19 ms** | client 192 ms; platform wallTime 19 | unknown | ok |
| 3 | ~21:49Z | `a3bad7b69f275b7e` (cycle 2 client) | `/live-olx` | Live OLX | 1 | 1 | both 200 / `ok` / 10+10 | same limit=10 | **36 ms or 41 ms** (two `/live-olx` samples in this window; see note) | client apt+house ~502 ms | unknown | ok |
| 4 | between redeploy and cycle 3 | (tail only) | `/live-olx` | Live OLX | 1 | 1 | ok (logs show olx.inspect) | — | **28 ms** (one sample) / **36 or 41 ms** (the other) | platform wallTime 526–565 | unknown | ok |
| 5 | 2026-09-15T22:01:50Z | `a3bae986fdf29ce0` | `/live-olx` | Live OLX | 1 | 1 | both 200 / `ok` / 10+10 | same | **8 ms** | client ~487 ms; platform wallTime 495 | unknown | ok |

**Note on cycle 2 / extras:** Tail recorded **four** `/live-olx` cpuTime values after fixtures: 36, 41, 28, 8. Client-documented cycles are three (`cycle1`→45, `cycle2`→cf-ray `a3bad7b69f275b7e`, `cycle3`→8). The extra one or two invocations were redeploy verification / duplicate hits in the same session — still real `/live-olx` adapter work, not fixtures. Per-invocation pairing of 36 vs 41 to cycle 2 vs redeploy is **not** recoverable without the deleted tail file; both exceed 10 ms.

## Explicit answers

1. **Which invocation produced 45 ms?**  
   `/live-olx` cycle 1, cf-ray `a3bab41d5a2c324d`, 2026-09-15T21:25:22Z. Apartments + houses in **one** Worker request.

2. **CPU for each actual `/live-olx`?**  
   Documented client cycles: **45 ms**, then **~36–41 ms** (cycle 2 window), then **8 ms** (cycle 3). Additional live sample(s) in-session: **28 ms** and possibly a second of {36,41}. **Majority ≥ 28 ms.** One sample (8 ms) under the Free limit.

3. **Did fixtures parse multiple / repeat / extra work?**  
   Yes. One `/fixtures` call runs **six** fixture parses in one invocation, including an artificial **~1.14 MiB** RIELTOR padding fixture used only for size stress. That work is **absent** from a real collection cycle. Fixture `cpuTime=19 ms` is therefore **not** a production four-source measurement.

4. **Probe work beyond the adapter?**  
   - `/live-olx` calls `OlxSource.inspectLatest` **twice** (apartments, then houses) instead of one combined call.  
   - Per category: tally sellerTypes/cities/propertyTypes, `sanitizeNotes`, build JSON fields.  
   - Worker: `JSON.stringify` of the full report.  
   - Adapter still does necessary `JSON.parse`, zod `safeParse` per offer, ownership/geo fields, `logger.info`.  
   Probe overhead exists but is **not** large enough to explain 28–45 ms → under 10 ms for production (production still parses both JSON payloads and later adds three HTML sources + filters/dedup/persist/delivery).

5. **What do the logs support?**  
   - **OLX-alone (both categories, one invocation): supported** — reject Free CPU for that workload on typical samples.  
   - **Fixture batch: supported only as a padded stress parse** — not a full live cycle.  
   - **Full four-source live cycle: not measured.** Not required to reject Free for the poller: OLX-only already usually exceeds 10 ms, and HTML parsers for DIM.RIA/LUN/RIELTOR would add CPU.

No `exceededCpu` / Error 1102 appeared in these samples (Free sometimes tolerates overruns). Policy: do **not** treat occasional success under/over the limit as budget headroom.

## Optimization decision (bounded)

Inspected for one straightforward win:

| Candidate | Verdict |
|-----------|---------|
| Combine two `inspectLatest` into one | Real probe inflation; savings unlikely to create **credible** Free headroom for OLX + 3 HTML sources + later phases |
| Drop zod / integrity | Forbidden |
| Remove 1.14 MiB fixture from production path | Already probe-only; does not change live OLX 28–45 ms |
| Cache listings across 10 min | Breaks freshness requirement |
| Split across Workers | Evasion of limits — forbidden |

**No small optimization closes the Free CPU gate.** Redeploy skipped.

## Verdict scope

**B — REJECT the current poller workload on Workers Free** for unattended ~10-minute collection of the required sources.  
This does **not** claim OLX needs a browser (hosted HTTP worked). It claims Free **CPU** is insufficient for the measured necessary OLX parse path, with no headroom for the remaining sources or later phases.
