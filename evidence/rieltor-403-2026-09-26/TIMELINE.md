# RIELTOR HTTP 403 — 2026-09-26 08:50–09:45 Europe/Kyiv

## Production commit

| Field | Value |
|---|---|
| Commit | `a069dac4dfb4cc38a792d8389a88c882bdb9811a` (`a069dac`) |
| Message | fix: bound exact OLX seller browser cleanup |
| Process | `node --import tsx ./src/scripts/test-telegram-poll.ts` pid 60605 |
| Unit | `rent-radar-telegram.service` |
| ActiveEnterTimestamp | 2026-09-25 07:28:35 UTC |
| Worktree HEAD at incident | same `a069dac` on `main` |

No deploy/restart occurred during the window.

## Log source

- Structured lines: `/home/ubuntu/rent-radar-runtime/telegram-test/service.log`
- `journalctl --user -u rent-radar-telegram.service` for the window had essentially no app payload (logging goes to `service.log`).
- Alert Telegram text is not mirrored into `service.log`; lifecycle is confirmed via SQLite `source_admin_alerts`.

## Sequence (Europe/Kyiv = UTC+3)

Poll start/end are **not** logged as dedicated events. Approximate cycle bounds use co-located source `*.inspect` times (~10 min cadence).

| Kyiv | UTC | Event | Category/page | Status | requestedUrl = finalUrl | server | cf-ray | via | x-cache | content-type | content-length | title | bodySha256 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 08:48:56 | 05:48:56Z | `rieltor.inspect` ok | apt+house (requestCount=2) | 200 | *(not logged on success)* | — | — | — | — | — | — | — | — | count=7, boundaryReached |
| 08:58:57 | 05:58:57Z | `rieltor.inspect` ok | apt+house (2) | 200 | — | — | — | — | — | — | — | — | — | count=7; last OK before blocks |
| 09:08:52 | 06:08:52.997Z | `rieltor.block_fingerprint` | flats-rent page1 | 403 | `…/lvov/flats-rent/?sort=bycreated` | cloudflare | a41018bb2b4dfb22-MUC | *(absent)* | *(absent)* | text/html; charset=UTF-8 | *(absent)* | Just a moment... | ee438ffb…dabf3e | challenge_html; setCookieNames=[] |
| 09:08:52 | 06:08:52.998Z | `rieltor.inspect` | stopped after page1 (requestCount=1) | 403 | same | — | — | — | — | — | — | — | — | resultKind=http_error; coverageTruncated |
| 09:18:53 | 06:18:53.008Z | `rieltor.block_fingerprint` | flats-rent page1 | 403 | same | cloudflare | a41027613c95e32a-MUC | absent | absent | text/html; charset=UTF-8 | absent | Just a moment... | f8631d02…c3b1f4 | challenge_html |
| 09:18:53 | 06:18:53.009Z | `rieltor.inspect` | requestCount=1 | 403 | same | — | — | — | — | — | — | — | — | http_error |
| 09:28:53 | 06:28:53.094Z | `rieltor.block_fingerprint` | flats-rent page1 | 403 | same | cloudflare | a4103607cf6e6ddc-MUC | absent | absent | text/html; charset=UTF-8 | absent | Just a moment... | cb9507a1…847457 | challenge_html |
| 09:28:53 | 06:28:53.095Z | `rieltor.inspect` | requestCount=1 | 403 | same | — | — | — | — | — | — | — | — | 3rd consecutive failure |
| 09:39:04 | 06:39:04.469Z | `rieltor.inspect` ok **recovery** | apt+house (2) | 200 | — | — | — | — | — | — | — | — | — | count=8, boundaryReached |
| 09:40:49 | 06:40:49.475Z | `source_admin_alerts` recovery | — | — | — | — | — | — | — | — | — | — | — | DB: last_alert_kind=recovery, incident_open=0 |
| 09:48:57 | 06:48:57.814Z | `rieltor.inspect` ok | apt+house (2) | 200 | — | — | — | — | — | — | — | — | — | count=6 |

Post-window health (read 2026-09-26): `status=ok`, `consecutive_failures=0`, `last_failure_at=2026-09-26T06:28:53.098Z`, `last_success_at=2026-09-26T06:48:57.850Z`.

