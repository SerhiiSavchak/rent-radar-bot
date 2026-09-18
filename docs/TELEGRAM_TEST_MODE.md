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

## Dedupe, baseline, and freshness

- Exact keys only: `source:sourceId` and canonical URL. No phone/price similarity merges.
- A failed send does **not** mark the listing delivered; it remains eligible next cycle.
- Dedupe and per-source baseline are **process-local / in-memory** — they do **not** survive restart.
  On restart the process performs a **silent re-baseline** (does not flood historical inventory as «нове»).
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
- Failed source fetches **do not** establish a baseline; recovery re-baselines silently.
- Persistence: dedupe and baseline are **in-memory**. A restart forgets keys and silent-rebaselines current inventory, including listings that would have been new during downtime. There is no approved durable store for TEST delivery.
- `disabled`, `transport_blocked`, `parser_failed`, and `valid_empty` are reported per source.
- Final summary includes `cycles_with_partial_source_coverage`.

## Safety

- Bot token and full `api.telegram.org/bot…` URLs are never logged.
- No Igor credentials or destinations are hard-coded.
- Unit tests do not send unless a fake `fetch` is injected; live scripts require explicit env.
- Production `ListingMonitorService` / `TelegramOutput` defaults are unchanged.
- OLX browser extract is **not** wired into Telegram; `ENABLE_OLX` uses HTTP only (blocked on Oracle).
- Startup and final summary messages are always sent on `live:test-telegram:poll`.
- Seller line uses «Власник — за позначкою майданчика» (not legal ownership proof).
- Dates are shown in Europe/Kyiv; raw ISO timestamps are not shown.
