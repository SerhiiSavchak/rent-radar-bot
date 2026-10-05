# Oracle consolidated validation (one manual session)

Read-only validation of **two candidates** against live Lviv catalogs on the Oracle host.

**Does not** change production checkout, restart services, write production SQLite, send Telegram, mutate env, or run `systemctl` except status/heartbeat reads.

## Candidates

| Role | Branch | Known local head (update after fetch) |
| --- | --- | --- |
| CANDIDATE 1 — current production stabilization | `fix/current-production-stabilization` | fetch then `git rev-parse origin/fix/current-production-stabilization` |
| CANDIDATE 2 — Business after stabilization | `integration/olx-business-after-stabilization` | fetch then `git rev-parse origin/integration/olx-business-after-stabilization` |
| Production baseline (must stay unchanged) | `main` / deployed checkout | expected `26f3aa7a822c146d6b930d9d887c8f0b304c59e0` until an explicit later deploy |

## Safety contract

- Detached worktrees **outside** `/home/ubuntu/rent-radar-bot`
- No `git checkout` in the production repo that moves `HEAD`
- No production DB path writes
- No Telegram credentials / sends
- No `systemctl restart|stop|start`
- Prefer existing `node_modules` via symlink from production checkout when versions match
- External hard timeouts via `timeout` (GNU coreutils on Ubuntu)

## Paths

```bash
PROD_REPO=/home/ubuntu/rent-radar-bot
WT_ROOT=/home/ubuntu/rent-radar-validation
EVIDENCE=$HOME/rent-radar-runtime/evidence/oracle-consolidated-$(date +%Y%m%dT%H%M%S)
STAB_WT=$WT_ROOT/stab
BIZ_WT=$WT_ROOT/biz
mkdir -p "$WT_ROOT" "$EVIDENCE"
```

---

## PRECHECK

```bash
cd "$PROD_REPO"
echo "PROD_HEAD=$(git rev-parse HEAD)"
echo "PROD_BRANCH=$(git rev-parse --abbrev-ref HEAD)"
git status --short
systemctl --user is-active rent-radar-telegram.service
systemctl --user status rent-radar-telegram.service --no-pager | sed -n '1,20p'
free -h
df -h "$HOME" /tmp
uptime
# Heartbeat (path may vary; adjust if unit uses another file)
ls -la "$HOME/rent-radar-runtime"/heartbeat*.json 2>/dev/null || true
ls -la /tmp/rent-radar*heartbeat* 2>/dev/null || true
```

Record `PROD_HEAD` and that the service is `active`. Do not continue if another competing poller is running.

```bash
cd "$PROD_REPO"
git fetch origin \
  main \
  fix/current-production-stabilization \
  integration/olx-business-after-stabilization
git rev-parse origin/main
git rev-parse origin/fix/current-production-stabilization
git rev-parse origin/integration/olx-business-after-stabilization
```

Create worktrees (no production checkout change):

```bash
cd "$PROD_REPO"
git worktree add --detach "$STAB_WT" origin/fix/current-production-stabilization
git worktree add --detach "$BIZ_WT" origin/integration/olx-business-after-stabilization
ln -sfn "$PROD_REPO/node_modules" "$STAB_WT/node_modules"
ln -sfn "$PROD_REPO/node_modules" "$BIZ_WT/node_modules"
# If Playwright browsers are missing in this user account:
#   cd "$PROD_REPO" && npx playwright install chromium
```

---

## STABILIZATION CANDIDATE (CANDIDATE 1)

### LUN live coverage (current vs deeper)

```bash
cd "$STAB_WT"
timeout 20m env \
  LIVE_PROBE_CYCLES=3 \
  EVIDENCE_DIR="$EVIDENCE/lun-stab" \
  /usr/bin/time -v npx tsx src/scripts/lun-coverage-cap-diagnostic.ts \
  | tee "$EVIDENCE/lun-stab-console.txt"
```

Expect: `freshEligibleBeyondCurrent=false`, current walk completes or reports a real `degradeReason` (not a false blanket `acquired_response_cap` unless the card cap actually trimmed).

### OLX Private repeated acquisition

```bash
cd "$STAB_WT"
for i in 1 2 3 4 5; do
  echo "=== private $i ==="
  timeout 10m env OLX_PRIVATE_CATALOG_VERIFY=true \
    /usr/bin/time -v npx tsx src/scripts/olx-private-catalog-verify.ts \
    > "$EVIDENCE/olx-private-stab-$i.json" 2>"$EVIDENCE/olx-private-stab-$i.time.txt" || true
  node -e "const r=require(process.env.F); console.log({complete:r.complete,apts:r.apartmentsFetchedPages,houses:r.housesFetchedPages,ids:r.uniqueListingIds,parser:r.parserFailures,nav:r.navigationFailures,elapsed:r.elapsedMs})" F="$EVIDENCE/olx-private-stab-$i.json"
  sleep 2
done
```

