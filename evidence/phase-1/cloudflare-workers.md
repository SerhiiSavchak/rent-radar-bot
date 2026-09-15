# Cloudflare Workers Free probe (Phase 1)

Date: 2026-09-16 (local). No Workers account was used. No paid plan, no D1, no SQLite.

Official limits (Workers Free, docs updated 2026-09-05):
https://developers.cloudflare.com/workers/platform/limits/

- CPU **10 ms** per HTTP request **and** per Cron Trigger. **Waiting on `fetch` is not CPU time.** Parsing is.
- Memory 128 MB; subrequests 50; cron 5/account; cron wall 15 min; daily requests 100k.
- Occasional CPU overruns may be tolerated per isolate; **consistent** overruns terminate with Error 1102 (`exceededCpu`). That is not a budget.

## Adapter compatibility (this repo)

| Path | Node-only? | Workers |
|------|------------|---------|
| `src/sources/*/parser.ts` + filters + zod | no | yes |
| `src/utils/http.ts` (`fetch`, AbortController) | no | yes |
| `src/sources/*.source.ts` via `getConfig()` / `process.env` | Node env shape | yes **with** `nodejs_compat` |
| `dotenv` | scripts/index only | not bundled in probe |
| `node:sqlite` / `node:fs` | `src/storage/db.ts` only | **excluded** from probe (PostgreSQL remains later) |
| Telegram | outputs | excluded |

Small core change: `loadConfig` now types env as `Record<string, string | undefined>` (still reads `process.env`). Parsing behaviour unchanged.

Workers outbound `fetch` adds a `cf-worker` header and uses shared egress IPs. That is **not** the same transport as Cursor WebFetch. OLX may 403 even if WebFetch returned 200.

## Bundle (dry-run, not deployed)

```
npx wrangler deploy --dry-run --outdir dist-cf-probe --config probe/cloudflare-workers/wrangler.toml
```

Result: **Total Upload: 835.72 KiB / gzip: 135.86 KiB** (limit 64 MiB). Bindings: LOG_LEVEL, SOURCE_TIMEOUT_MS, SOURCE_MAX_RETRIES. No D1/KV/R2.

`wrangler whoami`: **not authenticated**. Hosted deploy: **NOT TESTED**.

## Local fixture parse (Node wall time ≠ Workers CPU)

| Fixture | Bytes | Wall ms | Kind | Accepted | Seller / geo |
|---------|-------|---------|------|----------|----------------|
| OLX 2 offers | 775 | 6 | ok | 2 | unknown+business; Львів/Солонка; coords |
| OLX 40 offers | 11412 | 1 | ok | 40 | | 
| RIELTOR 20 cards | 12002 | 2 | ok | 20 | 3 owner / 17 agent |
| RIELTOR 20 cards + ~1.2 MiB img padding | 1142802 | 4 | ok | 20 | same |
| LUN RSC 1 card | 483 | 2 | ok | 1 | owner |
| DIM.RIA `__INITIAL_STATE__` 1 listing | 538 | 2 | ok | 1 | owner via char 1437 |

These milliseconds are **local Node wall time**. They must not be quoted as production CPU.

Workers docs: “parse large payloads typically use 10–20 ms” CPU — that band **starts at the Free limit**. Full four-source HTML (LUN/RIELTOR/DIM.RIA pages ~1 MB each) is **not** established to fit 10 ms. Combined live cycle: **gate open**.

## Local live OLX (real adapter, this workstation)

`npm run probe:cf:olx` using verified params (region 5, city 176, categories 1760/330, distance=15):

| URL | HTTP | Content-Type |
|-----|------|----------------|
| apartments `category_id=1760` | **403** | CloudFront HTML |
| houses `category_id=330` | **200** | `application/json` |

Adapter resultKind **ok**, 10 records, cities include Львів and suburbs (Солонка, Сокільники, Брюховичі, Зимна Вода, …), 10/10 with coordinates, sellerType **business** on this sample. Wall 431 ms (network-dominated). `cpuMs` **null**. `blocked=false` overall because houses succeeded.

This is **not** hosted Workers execution.

## Hosted OLX / polling

**NOT TESTED.** No `CLOUDFLARE_API_TOKEN`, `wrangler login` not done. Did **not** run `wrangler deploy --temporary` (that would create an unapproved preview account).

### Operator commands after `wrangler login`

```
cd probe/cloudflare-workers
npx wrangler secret put PROBE_TOKEN --config wrangler.toml
npx wrangler deploy --config wrangler.toml
curl -sS -H "x-probe-token: $PROBE_TOKEN" https://<worker>.workers.dev/fixtures
curl -sS -H "x-probe-token: $PROBE_TOKEN" https://<worker>.workers.dev/live-olx
npx wrangler tail --config wrangler.toml
```

One OLX cycle first. If real records and no 1102, optionally three GETs ~10 minutes apart. Then **delete the Worker or remove any cron** (`[triggers] crons` is not enabled in wrangler.toml).

## Verdicts

| Gate | Verdict |
|------|---------|
| Build/runtime compatibility | **Compatible enough to test** (bundle succeeded; sqlite/telegram excluded) |
| Parser CPU budget | **UNPROVEN** (local wall ≠ CPU; docs 10–20 ms for large parse) |
| Hosted OLX access | **NOT TESTED** (no account) |
| Full four-source cycle | **OPEN** |
| Repeated polling | **NOT TESTED** hosted; local 3×10 min was RIELTOR-only earlier |
