#!/usr/bin/env bash
# Offline regression tests for SSH_ALLOWED_CIDR precedence + validation.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ssh-cidr.inc.sh
source "${ROOT}/ssh-cidr.inc.sh"

PASS=0
FAIL=0
assert_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (got='$got' want='$want')"
    FAIL=$((FAIL + 1))
  fi
}

assert_true() {
  local label="$1"
  if eval "$2"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

assert_false() {
  local label="$1"
  if eval "$2"; then
    echo "FAIL: $label (expected false)"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $label"
    PASS=$((PASS + 1))
  fi
}

# --- validation ---
assert_true "valid /32" 'is_valid_ssh_host_cidr32 "37.55.172.239/32"'
assert_false "empty" 'is_valid_ssh_host_cidr32 ""'
assert_false "world open" 'is_valid_ssh_host_cidr32 "0.0.0.0/0"'
assert_false "wider /24" 'is_valid_ssh_host_cidr32 "37.55.172.0/24"'
assert_false "placeholder cyrillic" 'is_valid_ssh_host_cidr32 "ТВОЙ_IP/32"'
assert_false "placeholder english" 'is_valid_ssh_host_cidr32 "YOUR_IP/32"'
assert_false "octet 256" 'is_valid_ssh_host_cidr32 "37.55.172.256/32"'
assert_false "leading zero octet" 'is_valid_ssh_host_cidr32 "037.55.172.239/32"'
assert_false "missing prefix" 'is_valid_ssh_host_cidr32 "37.55.172.239"'

# --- precedence: explicit overrides saved placeholder ---
unset SSH_ALLOWED_CIDR || true
SSH_ALLOWED_CIDR="37.55.172.239/32"
capture_ssh_allowed_cidr_from_env
SSH_ALLOWED_CIDR="ТВОЙ_IP/32" # simulate state.env overwrite
resolve_ssh_allowed_cidr
assert_eq "explicit overrides placeholder value" "$SSH_ALLOWED_CIDR" "37.55.172.239/32"
assert_eq "explicit overrides placeholder source" "$SSH_ALLOWED_CIDR_SOURCE" "environment"
assert_true "explicit override still valid" 'is_valid_ssh_host_cidr32 "$SSH_ALLOWED_CIDR"'

# --- precedence: explicit overrides saved empty ---
unset SSH_ALLOWED_CIDR || true
SSH_ALLOWED_CIDR="37.55.172.239/32"
capture_ssh_allowed_cidr_from_env
SSH_ALLOWED_CIDR="" # simulate empty state.env
resolve_ssh_allowed_cidr
assert_eq "explicit overrides empty value" "$SSH_ALLOWED_CIDR" "37.55.172.239/32"
assert_eq "explicit overrides empty source" "$SSH_ALLOWED_CIDR_SOURCE" "environment"

# --- saved used when no override ---
unset SSH_ALLOWED_CIDR || true
capture_ssh_allowed_cidr_from_env
SSH_ALLOWED_CIDR="8.8.8.8/32" # from state only
resolve_ssh_allowed_cidr
assert_eq "saved when no override" "$SSH_ALLOWED_CIDR" "8.8.8.8/32"
assert_eq "saved source" "$SSH_ALLOWED_CIDR_SOURCE" "state"

# --- invalid explicit must not fall back to saved ---
unset SSH_ALLOWED_CIDR || true
SSH_ALLOWED_CIDR="not-a-cidr"
capture_ssh_allowed_cidr_from_env
SSH_ALLOWED_CIDR="8.8.8.8/32" # tempting saved value
resolve_ssh_allowed_cidr
assert_eq "invalid explicit keeps explicit value" "$SSH_ALLOWED_CIDR" "not-a-cidr"
assert_eq "invalid explicit source env" "$SSH_ALLOWED_CIDR_SOURCE" "environment"
assert_false "invalid explicit not valid" 'is_valid_ssh_host_cidr32 "$SSH_ALLOWED_CIDR"'
# Must NOT silently become the saved good value:
[[ "$SSH_ALLOWED_CIDR" != "8.8.8.8/32" ]] || { echo "FAIL: fell back to saved"; FAIL=$((FAIL + 1)); }
echo "PASS: invalid explicit does not fall back to saved"
PASS=$((PASS + 1))

# --- unset + empty state ---
unset SSH_ALLOWED_CIDR || true
capture_ssh_allowed_cidr_from_env
SSH_ALLOWED_CIDR=""
resolve_ssh_allowed_cidr
assert_eq "unset empty value" "$SSH_ALLOWED_CIDR" ""
assert_eq "unset source" "$SSH_ALLOWED_CIDR_SOURCE" "unset"

echo "----"
echo "Passed=$PASS Failed=$FAIL"
(( FAIL == 0 ))