## Compare blocked vs successful (same VM)

| | Blocked (×3) | Successful (adjacent polls same host) |
|---|---|---|
| HTTP status | 403 | 200 |
| Body class | Cloudflare challenge HTML (`Just a moment...`) | Catalog extract succeeded (listings count 6–8) |
| requestCount | 1 (abort on apartments page 1) | 2 (apartments + houses) |
| URL | flats-rent `?sort=bycreated`; finalUrl unchanged | Not fingerprint-logged |
| server / cf-ray | cloudflare / `*-MUC` | **Not logged** for 200 responses |
| via / x-cache / content-length | Never present on any of 33 lifetime fingerprints | Unknown for 200 |
| bodySha256 | Distinct each block | Not logged for 200 |

## Root cause statement

**Supported by evidence:** each failure was an HTTP 403 whose body was classified `challenge_html` (title `Just a moment...`, `server=cloudflare`, CF-Ray PoP MUC) for the normal flats-rent newest URL, with no redirect (`requestedUrl === finalUrl`). Recovery was a later HTTP 200 catalog poll on the same process/commit without restart.

**Not supported (missing evidence):** why Cloudflare issued the challenge (IP reputation, rate, JS challenge token, WAF rule id, upstream vs edge). No retained 403 body bytes (hash only). No header/body fingerprint for successful 200 responses to compare beyond status and listing counts. No structured poll start/end records. Incident Telegram text not in `service.log` (only DB recovery row).

A simulated 403 in tests does **not** explain the live Cloudflare challenge.

## 09:39 recovery coverage (cycle 140) — PARTIAL

Poll cycle from `live:test-telegram:poll.cycle`:

| Field | Evidence |
|---|---|
| Cycle | 140 |
| Poll start / end | `2026-09-26T06:38:51.538Z` – `2026-09-26T06:40:49.475Z` (09:38:51–09:40:49 Kyiv) |
| `rieltor.inspect` | `06:39:04.469Z`, status **200**, count **8**, `requestCount=2`, `boundaryReached=true`, `coverageTruncated=false` |
| sourceAttempts.rieltor | ok, listingCount=8, acceptedCount=0 (all 8 `sellerRejectedIntermediary`) |

### Catch-up / boundary (SQLite `schema_meta` after recovery; no historical meta snapshots)

| Key | Value at read-time (post-incident) |
|---|---|
| `rieltor_incremental_catchup_apartment` | **absent** (no catch-up cursor retained) |
| `rieltor_incremental_catchup_house` | **absent** |
| `rieltor_incremental_boundary_apartment` | `2026-09-26T06:01:19.000Z` |
| `rieltor_incremental_boundary_house` | `2026-09-25T12:56:25.000Z` |

**Catch-up target / resumePage at 09:39:** not present in cycle logs or `rieltor.inspect` fields. Current DB has **no** catch-up keys (consistent with `boundaryReached=true` clearing catch-up). Whether a catch-up row existed briefly after the 403 polls is **not logged**.

**Pages fetched:** not logged as `pagesFetched`. Only `requestCount=2` is recorded (insufficient to prove which page numbers ran per category).

**Publication times of the 8 recovery cards:** not logged (`collectedSourceIds` absent; `listings` table has **0** rieltor rows; `seen_listings` has 4 rieltor ids all first_seen 2026-09-19 with `published_at=null`).

### Gap 08:58–09:39 (05:58–06:39 UTC) coverage verdict: **PARTIAL**

| Claim | Status |
|---|---|
| Recovery HTTP 200 after three 403s | Proven |
| Boundary advanced to apartment `06:01:19Z` (inside the gap clock window) | Proven in current meta; **not** proven which poll wrote it (140 vs 141) |
| Every listing published between 08:58 and 09:39 was collected | **Not proven** — no per-listing publication times, page list, or catalog truth retained |
| Infer PASS for gap coverage | **Forbidden** — mark **PARTIAL** |

A later cycle 141 (`06:48`) also returned ok with count=6; still no publication-time inventory in logs/DB.
