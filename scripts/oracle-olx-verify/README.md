# Oracle OLX verification (catalog timing fix + one owner-detail)

Run this **after SSH login**. Do not start it from the development workstation. No Telegram.

## Sequence

```bash
# 0) SSH into the Oracle VM first, then:

set -euo pipefail
cd ~/rent-radar-bot

# 1) Refuse concurrent project pollers
pgrep -af 'live:test-telegram|live:oracle:soak|olx-browser-extract|olx-owner-detail' && echo 'STOP: poller running' && exit 1

# 2) Intended commit = origin tip of this branch after the owner-detail push
git fetch origin
export INTENDED_COMMIT=$(git rev-parse origin/cursor/phase-1-source-layer-closure-8797)
chmod +x scripts/oracle-olx-verify/run-olx-verify.sh
./scripts/oracle-olx-verify/run-olx-verify.sh
```

The script:

1. Stops on `git fetch` / `git merge --ff-only` / `npm ci` errors **inside a subshell**.
2. Verifies `HEAD == INTENDED_COMMIT`.
3. Creates a unique `~/rent-radar-runtime/olx-verify-<stamp>-<sha>/`.
4. Runs the existing catalog extract (`npm run live:olx:browser-extract`) to verify the `1446347` timing fix live.
5. Starts the owner-detail diagnostic **only after that process has exited**.
6. Leaves both JSON result directories in the unique runtime folder (outside git).

`ENABLE_OLX` stays false. Telegram is not started.

## What to read afterwards

- `catalog/extract-*.json` — `extractionOk`, `wallClockMs` vs `totalBudgetMs`, `timedOut`, `browserClosed`, whether houses still hang after a successful parse.
- `owner-detail/owner-detail-*.json` — `inspection.platformLabel`, `sellerTypeField`, `strongerThanCatalogSelfDeclared`, `elapsedMs`, `timedOut`, `browserClosed`.

If `strongerThanCatalogSelfDeclared` is false (missing/null platform seller role), this OLX ownership investigation is **closed**. Do not add further speculative probes.

## Production acceptance (still required, not this sequence)

Durable baseline / dedupe / outbox and restart recovery are **explicitly required** before production Telegram acceptance. In-memory TEST state is not enough.

## Next source task

RIELTOR access / owner-filter reliability — not another OLX catalog experiment.
