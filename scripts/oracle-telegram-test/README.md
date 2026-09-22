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

## systemd (Oracle VM)

User service + timer: start after reboot, restart on process failure, one active unit, logs and heartbeat. Secrets stay in `~/.config/rent-radar/telegram-test.env`. `ENABLE_OLX` stays false; set `ENABLE_OLX_BROWSER` explicitly in that file if you want Playwright.

```bash
sudo loginctl enable-linger "$USER"
chmod +x scripts/oracle-telegram-test/install-systemd.sh
./scripts/oracle-telegram-test/install-systemd.sh
systemctl --user start rent-radar-telegram.timer
systemctl --user start rent-radar-telegram.service
systemctl --user status rent-radar-telegram.service
```

## Safe Telegram canary (exactly one marked message)

Never sends inventory. Uses a separate SQLite file. Off unless both flags are exact `true`.

```bash
set -a
source ~/.config/rent-radar/telegram-test.env
set +a
TELEGRAM_TEST_MODE=true \
TELEGRAM_CANARY=true \
TELEGRAM_DRY_RUN=false \
TELEGRAM_CANARY_DATABASE_PATH="$HOME/rent-radar-runtime/telegram-test/rent-radar-canary.sqlite" \
npm run live:test-telegram:canary
```

SQLite default under systemd: `~/rent-radar-runtime/telegram-test/rent-radar.sqlite`.
Heartbeat: `~/rent-radar-runtime/telegram-test/heartbeat.json`.

Runtime artifacts (outside git): `~/rent-radar-runtime/telegram-test/{poll.log,poll.pid,poll.pgid,status.json,heartbeat.json,rent-radar.sqlite}`

Manual launcher default: 6 cycles × 10 minutes. systemd sets `TELEGRAM_POLL_CYCLES=0` (unbounded until SIGTERM). `FIRST_RUN_MODE=seed` (default) establishes a **silent per-source baseline** (no listing sends). `preview` sends a small «Початкова добірка» only.

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

- Deliverable Telegram sources: DIM.RIA, LUN, RIELTOR HTTP, and OLX **only** when `ENABLE_OLX_BROWSER=true`.
- `ENABLE_OLX` defaults false (blocked HTTP). `ENABLE_OLX_BROWSER` defaults false; when true, collection uses Playwright extract and never `api/v1/offers`.
- Live Oracle `3ec12cf`: OLX browser 86 listings; RIELTOR HTTP 200, 4 owner apartments, houses `valid_empty`.
- 2026-09-17 extract (`validatedListingCount=0`) is a different snapshot — see `evidence/phase-1/oracle-olx-browser-extract/README.md`.
- Live poll/oneshot persist baseline, seen IDs, freshness, and the Telegram outbox in local SQLite. Restart does not silent-rebaseline.
- Failed Telegram sends stay retryable; `sent` is recorded only after Telegram confirms success.
- Concurrent pollers are rejected (script flock + SQLite lock).
- RIELTOR intermittent HTTP 403 is classified as `transport_blocked` when request path/headers match soak (owners filter) — not a silent empty market.
- Source failures (`disabled` / `transport_blocked` / `parser_failure` / `transport_failure` / `browser_failure` / `valid_empty`) are reported distinctly; final summary includes partial coverage.
