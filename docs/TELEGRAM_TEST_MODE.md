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
TELEGRAM_POLL_CYCLES=6
TELEGRAM_POLL_INTERVAL_MS=600000
FIRST_RUN_MODE=seed            # default: cycle 1 seeds inventory without listing sends
# FIRST_RUN_MODE=send          # cycle 1 sends labeled initial_inventory
```

`TELEGRAM_TEST_MODE` must be exactly `true`. Values like `1` / `True` are refused.

## Commands

One-shot (one collection → filter → dedupe → send):

```bash
TELEGRAM_TEST_MODE=true \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_CHAT_ID=... \
npm run live:test-telegram
```

Bounded poll (default 6 × 10 min, not a daemon):

```bash
TELEGRAM_TEST_MODE=true \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_CHAT_ID=... \
TELEGRAM_POLL_CYCLES=6 \
TELEGRAM_POLL_INTERVAL_MS=600000 \
npm run live:test-telegram:poll
```

## Dedupe and reporting

- Exact keys only: `source:sourceId` and canonical URL. No phone/price similarity merges.
- A failed send does **not** mark the listing delivered; it remains eligible next cycle.
- Dedupe is **process-local / in-memory** — it does **not** survive restart (no DB migration).
- `disabled`, `transport_blocked`, `parser_failed`, and `valid_empty` are reported per source.
- Final summary includes `cycles_with_partial_source_coverage`.

## Safety

- Bot token and full `api.telegram.org/bot…` URLs are never logged.
- No Igor credentials or destinations are hard-coded.
- Unit tests do not send unless a fake `fetch` is injected; live scripts require explicit env.
- Production `ListingMonitorService` / `TelegramOutput` defaults are unchanged.
- OLX browser extract is **not** wired into Telegram; `ENABLE_OLX` uses HTTP only (blocked on Oracle).
- Startup and final summary messages are always sent on `live:test-telegram:poll`.
