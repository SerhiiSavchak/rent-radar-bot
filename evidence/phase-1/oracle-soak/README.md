# Oracle unattended soak (Phase 1)

Isolated harness: `npm run live:oracle:soak`

Tests **DIM.RIA**, **LUN**, **RIELTOR** (`preferOwners: true`), and **OLX via stock Playwright Chromium**.  
Direct OLX HTTP is recorded each cycle as diagnostic-only (`transport_blocked` / 403 expected on this host) and is **not** the success path.

## Exact Oracle command (~2 hours)

```bash
cd ~/rent-radar-bot   # or your clone path
git pull && npm ci
# Chromium already installed from the browser experiment; otherwise:
# npx playwright install --with-deps chromium

SOAK_CYCLES=12 \
SOAK_INTERVAL_MS=600000 \
SOAK_OUT_DIR=evidence/phase-1/oracle-soak \
npm run live:oracle:soak
```

Expected wall time: ~**2 hours** (11 × 10-minute sleeps after cycles + per-cycle work). Cycles never overlap.

## Outputs

- `evidence/phase-1/oracle-soak/cycle-N.json` — per cycle
- `evidence/phase-1/oracle-soak/summary.json` — final verdict

## Cycle status

| Status | Meaning |
|--------|---------|
| `complete` | All required sources succeeded (domria, lun, rieltor owners, olx_browser) |
| `degraded` | Mix of success and failure among required sources; cycle still finished all adapters |
| `failed` | All required sources failed |

`olx_http` never counts toward complete/degraded/failed.

## Summary verdict

| Verdict | Meaning |
|---------|---------|
| `PASS` | All requested cycles `complete` |
| `DEGRADED` | Run finished with mixed cycle health |
| `FAIL` | Fatal stop (e.g. repeated Chromium crashes) or every cycle `failed` |
| `ABORTED` | SIGINT/SIGTERM |

A two-hour PASS is **not** multi-day reliability.

## Constraints

No proxies, stealth, CAPTCHA solving, IP rotation, fingerprint spoofing, WAF bypass.  
No Telegram, database, production scheduler, or customer config changes.
