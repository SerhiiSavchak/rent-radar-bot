# Customer delivery (single destination)

## Current architecture

The Telegram poller (`test-telegram-poll` / `TelegramTestSink`) delivers listings to **exactly one** chat:

- `TELEGRAM_CHAT_ID` — listing delivery destination
- optional `ADMIN_TELEGRAM_CHAT_ID` — source admin alerts only (not listing fan-out)

There is **no** `/start` handler and **no** subscriber registry. Pressing `/start` opens a private chat with the bot but does **not** register that user for listing delivery.

`TELEGRAM_TEST_MODE=true` is required for the sink. It does not by itself mean “developer-only product”; it gates the guarded sink implementation.

## Why a user may receive nothing

If their Telegram user id is not equal to `TELEGRAM_CHAT_ID`, the poller will never send them listings—even when collection, filtering, and outbox delivery to the configured chat succeed.

## Intended customer destination

Preferred long-term destination: a **customer-controlled Telegram group** where the bot is a member and can post.

Until a verified group `chat_id` is available, do **not** guess ids and do **not** silently replace the developer destination.

### Setup checklist (group)

1. Create/use the customer group; add the project bot.
2. Grant the bot permission to post messages.
3. Obtain the group `chat_id` (negative id for groups/supergroups) via a trusted method (e.g. temporary log of an update, or an operator-controlled helper). Record it outside git.
4. Decide destination policy:
   - **Replace** listing destination: set `TELEGRAM_CHAT_ID` to the group id (developer stops receiving listing copies unless a separate dual-destination feature is implemented later).
   - **Keep developer visibility**: requires an explicit multi-destination design with per-recipient success/failure (not present today). Do not invent fan-out without that tracking.
5. Restart the single user-level poller unit after env change; do not run a second poller.
6. Send one labeled connection-test message to the group; confirm API acceptance and human receipt separately.

### Temporary private check

A one-off labeled connection-test to a verified private user id may be used to prove the bot can message that user. That test must not replay historical listings and must not by itself retarget the poller.

## Related env

See `docs/TELEGRAM_TEST_MODE.md` for the full test-sink env surface.
