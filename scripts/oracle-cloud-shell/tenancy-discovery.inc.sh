# Tenancy discovery helpers for Cloud Shell provisioner.
# Sourced by provision-e2-micro.sh and by offline regression tests.
# shellcheck shell=bash

# Precedence for tenancy OCID:
#   1) TENANCY_OCID (explicit operator override)
#   2) OCI_CLI_TENANCY (official CLI env var)
#   3) tenancy= in active profile of effective config file
#   4) (optional) caller may try a read-only OCI API fallback

is_tenancy_ocid() {
  [[ "${1:-}" =~ ^ocid1\.tenancy\.oc[0-9]+\. ]]
}

# Resolve config path: OCI_CLI_CONFIG_FILE, then ~/.oci/config, then Cloud Shell /etc/oci/config.
resolve_oci_config_file() {
  if [[ -n "${OCI_CLI_CONFIG_FILE:-}" ]]; then
    printf '%s\n' "$OCI_CLI_CONFIG_FILE"
    return 0
  fi
  if [[ -f "${HOME}/.oci/config" ]]; then
    printf '%s\n' "${HOME}/.oci/config"
    return 0
  fi
  if [[ -f /etc/oci/config ]]; then
    printf '%s\n' /etc/oci/config
    return 0
  fi
  return 1
}

# Active profile: OCI_CLI_PROFILE, else DEFAULT if present in file, else first profile stanza.
resolve_oci_profile() {
  local config_file="${1:-}"
  if [[ -n "${OCI_CLI_PROFILE:-}" ]]; then
    printf '%s\n' "$OCI_CLI_PROFILE"
    return 0
  fi
  if [[ -n "$config_file" && -f "$config_file" ]]; then
    if grep -q '^\[DEFAULT\]' "$config_file"; then
      printf '%s\n' "DEFAULT"
      return 0
    fi
    local first
    first="$(awk '/^\[/{gsub(/[\[\]]/,""); print; exit}' "$config_file")"
    if [[ -n "$first" ]]; then
      printf '%s\n' "$first"
      return 0
    fi
  fi
  printf '%s\n' "DEFAULT"
}

# Read tenancy= from a specific [profile] section (no inheritance walk beyond that section).
read_tenancy_from_profile() {
  local config_file="$1"
  local profile="$2"
  [[ -f "$config_file" ]] || return 1
  awk -v profile="$profile" '
    BEGIN { in_profile=0 }
    /^\[/ {
      name=$0
      gsub(/^\[/, "", name)
      gsub(/\]$/, "", name)
      in_profile = (name == profile)
      next
    }
    in_profile && /^[[:space:]]*tenancy[[:space:]]*=/ {
      sub(/^[^=]*=[[:space:]]*/, "")
      gsub(/[[:space:]]+$/, "")
      print
      exit
    }
  ' "$config_file"
}

# Resolve tenancy without calling OCI.
# Sets RESOLVED_TENANCY_OCID and TENANCY_DISCOVERY_SOURCE.
# Returns 0 on success, 1 if not found.
# Do not capture this function in $() — that would discard the source label.
resolve_tenancy_ocid_offline() {
  TENANCY_DISCOVERY_SOURCE=""
  RESOLVED_TENANCY_OCID=""
  local candidate=""

  if [[ -n "${TENANCY_OCID:-}" ]]; then
    candidate="$TENANCY_OCID"
    TENANCY_DISCOVERY_SOURCE="TENANCY_OCID"
  elif [[ -n "${OCI_CLI_TENANCY:-}" ]]; then
    candidate="$OCI_CLI_TENANCY"
    TENANCY_DISCOVERY_SOURCE="OCI_CLI_TENANCY"
  else
    local config_file profile
    if config_file="$(resolve_oci_config_file)"; then
      profile="$(resolve_oci_profile "$config_file")"
      candidate="$(read_tenancy_from_profile "$config_file" "$profile" || true)"
      if [[ -n "$candidate" ]]; then
        TENANCY_DISCOVERY_SOURCE="config:${config_file}#${profile}"
      fi
    fi
  fi

  if [[ -z "$candidate" ]]; then
    return 1
  fi
  if ! is_tenancy_ocid "$candidate"; then
    TENANCY_DISCOVERY_SOURCE="${TENANCY_DISCOVERY_SOURCE:-unknown}:invalid_format"
    return 1
  fi
  RESOLVED_TENANCY_OCID="$candidate"
  return 0
}

# Classify OCI CLI stderr for operator-facing errors (no secrets).
classify_oci_cli_failure() {
  local stderr_file="$1"
  local text
  text="$(tr '\n' ' ' <"$stderr_file" 2>/dev/null || true)"
  if echo "$text" | grep -qiE 'NotAuthenticated|NotAuthenticatedOrNotFound|401|InvalidAuthentication|security.?token|delegation.?token'; then
    printf '%s\n' "authentication"
    return 0
  fi
  if echo "$text" | grep -qiE 'NotAuthorized|NotAuthorizedOrNotFound|Authorization failed|403|AuthorizationFailed|Forbidden'; then
    printf '%s\n' "permission"
    return 0
  fi
  printf '%s\n' "other"
}

# Read-only API fallback: root compartment OCID == tenancy OCID.
# Requires working pre-authenticated oci CLI (Cloud Shell). Does not mutate config.
discover_tenancy_via_oci_api() {
  local err tmp
  err="$(mktemp)"
  tmp="$(mktemp)"
  # shellcheck disable=SC2068
  if ! oci iam compartment list --include-root --access-level ACCESSIBLE --compartment-id-in-subtree true \
      --all --output json >"$tmp" 2>"$err"; then
    printf '%s\n' "$(classify_oci_cli_failure "$err")"
    rm -f "$err" "$tmp"
    return 1
  fi
  local root
  root="$(jq -r '
    .data
    | map(select(.["compartment-id"] == null))
    | .[0].id // empty
  ' <"$tmp")"
  rm -f "$err" "$tmp"
  if is_tenancy_ocid "$root"; then
    printf '%s\n' "$root"
    return 0
  fi
  return 1
}

# Validate tenancy with a read-only get. Prints: ok | authentication | permission | other
validate_tenancy_ocid() {
  local tenancy="$1"
  local err
  err="$(mktemp)"
  if oci iam tenancy get --tenancy-id "$tenancy" --output json >/dev/null 2>"$err"; then
    rm -f "$err"
    printf '%s\n' "ok"
    return 0
  fi
  # Some tenancies respond better via root compartment get.
  if oci iam compartment get --compartment-id "$tenancy" --output json >/dev/null 2>>"$err"; then
    rm -f "$err"
    printf '%s\n' "ok"
    return 0
  fi
  local kind
  kind="$(classify_oci_cli_failure "$err")"
  rm -f "$err"
  printf '%s\n' "$kind"
  return 1
}
