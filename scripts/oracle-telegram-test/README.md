# Oracle: unattended 6-cycle TEST Telegram poll

Uses developer-owned `TELEGRAM_*` only. No Igor credentials. Does not start if soak/another poller is running.

## On the VM (after any running poll finishes)

```bash
set -euo pipefail
cd ~/rent-radar-bot

# 1) Stop the finished/old poll (kills owned process group: npm + tsx/node)
./scripts/oracle-telegram-test/run-telegram-test-poll.sh stop
./scripts/oracle-telegram-test/run-telegram-test-poll.sh status || true

# 2) Confirm no other project pollers
pgrep -af 'live:test-telegram|live:oracle:soak|olx-browser-extract' || echo 'no active pollers'

# 3) Update code (runtime logs stay outside the worktree)
git pull --ff-only
npm ci

# 4) Load test bot env (do not commit secrets)
set -a
source ~/.config/rent-radar/telegram-test.env
set +a

# Optional: capture LUN parse failures outside git
export LUN_CAPTURE_DIR="$HOME/rent-radar-runtime/lun-captures"

chmod +x scripts/oracle-telegram-test/run-telegram-test-poll.sh
./scripts/oracle-telegram-test/run-telegram-test-poll.sh validate
./scripts/oracle-telegram-test/run-telegram-test-poll.sh start
./scripts/oracle-telegram-test/run-telegram-test-poll.sh status
```

Runtime artifacts (outside git): `~/rent-radar-runtime/telegram-test/{poll.log,poll.pid,poll.pgid,status.json}`

Default: 6 cycles × 10 minutes ≈ 1 hour. `FIRST_RUN_MODE=seed` (default) marks cycle-1 inventory without listing sends.

## Lifecycle smoke (local, no network)

```bash
npm run test:lifecycle-smoke
```

## Bounded OLX extraction (no Telegram)

```bash
export OLX_BROWSER_EXTRACT=true
export OLX_BROWSER_OUT_DIR="$HOME/rent-radar-runtime/olx-browser-extract"
npm run live:olx:browser-extract
```

## Honesty notes

- Deliverable Telegram sources are HTTP adapters (typically DIM.RIA, LUN, RIELTOR).
- `ENABLE_OLX` defaults false; even if true, Telegram uses **OLX HTTP** (CloudFront-403 on Oracle).
- OLX browser **extract** is opt-in and separate from accessibility probes; not wired to Telegram until a live Oracle extraction check passes.
- Dedupe is **in-memory only** — does not survive process restart.
- Failed Telegram sends do not mark listings delivered.
- RIELTOR intermittent HTTP 403 is classified as `transport_blocked` when request path/headers match soak (owners filter) — not a silent empty market.
- Source failures (`disabled` / `transport_blocked` / `parser_failed` / `valid_empty`) are reported distinctly; final summary includes partial coverage.
