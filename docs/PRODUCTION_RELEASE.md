# Production release

Controlled deploy of one SHA on the existing Oracle host. Do not reboot the VM, upgrade the OS, or change the database engine.

Production facts:

- host: Oracle Always Free Ubuntu
- service: `rent-radar-telegram.service` (user systemd)
- checkout: `/home/ubuntu/rent-radar-bot`
- database: `/home/ubuntu/rent-radar-bot/data/rent-radar.sqlite`
- previous production SHA: `533e69f55ffaa6de2f0cb360e267be1c34bf301b`
- Telegram destination is configuration. A migrated supergroup id is stored in `schema_meta.telegram_effective_chat_id` after Telegram returns `migrate_to_chat_id`. Do not hard-code it.

The unit forces `ENABLE_DOMRIA=true`, `ENABLE_LUN=true`, `ENABLE_OLX=false`, `ENABLE_OLX_BROWSER=true`, `ENABLE_RIELTOR=false`, `GEO_UNKNOWN_POLICY=exclude`, `TARGET_RADIUS_KM=15`, `FIRST_RUN_MODE=seed`. Those lines override the env file.

## 1. Preflight

```bash
cd /home/ubuntu/rent-radar-bot
git status --short
git rev-parse HEAD
systemctl --user status rent-radar-telegram.service --no-pager
```

The checkout must be clean. Record the running SHA. Do not continue if a poller other than this unit is running.

## 2. Release SHA

Use the SHA from the release candidate. Example name below: `RELEASE_SHA`.

```bash
git fetch origin
git rev-parse "$RELEASE_SHA"
```

## 3. Clean checkout

```bash
git status --short
```

Stop if the output is not empty.

## 4. Current service

```bash
systemctl --user show rent-radar-telegram.service -p ActiveState -p MainPID -p FragmentPath
```

`MainPID` must be the Node process, not npm.

## 5. WAL-safe backup

Do not `cp` the sqlite file while the service is running. Read the live path from the unit. The known production file is `/home/ubuntu/rent-radar-bot/data/rent-radar.sqlite`. Stop if the unit points somewhere else.

```bash
DB=$(systemctl --user show rent-radar-telegram.service -p Environment --value | tr ' ' '\n' | sed -n 's/^DATABASE_PATH=//p')
test -f "$DB"
mkdir -p "$HOME/rent-radar-runtime/backups"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$HOME/rent-radar-runtime/backups/rent-radar-$STAMP.sqlite"
npm run backup:sqlite -- "$DB" "$BACKUP"
```

`backup:sqlite` uses `VACUUM INTO`, then opens the copy.

## 6. Backup check

The command prints JSON with `ok: true`, a non-zero `bytes`, and `schemaVersion`. It has already run `PRAGMA quick_check`. If it does not, stop.

## 7. Stop

```bash
systemctl --user stop rent-radar-telegram.service
```

`TimeoutStopSec=45`. `KillMode=control-group` delivers SIGTERM to Node and Chromium. The poller releases the SQLite lock in `finally`.

## 8. Confirm exit

```bash
systemctl --user is-active rent-radar-telegram.service
pgrep -af 'test-telegram-poll|chrome|chromium' || true
```

The service must be inactive. No poller or Chromium from this unit may remain.

## 9. Checkout

```bash
git fetch origin
git checkout "$RELEASE_SHA"
git rev-parse HEAD
```

`HEAD` must equal `RELEASE_SHA`.

## 10. Dependencies

Install only when the lockfile changed:

```bash
git diff --name-only 533e69f55ffaa6de2f0cb360e267be1c34bf301b "$RELEASE_SHA" -- package-lock.json
npm ci
```

Skip `npm ci` when that diff is empty.

## 11. Migrations

Migrations run when the poller opens SQLite. They are incremental and each version is one transaction. To apply them before start:

```bash
DB_PATH="$DB" node --import tsx -e 'import { DatabaseSync } from "node:sqlite"; import { applyMigrations } from "./src/storage/migrations.ts"; const db = new DatabaseSync(process.env.DB_PATH); console.log(applyMigrations(db)); db.close();'
```

Expected version is the `SCHEMA_VERSION` in `src/storage/migrations.ts` (currently 13). Seen rows, sent outbox rows, baselines, and seller cache rows stay.

## 12. Start

```bash
systemctl --user start rent-radar-telegram.service
```

## 13. Heartbeat SHA

```bash
HB=$(systemctl --user show rent-radar-telegram.service -p Environment --value | tr ' ' '\n' | sed -n 's/^HEARTBEAT_PATH=//p')
HB="$HB" RELEASE_SHA="$RELEASE_SHA" python3 -c 'import json,os; p=json.load(open(os.environ["HB"])); assert p["commit"]==os.environ["RELEASE_SHA"] and p["commit"]!="unknown"; print(p["commit"], p.get("state"), p.get("pid"))'
```

`commit` must be the release SHA. `unknown` is a failed deploy.

## 14. Source health

```bash
sqlite3 "$DB" "SELECT source, status, consecutive_failures, last_success_at FROM source_health ORDER BY source;"
```

Expect rows for domria, lun, and olx. rieltor should be `disabled` or absent as an enabled adapter. `parser_failure` is not `valid_empty`.

## 15. First poll

Wait one cycle (default interval 10 minutes). The log line `live:test-telegram:poll.cycle` must show `deliveryMode` `send_new` when a baseline already exists. An existing catalog must not flood.

## 16. Telegram

Confirm one new eligible listing, or a canary, arrives once. A `migrate_to_chat_id` response retries the same outbox row to the new chat and does not mark it sent until HTTP 200.

## 17. Restart

```bash
systemctl --user restart rent-radar-telegram.service
systemctl --user is-active rent-radar-telegram.service
pgrep -af 'test-telegram-poll' | wc -l
```

One Node poller. A pending outbox row is still one row and is retried. A sent row is not sent again.

## 18. Rollback

Previous SHA: `533e69f55ffaa6de2f0cb360e267be1c34bf301b` (schema 11). That process refuses any other schema version.

Before the new process opens the database, migrations have not run. Stop the service and `git checkout` that SHA, then start. No restore.

After the new process has opened the database, schema is 13. Restoring the step 5 backup is required. A code-only checkout will exit on `schema version 13 != 11`.

```bash
systemctl --user stop rent-radar-telegram.service
pgrep -af 'test-telegram-poll|chrome|chromium' || true
mv "$DB" "$DB.failed-release"
cp "$BACKUP" "$DB"
git checkout 533e69f55ffaa6de2f0cb360e267be1c34bf301b
npm ci
systemctl --user start rent-radar-telegram.service
systemctl --user is-active rent-radar-telegram.service
```

Confirm heartbeat `commit` is `533e69f55ffaa6de2f0cb360e267be1c34bf301b` and `source_health` is readable. The restored file does not contain sends written after the backup. Those listings can be sent again.

## Retention

`seen_listings` and `cross_source_identities` are kept. They are id/timestamp tombstones, not listing bodies. Deleting them can deliver the same listing again. Sent outbox rows older than 30 days are still removed. Pending and failed outbox rows are not removed by age.
