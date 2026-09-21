#!/usr/bin/env bash
# Harmless process-tree lifecycle smoke test (no network).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/oracle-telegram-test/run-telegram-test-poll.sh"
RUNTIME_DIR="${TMPDIR:-/tmp}/rent-radar-lifecycle-$$"
export RUNTIME_DIR
mkdir -p "$RUNTIME_DIR"
chmod +x "$SCRIPT"

cleanup() {
  "$SCRIPT" stop >/dev/null 2>&1 || true
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT

# Child tree: nested sleeps (simulates npm → tsx).
export POLL_COMMAND='sleep 60 & sleep 60 & wait'

echo "== start =="
"$SCRIPT" start
"$SCRIPT" status

pid="$(tr -d '[:space:]' <"$RUNTIME_DIR/poll.pid")"
pgid="$(tr -d '[:space:]' <"$RUNTIME_DIR/poll.pgid")"
[[ -n "$pid" ]] || { echo "missing pid"; exit 1; }
kill -0 "$pid" 2>/dev/null || { echo "leader pid not alive"; exit 1; }

echo "== duplicate start must fail =="
if "$SCRIPT" start; then
  echo "duplicate start incorrectly succeeded"
  exit 1
fi

echo "== stop must kill owned tree =="
"$SCRIPT" stop
sleep 1
if kill -0 "$pid" 2>/dev/null; then
  echo "leader pid still alive after stop"
  exit 1
fi
if [[ -n "$pgid" ]] && kill -0 -- "-$pgid" 2>/dev/null; then
  echo "process group still alive after stop"
  exit 1
fi

echo "== stale pid/pgid files must not block a new start =="
echo "999999" >"$RUNTIME_DIR/poll.pid"
echo "999999" >"$RUNTIME_DIR/poll.pgid"
"$SCRIPT" start
"$SCRIPT" status
fresh_pid="$(tr -d '[:space:]' <"$RUNTIME_DIR/poll.pid")"
[[ "$fresh_pid" != "999999" ]] || { echo "stale pid was not replaced"; exit 1; }
kill -0 "$fresh_pid" 2>/dev/null || { echo "replacement leader not alive"; exit 1; }
"$SCRIPT" stop

echo "lifecycle_smoke=PASS"
