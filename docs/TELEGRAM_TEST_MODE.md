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
- `SELLER_POLICY=reject_intermediaries` (default) rejects confirmed realtor/agency/intermediary listings and keeps unknown plus self-declared sellers. Telegram unknown label is exactly **«Власник не підтверджено»**.
- Existing `OWNER_ONLY=true` does **not** restore the old platform-owner-only gate. That legacy gate is only `SELLER_POLICY=owner_only`.
- `OWNER_ACCEPT_SELF_DECLARED` is unused unless `SELLER_POLICY=owner_only`.
- Price is parsed and displayed when present. Missing price is **«Ціна не вказана»**. There is no min/max price eligibility filter.
- Broadening seller eligibility does not reset SQLite baselines, seen listings, or the outbox. On first run after upgrade, a one-time `seller_policy` cutover timestamp is stored so previously hidden catalog inventory is not sent as «Нова публікація».
- Oracle VM: `scripts/oracle-telegram-test/install-systemd.sh` installs a user service/timer (start after reboot, restart on failure, one unit instance, logs + heartbeat). Secrets stay in `~/.config/rent-radar/telegram-test.env`.
- `disabled`, `transport_blocked`, `parser_failure`, `transport_failure`, `browser_failure`, and `valid_empty` are reported per source. A thrown fetch is `transport_failure`, or `browser_failure` for OLX Playwright.
- Final summary includes `cycles_with_partial_source_coverage`.

## Persistent state

Schema version was 4 and is now 5. Opening the poller applies the new migration in place. Existing rows stay.

`source_health` keeps the latest attempt for each source:

| Stored status | Meaning |
| --- | --- |
| `ok` | Listings were parsed |
| `valid_empty` | The catalog structure was present and empty |
| `parser_failure` | The adapter inspected content and rejected the catalog structure |
| `http_error` | HTTP failure that is not a 429 and not a blocked transport |
| `rate_limited` | HTTP 429, including a RIELTOR 429 |
| `transport_failure` | `transport_blocked` (usually HTTP 403), or a thrown network/adapter error |
| `browser_failure` | OLX Playwright acquisition threw |
| `disabled` | Config flag is off. Written even when no adapter is constructed. OLX is disabled only when both OLX flags are off |

`ok` and `valid_empty` reset the failure streak and set `last_success_at`. A later failure keeps that success time. `parser_failure` is never stored as `valid_empty`. No successful HTML is stored. Error text is shortened and redacted.

The long-running poller (`npm run live:test-telegram:poll`) runs cleanup at process start and then at most once every 24 hours. The clock is `schema_meta.state_cleanup_at`, so a 10-minute poll does not repeat the delete. The one-shot command records health and does not run retention.

| Data | Retention |
| --- | --- |
| Seen listing inactive (`last_seen_at`) | 30 days, unless an outbox row still protects it |
| Cross-source identity | 90 days, unless a pending, sending, failed, or sent-within-30-days outbox row matches |
| Outbox `sent` | 30 days after `sent_at` |
| Outbox `pending`, `sending`, `failed` | Never deleted because of age |
| Source baseline, poller lock, seller-policy cutover, current source health | Never deleted because of age |

There is no poll-diagnostic history table and no per-attempt health history, so those rows are not created and not pruned. A seen row is refreshed when a later successful poll still contains that listing.

`DATABASE_PATH` defaults to `./data/rent-radar.sqlite` inside the checkout. On Oracle that path may already be the live inventory database. Cleanup does not delete the file. Test reset refuses this default path. Moving the file out of the checkout is a later deployment step.

## Safety

- Bot token and full `api.telegram.org/bot…` URLs are never logged.
- No Igor credentials or destinations are hard-coded.
- Unit tests do not send unless a fake `fetch` is injected; live scripts require explicit env.
- Production `ListingMonitorService` / `TelegramOutput` defaults are unchanged.
- `ENABLE_OLX` (HTTP) stays **false** by default. Oracle CloudFront 403 is `transport_blocked`, not browser success.
- `ENABLE_OLX_BROWSER=true` wires Playwright catalog extract into collection/Telegram. There is **no** silent fallback to `api/v1/offers`.
- Startup and final summary messages are always sent on `live:test-telegram:poll`.
- Seller line uses «Власник — за позначкою майданчика» for platform-confirmed owners, a self-declaration label for listing-author claims, and exactly «Власник не підтверджено» when the role is unknown.
- Dates are shown in Europe/Kyiv; raw ISO timestamps are not shown.