Expect: majority complete under normal budgets; any incomplete cycle must stay fail-closed (`complete=false` / health degraded), never false OK.

### Seller / detail read-only (where supported)

```bash
cd "$STAB_WT"
timeout 15m env \
  EVIDENCE_DIR="$EVIDENCE/seller-stab" \
  npx tsx src/scripts/seller-detail-hold-probe.ts \
  | tee "$EVIDENCE/seller-stab-console.txt"

timeout 15m env \
  EVIDENCE_DIR="$EVIDENCE/seller-stab" \
  npx tsx src/scripts/olx-live-seller-class-probe.ts \
  | tee "$EVIDENCE/olx-live-seller-stab.txt"
```

Exact historical production IDs may be UNAVAILABLE (404). Class checks on current listings are the pass criterion.

---

## BUSINESS INTEGRATION CANDIDATE (CANDIDATE 2)

### HOT benchmark

```bash
cd "$BIZ_WT"
timeout 15m env \
  OLX_BROWSER_EXTRACT=true \
  OLX_BROWSER_BUSINESS_BENCHMARK_MODE=hot \
  OUT_DIR="$EVIDENCE/biz-hot" \
  /usr/bin/time -v npx tsx src/scripts/oracle-olx-browser-extract.ts \
  | tee "$EVIDENCE/biz-hot-console.txt"
```

Expect:

- Private apartments + houses `complete`
- Business apartments `mode=hot`, page 1 fetched, parser healthy
- Business houses normal complete behavior
- `budgetExceeded=false`, `browserClosed=true`

### FULL benchmark

```bash
cd "$BIZ_WT"
timeout 20m env \
  OLX_BROWSER_EXTRACT=true \
  OLX_BROWSER_BUSINESS_BENCHMARK_MODE=full \
  OUT_DIR="$EVIDENCE/biz-full" \
  /usr/bin/time -v npx tsx src/scripts/oracle-olx-browser-extract.ts \
  | tee "$EVIDENCE/biz-full-console.txt"
```

Expect:

- Private full complete
- Business apartments: every declared page in the same session (`fullCoverage=true`)
- Business houses complete within ceiling
- Parser `meaningfulFailureCount=0`
- Wall time and max RSS from `/usr/bin/time -v` recorded (workstation/Oracle numbers are not interchangeable claims)

---

## POSTCHECK

```bash
cd "$PROD_REPO"
echo "PROD_HEAD_AFTER=$(git rev-parse HEAD)"
# Must equal PROD_HEAD from PRECHECK
systemctl --user is-active rent-radar-telegram.service
# Heartbeat still advances (mtime / cycle field)
stat "$HOME/rent-radar-runtime"/heartbeat*.json 2>/dev/null || true
# No production DB writes from this session: do not open/copy production sqlite for writes
ls -la /home/ubuntu/rent-radar-bot/data/rent-radar.sqlite
```

Cleanup worktrees (optional):

```bash
cd "$PROD_REPO"
git worktree remove --force "$STAB_WT" || true
git worktree remove --force "$BIZ_WT" || true
git worktree prune
```

---

## Rollback / rejection policy (Business optional)

If CANDIDATE 2 on Oracle later exceeds acceptable runtime/memory, causes Chromium instability, exhausts acquisition budget, or degrades Private/LUN vs CANDIDATE 1:

**BUSINESS = REJECTED**

Then:

- do **not** merge `integration/olx-business-after-stabilization` to `main`
- keep / deploy only `fix/current-production-stabilization` if stabilization itself is accepted
- no rollback migration required
- no production Business state should exist (Business full-scan timestamp is optional meta; retiring keys are already handled in code)

Rejecting Business must not undo Stage A.

---

## Local evidence already gathered (not a substitute for Oracle)

Workstation 2026-10-05 (agent run):

- LUN: 3/3 complete, beyond-current IDs = 0, flats not newest-first
- OLX Private: 5/5 + post-fix complete under normal budgets
- Business HOT: Private complete; Business apt page 1; houses complete; ~20s; browserClosed
- Business FULL: Private complete; Business apt 25/25; houses 2/2; ~75s; browserClosed; no budget exhaustion
