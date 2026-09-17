#!/usr/bin/env bash
# Unattended 6-cycle TEST Telegram poll launcher for Oracle Ubuntu.
# Logs/PID live under ~/rent-radar-runtime (outside the git worktree).
# Does not print secrets. Refuses if another source poller is already running.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/rent-radar-bot}"
RUNTIME_DIR="${RUNTIME_DIR:-$HOME/rent-radar-runtime/telegram-test}"
PID_FILE="${RUNTIME_DIR}/poll.pid"
LOG_FILE="${RUNTIME_DIR}/poll.log"
STATUS_FILE="${RUNTIME_DIR}/status.json"
CMD="${1:-}"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true

die() { echo "ERROR: $*" >&2; exit 1; }

require_env_present() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    die "$name is required (value not printed)"
  fi
  echo "$name=set"
}

validate_config() {
  require_env_present TELEGRAM_TEST_MODE
  [[ "${TELEGRAM_TEST_MODE}" == "true" ]] || die 'TELEGRAM_TEST_MODE must be exactly "true"'
  require_env_present TELEGRAM_BOT_TOKEN
  require_env_present TELEGRAM_CHAT_ID
  echo "TELEGRAM_DRY_RUN=${TELEGRAM_DRY_RUN:-unset}"
  echo "TELEGRAM_POLL_CYCLES=${TELEGRAM_POLL_CYCLES:-6}"
  echo "TELEGRAM_POLL_INTERVAL_MS=${TELEGRAM_POLL_INTERVAL_MS:-600000}"
  echo "ENABLE_OLX=${ENABLE_OLX:-false} (HTTP only; browser probe is not Telegram delivery)"
}

poller_running() {
  # Refuse concurrent soak / telegram / live source pollers from this project.
  if pgrep -af "live:oracle:soak|oracle-soak|live:test-telegram|test-telegram-poll|live:olx:experiment|live:olx:browser" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

cmd_start() {
  validate_config
  if poller_running; then
    die "Another source poller appears to be running. Stop it first: $0 stop"
  fi
  [[ -d "$REPO_DIR" ]] || die "REPO_DIR not found: $REPO_DIR"
  cd "$REPO_DIR"

  export TELEGRAM_POLL_CYCLES="${TELEGRAM_POLL_CYCLES:-6}"
  export TELEGRAM_POLL_INTERVAL_MS="${TELEGRAM_POLL_INTERVAL_MS:-600000}"

  # Detach from SSH: nohup + disown stdin/out
  nohup npm run live:test-telegram:poll >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  cat >"$STATUS_FILE" <<EOF
{"state":"running","pid":${pid},"startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","logFile":"${LOG_FILE}","cycles":${TELEGRAM_POLL_CYCLES},"intervalMs":${TELEGRAM_POLL_INTERVAL_MS}}
EOF
  echo "started pid=$pid log=$LOG_FILE"
}

cmd_status() {
  if [[ -f "$STATUS_FILE" ]]; then
    cat "$STATUS_FILE"
    echo
  fi
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "process=running pid=$pid"
      return 0
    fi
    echo "process=not_running stale_pid=$pid"
    return 1
  fi
  echo "process=not_running"
  return 1
}

cmd_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "no pid file"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" || true
    fi
    echo "stopped pid=$pid"
  else
    echo "process already stopped pid=$pid"
  fi
  rm -f "$PID_FILE"
  cat >"$STATUS_FILE" <<EOF
{"state":"stopped","stoppedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
}

cmd_validate() {
  validate_config
  echo "ok"
}

case "$CMD" in
  start) cmd_start ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  validate) cmd_validate ;;
  *)
    cat <<'USAGE'
Usage: run-telegram-test-poll.sh {validate|start|status|stop}

Environment (required for start/validate):
  TELEGRAM_TEST_MODE=true
  TELEGRAM_BOT_TOKEN=...
  TELEGRAM_CHAT_ID=...

Optional:
  TELEGRAM_DRY_RUN=true
  TELEGRAM_POLL_CYCLES=6
  TELEGRAM_POLL_INTERVAL_MS=600000
  REPO_DIR=~/rent-radar-bot
  RUNTIME_DIR=~/rent-radar-runtime/telegram-test

Logs/PID are stored under RUNTIME_DIR (outside the git repo).
USAGE
    exit 2
    ;;
esac
