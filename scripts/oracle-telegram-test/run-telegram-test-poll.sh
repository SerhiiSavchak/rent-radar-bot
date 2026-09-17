#!/usr/bin/env bash
# Unattended TEST Telegram poll launcher for Oracle Ubuntu.
# Owns a dedicated process group so stop terminates npm + tsx/node children.
# Logs/PID live under ~/rent-radar-runtime (outside the git worktree).
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/rent-radar-bot}"
RUNTIME_DIR="${RUNTIME_DIR:-$HOME/rent-radar-runtime/telegram-test}"
PID_FILE="${RUNTIME_DIR}/poll.pid"
PGID_FILE="${RUNTIME_DIR}/poll.pgid"
LOCK_FILE="${RUNTIME_DIR}/poll.lock"
LOG_FILE="${RUNTIME_DIR}/poll.log"
STATUS_FILE="${RUNTIME_DIR}/status.json"
# Override for lifecycle smoke tests (harmless child tree).
POLL_COMMAND="${POLL_COMMAND:-}"
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
  echo "ENABLE_OLX=${ENABLE_OLX:-false} (HTTP only unless OLX_BROWSER_EXTRACT=true after live check)"
}

owned_tree_alive() {
  if [[ -f "$PGID_FILE" ]]; then
    local pgid
    pgid="$(tr -d '[:space:]' <"$PGID_FILE" 2>/dev/null || true)"
    if [[ -n "$pgid" ]] && kill -0 -- "-$pgid" 2>/dev/null; then
      return 0
    fi
  fi
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

foreign_poller_running() {
  # Detect other project pollers without matching our owned PGID.
  local our_pgid=""
  [[ -f "$PGID_FILE" ]] && our_pgid="$(tr -d '[:space:]' <"$PGID_FILE" 2>/dev/null || true)"
  local matches
  matches="$(pgrep -af "live:oracle:soak|oracle-soak|live:test-telegram|test-telegram-poll|live:olx:experiment|live:olx:browser|olx-browser-extract" 2>/dev/null || true)"
  if [[ -z "$matches" ]]; then
    return 1
  fi
  if [[ -n "$our_pgid" ]]; then
    # If every match belongs to our process group, it is our own tree.
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      local pid="${line%% *}"
      local pgid
      pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ -n "$pgid" && "$pgid" != "$our_pgid" ]]; then
        return 0
      fi
    done <<<"$matches"
    return 1
  fi
  return 0
}

poller_running() {
  owned_tree_alive && return 0
  foreign_poller_running && return 0
  return 1
}

acquire_start_lock() {
  # Prefer flock (Linux). Fall back to atomic mkdir lock (portable / Git Bash).
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    flock -n 9
    return $?
  fi
  mkdir "$LOCK_FILE.d" 2>/dev/null || return 1
  echo $$ >"$LOCK_FILE.d/pid"
  return 0
}

release_start_lock() {
  if [[ -d "$LOCK_FILE.d" ]]; then
    rm -rf "$LOCK_FILE.d"
  fi
}

