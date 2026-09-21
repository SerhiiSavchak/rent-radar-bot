#!/usr/bin/env bash
# Install user-level systemd service + timer for the Oracle VM poller.
# Secrets stay in ~/.config/rent-radar/telegram-test.env (not copied here).
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

REPO_DIR="${REPO_DIR:-$HOME/rent-radar-bot}"
[[ -d "$REPO_DIR" ]] || die "REPO_DIR not found: $REPO_DIR"
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$HOME/rent-radar-runtime/telegram-test}"
mkdir -p "$RUNTIME_DIR"
RUNTIME_DIR="$(cd "$RUNTIME_DIR" && pwd)"
EXPECTED_ENV_FILE="$HOME/.config/rent-radar/telegram-test.env"
ENV_FILE="${ENV_FILE:-$EXPECTED_ENV_FILE}"
UNIT_DIR="${UNIT_DIR:-$HOME/.config/systemd/user}"
DATABASE_PATH="${DATABASE_PATH:-$RUNTIME_DIR/rent-radar.sqlite}"
case "$DATABASE_PATH" in
  /*) ;;
  *) DATABASE_PATH="$RUNTIME_DIR/${DATABASE_PATH##*/}" ;;
esac
HEARTBEAT_PATH="${HEARTBEAT_PATH:-$RUNTIME_DIR/heartbeat.json}"
LOG_FILE="${LOG_FILE:-$RUNTIME_DIR/poll.log}"
TEMPLATE_DIR="${TEMPLATE_DIR:-$REPO_DIR/deploy/systemd}"

[[ "$ENV_FILE" == "$EXPECTED_ENV_FILE" ]] || die "Environment file must be $EXPECTED_ENV_FILE"
[[ -d "$REPO_DIR" ]] || die "REPO_DIR not found: $REPO_DIR"
[[ -f "$ENV_FILE" ]] || die "Environment file missing: $ENV_FILE (create the existing protected telegram-test.env)"
[[ -f "$TEMPLATE_DIR/rent-radar-telegram.service" ]] || die "Missing unit template"

chmod 600 "$ENV_FILE" 2>/dev/null || true
mkdir -p "$RUNTIME_DIR" "$UNIT_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
chmod 700 "$(dirname "$ENV_FILE")" 2>/dev/null || true

NPM_BIN="$(command -v npm || true)"
NODE_BIN="$(command -v node || true)"
[[ -n "$NPM_BIN" ]] || die "npm not found on PATH"
[[ -n "$NODE_BIN" ]] || die "node not found on PATH"

render() {
  local src="$1"
  local dest="$2"
  sed \
    -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    -e "s|__RUNTIME_DIR__|$RUNTIME_DIR|g" \
    -e "s|__DATABASE_PATH__|$DATABASE_PATH|g" \
    -e "s|__HEARTBEAT_PATH__|$HEARTBEAT_PATH|g" \
    -e "s|__LOG_FILE__|$LOG_FILE|g" \
    -e "s|__NPM_BIN__|$NPM_BIN|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$src" >"$dest"
}

render "$TEMPLATE_DIR/rent-radar-telegram.service" "$UNIT_DIR/rent-radar-telegram.service"
render "$TEMPLATE_DIR/rent-radar-telegram.timer" "$UNIT_DIR/rent-radar-telegram.timer"
chmod 644 "$UNIT_DIR/rent-radar-telegram.service" "$UNIT_DIR/rent-radar-telegram.timer"

systemctl --user daemon-reload
systemctl --user enable rent-radar-telegram.service
systemctl --user enable rent-radar-telegram.timer

if command -v loginctl >/dev/null 2>&1; then
  if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    echo "NOTE: user lingering is off. After reboot the user service may not start until login."
    echo "      Ask an admin to run: sudo loginctl enable-linger $USER"
  fi
fi

cat <<EOF
installed user units:
  $UNIT_DIR/rent-radar-telegram.service
  $UNIT_DIR/rent-radar-telegram.timer

secrets: $ENV_FILE (not printed)
sqlite:  $DATABASE_PATH
logs:    $LOG_FILE
heartbeat: $HEARTBEAT_PATH

ENABLE_OLX is forced false by the unit ExecStart.
ENABLE_OLX_BROWSER must be set explicitly in $ENV_FILE.
TELEGRAM_POLL_CYCLES is forced to 0 (unbounded) by the unit ExecStart.
After reboot the user unit needs lingering: sudo loginctl enable-linger $USER

Start now:
  systemctl --user start rent-radar-telegram.timer
  systemctl --user start rent-radar-telegram.service
  systemctl --user status rent-radar-telegram.service
EOF
