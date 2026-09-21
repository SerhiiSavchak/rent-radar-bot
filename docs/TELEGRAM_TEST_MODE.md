# TEST Telegram delivery

Isolated sink for developer-owned bot/chat only. Does **not** change Oracle soak, production adapters, or production defaults.

## Required env

```bash
TELEGRAM_TEST_MODE=true
TELEGRAM_BOT_TOKEN=<developer-test-bot-token>
TELEGRAM_CHAT_ID=<developer-test-chat-id>
```

Optional:

```bash
TELEGRAM_DRY_RUN=true          # format only, no HTTP send
TELEGRAM_POLL_CYCLES=6         # 0 = unbounded (systemd)
TELEGRAM_POLL_INTERVAL_MS=600000
FIRST_RUN_MODE=seed            # default: cycle 1 seeds inventory without listing sends
# FIRST_RUN_MODE=send          # treated as preview
DATABASE_PATH=./data/rent-radar.sqlite
```

`TELEGRAM_TEST_MODE` must be exactly `true`. Values like `1` / `True` are refused.

`TELEGRAM_DRY_RUN` is the single source of truth for Telegram dry-run. Startup, cycle, and summary logs all read `sink.dryRun` (exact `TELEGRAM_DRY_RUN=true`). A silent inventory seed no longer reports `dryRun=false`.

## Commands

One-shot (one collection → filter → dedupe → send):

```bash
TELEGRAM_TEST_MODE=true \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_CHAT_ID=... \
npm run live:test-telegram
```

Bounded poll (default 6 × 10 min). `TELEGRAM_POLL_CYCLES=0` runs until SIGTERM (systemd).

```bash
TELEGRAM_TEST_MODE=true \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_CHAT_ID=... \
TELEGRAM_POLL_CYCLES=6 \
TELEGRAM_POLL_INTERVAL_MS=600000 \
npm run live:test-telegram:poll
```

Safe canary (exactly one marked test message, isolated SQLite, never inventory). Off by default:

```bash
TELEGRAM_TEST_MODE=true \
TELEGRAM_CANARY=true \
TELEGRAM_DRY_RUN=false \
TELEGRAM_CANARY_DATABASE_PATH="$HOME/rent-radar-runtime/telegram-test/rent-radar-canary.sqlite" \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_CHAT_ID=... \
npm run live:test-telegram:canary
```

## Dedupe, baseline, and freshness

- Exact keys only: `source:sourceId` and canonical URL. No phone/price similarity merges.
- Live `live:test-telegram*` scripts persist baseline, seen IDs/fingerprints, freshness timestamps, and a Telegram outbox in **local SQLite** (`DATABASE_PATH`). No paid external store.
- First successful fetch per source is a **silent seed**. Restart reuses `established_at`; it does not silent-rebaseline.
- A listing first seen after downtime is classified against the persisted baseline (`late_discovered` vs new publication).
- Telegram outbox: `pending` → `sending` → `sent` only after the Bot API confirms success. Failed rows stay retryable. `sending` rows recover to `pending` on reopen.
- Duplicate cycles cannot send the same fingerprint twice. Concurrent pollers are rejected by a SQLite lock keyed by OS boot id + pid + starttime. A lock from a previous boot is stolen immediately; a live owner on this boot is not.
- A failed source fetch does **not** delete the last known baseline.
- In-memory stores remain in unit tests to document the old restart-rebaseline behaviour.
- Default `FIRST_RUN_MODE=seed`: first successful fetch per source establishes a silent baseline.
- `FIRST_RUN_MODE=preview`: sends a small sample labeled **«Початкова добірка»** (never «Нове оголошення»).
- After baseline, unseen listings are classified by `classifyListingFreshness`:
  - `withinAgeWindow` (default 7 days) is **necessary but not sufficient**
  - `publishedAt` after the per-source silent baseline → **Нова публікація**
  - `publishedAt` before the baseline, even if still inside the age window → `late_discovered` (not sent)
  - missing `publishedAt` → **Вперше помічено** (excluded when `TELEGRAM_STRICT_NEW_PUBLICATIONS=true`)
  - old / refreshed-old `publishedAt` → suppressed
- `OWNER_ONLY=true` (default) requires platform-confirmed `sellerType=owner`.
  `OWNER_ACCEPT_SELF_DECLARED=true` is an explicit opt-in for clean self-declared text (private account + «від власника» / «без посередників», no agency). Telegram labels those as a self-declaration, never «за позначкою майданчика».
- Oracle VM: `scripts/oracle-telegram-test/install-systemd.sh` installs a user service/timer (start after reboot, restart on failure, one unit instance, logs + heartbeat). Secrets stay in `~/.config/rent-radar/telegram-test.env`.
- `disabled`, `transport_blocked`, `parser_failed`, and `valid_empty` are reported per source.
- Final summary includes `cycles_with_partial_source_coverage`.

## Safety

- Bot token and full `api.telegram.org/bot…` URLs are never logged.
- No Igor credentials or destinations are hard-coded.
- Unit tests do not send unless a fake `fetch` is injected; live scripts require explicit env.
- Production `ListingMonitorService` / `TelegramOutput` defaults are unchanged.
- `ENABLE_OLX` (HTTP) stays **false** by default. Oracle CloudFront 403 is `transport_blocked`, not browser success.
- `ENABLE_OLX_BROWSER=true` wires Playwright catalog extract into collection/Telegram. There is **no** silent fallback to `api/v1/offers`.
- Startup and final summary messages are always sent on `live:test-telegram:poll`.
- Seller line uses «Власник — за позначкою майданчика» (not legal ownership proof).
- Dates are shown in Europe/Kyiv; raw ISO timestamps are not shown.
