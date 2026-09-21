#!/usr/bin/env bash
# Oracle operator sequence: catalog extract (timing fix) then one owner-detail diagnostic.
# Run AFTER SSH login. Does not start Telegram. Refuses concurrent project pollers.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/rent-radar-bot}"
INTENDED_COMMIT="${INTENDED_COMMIT:-}"
RUNTIME_ROOT="${RUNTIME_ROOT:-$HOME/rent-radar-runtime}"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "$INTENDED_COMMIT" ]] || die "INTENDED_COMMIT is required (full SHA of the owner-detail commit)"
[[ -d "$REPO_DIR" ]] || die "REPO_DIR not found: $REPO_DIR"

foreign_poller_running() {
  local matches
  matches="$(pgrep -af "live:oracle:soak|oracle-soak|live:test-telegram|test-telegram-poll|live:olx:experiment|live:olx:browser|olx-browser-extract|olx-owner-detail|oracle-olx-owner-detail" 2>/dev/null || true)"
  [[ -n "$matches" ]]
}

if foreign_poller_running; then
  pgrep -af "live:oracle:soak|oracle-soak|live:test-telegram|test-telegram-poll|live:olx:experiment|live:olx:browser|olx-browser-extract|olx-owner-detail|oracle-olx-owner-detail" || true
  die "Refuse concurrent project pollers. Stop soak/Telegram/OLX extract first."
fi

cd "$REPO_DIR"

echo "== update/install (subshell; stop on error) =="
(
  set -euo pipefail
  git fetch --ff-only origin
  git merge --ff-only "$INTENDED_COMMIT"
  npm ci
) || die "update/install failed inside subshell; refusing to continue"

head="$(git rev-parse HEAD)"
[[ "$head" == "$INTENDED_COMMIT" ]] || die "HEAD $head is not INTENDED_COMMIT $INTENDED_COMMIT"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${RUNTIME_ROOT}/olx-verify-${stamp}-${head:0:12}"
mkdir -p "$RUN_DIR/catalog" "$RUN_DIR/owner-detail"
chmod 700 "$RUN_DIR" "$RUN_DIR/catalog" "$RUN_DIR/owner-detail"

echo "== catalog extract (timing fix verification) =="
echo "out=$RUN_DIR/catalog"
(
  set -euo pipefail
  export OLX_BROWSER_EXTRACT=true
  export OLX_BROWSER_OUT_DIR="$RUN_DIR/catalog"
  export OLX_BROWSER_COMMIT="$head"
  npm run live:olx:browser-extract
) || echo "WARN: catalog extract exited non-zero; artifacts still under $RUN_DIR/catalog"

echo "== wait: catalog process has exited before owner-detail =="
if pgrep -af "olx-browser-extract|oracle-olx-browser-extract" >/dev/null 2>&1; then
  die "catalog extract process still running; owner-detail refused"
fi

echo "== owner-detail diagnostic =="
echo "out=$RUN_DIR/owner-detail"
(
  set -euo pipefail
  export OLX_BROWSER_OWNER_DETAIL=true
  export OLX_BROWSER_OUT_DIR="$RUN_DIR/owner-detail"
  export OLX_BROWSER_COMMIT="$head"
  export OLX_BROWSER_CAPTURE="${OLX_BROWSER_CAPTURE:-true}"
  npm run live:olx:owner-detail
) || echo "WARN: owner-detail exited non-zero; artifacts still under $RUN_DIR/owner-detail"

cat >"$RUN_DIR/run-index.json" <<EOF
{
  "intendedCommit": "$INTENDED_COMMIT",
  "head": "$head",
  "startedAt": "$stamp",
  "catalogDir": "$RUN_DIR/catalog",
  "ownerDetailDir": "$RUN_DIR/owner-detail",
  "note": "Preserve both result directories. No Telegram. Captures stay outside git."
}
EOF

echo "RUN_DIR=$RUN_DIR"
echo "done"
