# Recovery status

Updated: 2026-09-17T12:40+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`

## Facts

- Oracle soak: **DEGRADED** (Domria mis-scored missing `resultKind`; fixed in tree).
- OLX browser: page access only — **not** Telegram-deliverable listings.
- Next: 6-cycle TEST Telegram poll on Oracle (not another soak).

## Oracle start (copy-paste)

```bash
cd ~/rent-radar-bot && git pull && npm ci || exit 1
set -a && source ~/.config/rent-radar/telegram-test.env && set +a
chmod +x scripts/oracle-telegram-test/run-telegram-test-poll.sh
./scripts/oracle-telegram-test/run-telegram-test-poll.sh validate || exit 1
./scripts/oracle-telegram-test/run-telegram-test-poll.sh start || exit 1
./scripts/oracle-telegram-test/run-telegram-test-poll.sh status
```
