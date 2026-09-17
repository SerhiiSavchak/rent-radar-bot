# Oracle: unattended 6-cycle TEST Telegram poll

Uses developer-owned `TELEGRAM_*` only. No Igor credentials. Does not start if soak/another poller is running.

## On the VM

```bash
cd ~/rent-radar-bot
git pull
npm ci

# Load your test bot env (do not commit secrets)
set -a
source ~/.config/rent-radar/telegram-test.env   # you create this file
set +a

chmod +x scripts/oracle-telegram-test/run-telegram-test-poll.sh
./scripts/oracle-telegram-test/run-telegram-test-poll.sh validate
./scripts/oracle-telegram-test/run-telegram-test-poll.sh start
./scripts/oracle-telegram-test/run-telegram-test-poll.sh status
# later:
./scripts/oracle-telegram-test/run-telegram-test-poll.sh stop
```

Runtime artifacts (outside git): `~/rent-radar-runtime/telegram-test/{poll.log,poll.pid,status.json}`

Default: 6 cycles × 10 minutes ≈ 1 hour.

## Honesty notes

- Deliverable sources are HTTP adapters enabled in config (typically DIM.RIA, LUN, RIELTOR).
- `ENABLE_OLX` defaults false; even if true, Telegram uses **OLX HTTP**, which is CloudFront-403 on Oracle.
- Oracle soak `olx_browser` / `browser_accessible` means catalog **page structure** was seen — **not** parsed/deliverable `Listing` objects.
- Startup + final Telegram notifications are always sent (including when zero eligible listings).
- Source failures are reported separately from zero-new-listings.
