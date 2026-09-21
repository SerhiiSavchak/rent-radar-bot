#!/usr/bin/env bash
# Offline regression checks for tenancy discovery (dummy values only).
# Does not call live OCI. Run: bash scripts/oracle-cloud-shell/test-tenancy-discovery.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tenancy-discovery.inc.sh
source "${ROOT}/tenancy-discovery.inc.sh"

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

cat >"$TMP/cloudshell-config" <<'EOF'
[eu-frankfurt-1]
tenancy=ocid1.tenancy.oc1..dummytenancyfrankfurt00001
region=eu-frankfurt-1
user=ocid1.user.oc1..dummyuser00001
[us-ashburn-1]
tenancy=ocid1.tenancy.oc1..dummytenancyashburn0000001
region=us-ashburn-1
EOF

cat >"$TMP/home-config" <<'EOF'
[DEFAULT]
tenancy=ocid1.tenancy.oc1..dummytenancydefault0000001
user=ocid1.user.oc1..dummyuserdefault0000001
[other]
tenancy=ocid1.tenancy.oc1..dummytenancyother000000001
EOF

unset TENANCY_OCID OCI_CLI_TENANCY OCI_CLI_CONFIG_FILE OCI_CLI_PROFILE || true

export TENANCY_OCID="ocid1.tenancy.oc1..dummyexplicitoverride000001"
export OCI_CLI_TENANCY="ocid1.tenancy.oc1..shouldnotwin000000000001"
export OCI_CLI_CONFIG_FILE="$TMP/cloudshell-config"
export OCI_CLI_PROFILE="eu-frankfurt-1"
resolve_tenancy_ocid_offline
assert_eq "explicit TENANCY_OCID precedence" "$RESOLVED_TENANCY_OCID" "ocid1.tenancy.oc1..dummyexplicitoverride000001"
assert_eq "source label explicit" "$TENANCY_DISCOVERY_SOURCE" "TENANCY_OCID"

unset TENANCY_OCID
export OCI_CLI_TENANCY="ocid1.tenancy.oc1..dummyclitenancyenv00000001"
resolve_tenancy_ocid_offline
assert_eq "OCI_CLI_TENANCY precedence" "$RESOLVED_TENANCY_OCID" "ocid1.tenancy.oc1..dummyclitenancyenv00000001"
assert_eq "source label env" "$TENANCY_DISCOVERY_SOURCE" "OCI_CLI_TENANCY"

unset OCI_CLI_TENANCY TENANCY_OCID
export OCI_CLI_CONFIG_FILE="$TMP/cloudshell-config"
export OCI_CLI_PROFILE="eu-frankfurt-1"
resolve_tenancy_ocid_offline
assert_eq "Cloud Shell profile tenancy" "$RESOLVED_TENANCY_OCID" "ocid1.tenancy.oc1..dummytenancyfrankfurt00001"
assert_eq "source includes profile" "$TENANCY_DISCOVERY_SOURCE" "config:${TMP}/cloudshell-config#eu-frankfurt-1"

export OCI_CLI_PROFILE="us-ashburn-1"
resolve_tenancy_ocid_offline
assert_eq "alternate profile tenancy" "$RESOLVED_TENANCY_OCID" "ocid1.tenancy.oc1..dummytenancyashburn0000001"

unset OCI_CLI_PROFILE
export OCI_CLI_CONFIG_FILE="$TMP/home-config"
resolve_tenancy_ocid_offline
assert_eq "DEFAULT profile when unset" "$RESOLVED_TENANCY_OCID" "ocid1.tenancy.oc1..dummytenancydefault0000001"

unset TENANCY_OCID OCI_CLI_TENANCY OCI_CLI_PROFILE
export OCI_CLI_CONFIG_FILE="$TMP/missing-file-does-not-exist"
if resolve_tenancy_ocid_offline; then
  echo "FAIL: expected miss on missing config"
  FAIL=$((FAIL + 1))
else
  echo "PASS: missing config yields discovery miss"
  PASS=$((PASS + 1))
fi

export TENANCY_OCID="not-an-ocid"
if resolve_tenancy_ocid_offline; then
  echo "FAIL: invalid OCID should miss"
  FAIL=$((FAIL + 1))
else
  echo "PASS: invalid OCID rejected"
  PASS=$((PASS + 1))
fi

assert_eq "resolve profile from env" "$(OCI_CLI_PROFILE=eu-frankfurt-1 resolve_oci_profile "$TMP/cloudshell-config")" "eu-frankfurt-1"
assert_eq "resolve config file from env" "$(OCI_CLI_CONFIG_FILE=$TMP/cloudshell-config resolve_oci_config_file)" "$TMP/cloudshell-config"

echo "----"
echo "Passed=$PASS Failed=$FAIL"
(( FAIL == 0 ))
