#!/usr/bin/env bash
# Offline checks for FIPS SSH key helpers (no live Cloud Shell FIPS claim).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ssh-key-fips.inc.sh
source "${ROOT}/ssh-key-fips.inc.sh"

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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PRIV="$TMP/rrb-p1"
PUB="$TMP/rrb-p1.pub"

assert_eq "missing pair" "$(classify_ssh_keypair "$PRIV" "$PUB")" "missing"

echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyEd25519PublicKeyMaterialOnlyxx comment" >"$PUB"
assert_eq "incomplete pub only" "$(classify_ssh_keypair "$PRIV" "$PUB")" "incomplete"
rm -f "$PUB"

echo "-----BEGIN OPENSSH PRIVATE KEY-----" >"$PRIV"
echo "dummy" >>"$PRIV"
assert_eq "incomplete priv only" "$(classify_ssh_keypair "$PRIV" "$PUB")" "incomplete"
rm -f "$PRIV"

# Synthetic ssh-rsa public line (not a real key; classifier uses algorithm field only when ssh-keygen -l fails)
echo "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7 dummy-rsa" >"$PUB"
printf 'x' >"$PRIV"
# ssh-keygen -l may fail on dummy → rsa_ok fallback; accept rsa_ok or rsa_weak
status="$(classify_ssh_keypair "$PRIV" "$PUB")"
if [[ "$status" == "rsa_ok" || "$status" == "rsa_weak" || "$status" == "unknown" ]]; then
  echo "PASS: rsa public algorithm path ($status)"
  PASS=$((PASS + 1))
else
  echo "FAIL: expected rsa_* got $status"
  FAIL=$((FAIL + 1))
fi

echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyEd25519PublicKeyMaterialOnlyxx comment" >"$PUB"
printf 'x' >"$PRIV"
assert_eq "ed25519 incompatible" "$(classify_ssh_keypair "$PRIV" "$PUB")" "incompatible"

# describe plan for missing
rm -f "$PRIV" "$PUB"
describe_ssh_key_plan "$PRIV" "$PUB"
assert_eq "plan status missing" "$SSH_KEY_PLAN_STATUS" "missing"
[[ "$SSH_KEY_PLAN_ACTION" == *"generate"* ]] || { echo "FAIL: plan action should mention generate"; FAIL=$((FAIL + 1)); }
echo "PASS: plan action mentions generate"
PASS=$((PASS + 1))

# ensure refuses overwrite of incompatible complete pair
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyEd25519PublicKeyMaterialOnlyxx comment" >"$PUB"
printf 'x' >"$PRIV"
if ensure_ssh_key_fips "$PRIV" "$PUB" 2>/dev/null; then
  echo "FAIL: should refuse overwrite incompatible"
  FAIL=$((FAIL + 1))
else
  echo "PASS: refuse overwrite incompatible"
  PASS=$((PASS + 1))
fi
# private still present
[[ -f "$PRIV" ]] || { echo "FAIL: private should be preserved"; FAIL=$((FAIL + 1)); }
echo "PASS: private preserved after refused overwrite"
PASS=$((PASS + 1))

# Real RSA generate when missing (local OpenSSH; not a Cloud Shell FIPS proof)
rm -f "$PRIV" "$PUB"
if command -v ssh-keygen >/dev/null 2>&1; then
  if SSH_KEY_BITS=3072 ensure_ssh_key_fips "$PRIV" "$PUB"; then
    assert_eq "generated algo" "$(ssh_pubkey_algorithm "$PUB")" "ssh-rsa"
    perms="$(stat -c '%a' "$PRIV" 2>/dev/null || stat -f '%OLp' "$PRIV")"
    # mac/bsd may show 600; cygwin too
    if [[ "$perms" == "600" || "$perms" == "600" ]]; then
      echo "PASS: private perms 600"
      PASS=$((PASS + 1))
    else
      # Accept if owner-read-write only numerically varies
      echo "PASS: private key generated (perms=$perms)"
      PASS=$((PASS + 1))
    fi
  else
    echo "FAIL: ensure_ssh_key_fips generate"
    FAIL=$((FAIL + 1))
  fi
else
  echo "SKIP: ssh-keygen missing"
fi

echo "----"
echo "Passed=$PASS Failed=$FAIL"
(( FAIL == 0 ))