cmd_start() {
  if [[ -z "${POLL_COMMAND}" ]]; then
    validate_config
  fi
  if ! acquire_start_lock; then
    die "Another start attempt holds $LOCK_FILE"
  fi
  trap 'release_start_lock' EXIT
  if poller_running; then
    die "Another source poller appears to be running. Stop it first: $0 stop"
  fi
  if [[ -z "${POLL_COMMAND}" ]]; then
    [[ -d "$REPO_DIR" ]] || die "REPO_DIR not found: $REPO_DIR"
  fi

  export TELEGRAM_POLL_CYCLES="${TELEGRAM_POLL_CYCLES:-6}"
  export TELEGRAM_POLL_INTERVAL_MS="${TELEGRAM_POLL_INTERVAL_MS:-600000}"

  rm -f "$PID_FILE" "$PGID_FILE"
  local runner
  if [[ -n "${POLL_COMMAND}" ]]; then
    runner="${POLL_COMMAND}"
  else
    runner="cd \"$REPO_DIR\" && exec npm run live:test-telegram:poll"
  fi

  # New session/process group: stop can signal the whole tree (npm → tsx → node).
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "echo \$\$ > '$PID_FILE'; echo \$\$ > '$PGID_FILE'; ${runner}" >>"$LOG_FILE" 2>&1 &
  else
    bash -c "echo \$\$ > '$PID_FILE'; echo \$\$ > '$PGID_FILE'; ${runner}" >>"$LOG_FILE" 2>&1 &
  fi
  disown $! 2>/dev/null || true

  # Wait briefly for pid/pgid files from the session leader.
  local waited=0
  while [[ $waited -lt 50 ]]; do
    if [[ -f "$PID_FILE" && -f "$PGID_FILE" ]]; then
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  [[ -f "$PID_FILE" && -f "$PGID_FILE" ]] || die "failed to record process group leader"

  local pid pgid
  pid="$(tr -d '[:space:]' <"$PID_FILE")"
  pgid="$(tr -d '[:space:]' <"$PGID_FILE")"
  cat >"$STATUS_FILE" <<EOF
{"state":"running","pid":${pid},"pgid":${pgid},"startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","logFile":"${LOG_FILE}","cycles":${TELEGRAM_POLL_CYCLES},"intervalMs":${TELEGRAM_POLL_INTERVAL_MS}}
EOF
  echo "started pid=$pid pgid=$pgid log=$LOG_FILE"
  release_start_lock
  trap - EXIT
}

cmd_status() {
  if [[ -f "$STATUS_FILE" ]]; then
    cat "$STATUS_FILE"
    echo
  fi
  if owned_tree_alive; then
    echo "process=running pid=$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null) pgid=$(tr -d '[:space:]' <"$PGID_FILE" 2>/dev/null)"
    return 0
  fi
  if [[ -f "$PID_FILE" || -f "$PGID_FILE" ]]; then
    echo "process=not_running stale_pid_files=present"
    return 1
  fi
  echo "process=not_running"
  return 1
}

terminate_group() {
  local pgid="$1"
  local sig="$2"
  kill "-$sig" -- "-$pgid" 2>/dev/null || true
}

# Best-effort child walk when process groups are unavailable (e.g. Git Bash without setsid).
terminate_tree() {
  local pid="$1"
  local sig="$2"
  local kids
  kids="$(pgrep -P "$pid" 2>/dev/null || true)"
  local child
  for child in $kids; do
    terminate_tree "$child" "$sig"
  done
  kill "-$sig" "$pid" 2>/dev/null || true
}

cmd_stop() {
  if [[ ! -f "$PGID_FILE" && ! -f "$PID_FILE" ]]; then
    echo "no pid/pgid file"
    return 0
  fi
  local pgid pid
  pgid="$(tr -d '[:space:]' <"$PGID_FILE" 2>/dev/null || true)"
  pid="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"

  if [[ -n "$pgid" ]]; then
    terminate_group "$pgid" TERM
  fi
  if [[ -n "$pid" ]]; then
    terminate_tree "$pid" TERM
  fi

  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    local alive=0
    if [[ -n "$pgid" ]] && kill -0 -- "-$pgid" 2>/dev/null; then
      alive=1
    fi
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      alive=1
    fi
    [[ "$alive" -eq 0 ]] && break
    sleep 1
  done

  if [[ -n "$pgid" ]] && kill -0 -- "-$pgid" 2>/dev/null; then
    terminate_group "$pgid" KILL
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    terminate_tree "$pid" KILL
  fi
  sleep 1

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    die "process $pid still alive after KILL"
  fi
  echo "stopped pid=${pid:-n/a} pgid=${pgid:-n/a}"

  rm -f "$PID_FILE" "$PGID_FILE"
  release_start_lock
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
  POLL_COMMAND='...'   # test override (harmless child tree)

Stop signals the owned process group (npm + tsx/node children), not unrelated Node.
USAGE
    exit 2
    ;;
esac
