# SSH_ALLOWED_CIDR resolve + validate for Oracle Cloud Shell provisioner.
# shellcheck shell=bash

# Capture whether the caller set SSH_ALLOWED_CIDR before state.env is sourced.
# Call capture_ssh_allowed_cidr_from_env BEFORE sourcing state (and before any default assignment).
capture_ssh_allowed_cidr_from_env() {
  if [[ -n "${SSH_ALLOWED_CIDR+x}" ]]; then
    SSH_ALLOWED_CIDR_EXPLICIT_SET=1
    SSH_ALLOWED_CIDR_EXPLICIT_VALUE="${SSH_ALLOWED_CIDR}"
  else
    SSH_ALLOWED_CIDR_EXPLICIT_SET=0
    SSH_ALLOWED_CIDR_EXPLICIT_VALUE=""
  fi
}

# After state load: prefer explicit env over saved state. Never fall back if explicit was set.
resolve_ssh_allowed_cidr() {
  local saved="${SSH_ALLOWED_CIDR:-}"
  if [[ "${SSH_ALLOWED_CIDR_EXPLICIT_SET:-0}" == "1" ]]; then
    SSH_ALLOWED_CIDR="${SSH_ALLOWED_CIDR_EXPLICIT_VALUE}"
    SSH_ALLOWED_CIDR_SOURCE="environment"
    return 0
  fi
  if [[ -n "$saved" ]]; then
    SSH_ALLOWED_CIDR="$saved"
    SSH_ALLOWED_CIDR_SOURCE="state"
    return 0
  fi
  SSH_ALLOWED_CIDR=""
  SSH_ALLOWED_CIDR_SOURCE="unset"
}

# True IPv4 host /32 only. Rejects placeholders, bad octets, and any non-/32 prefix.
is_valid_ssh_host_cidr32() {
  local cidr="${1:-}"
  local ip a b c d
  [[ -n "$cidr" ]] || return 1
  [[ "$cidr" == "0.0.0.0/0" ]] && return 1
  [[ "$cidr" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/32$ ]] || return 1
  a="${BASH_REMATCH[1]}"
  b="${BASH_REMATCH[2]}"
  c="${BASH_REMATCH[3]}"
  d="${BASH_REMATCH[4]}"
  # Reject leading zeros (octal traps / placeholder-like junk): allow only "0" or [1-9]...
  for o in "$a" "$b" "$c" "$d"; do
    [[ "$o" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
    (( 10#$o >= 0 && 10#$o <= 255 )) || return 1
  done
  return 0
}

# Human-readable reason for invalid CIDR (no secrets).
ssh_allowed_cidr_invalid_reason() {
  local cidr="${1:-}"
  if [[ -z "$cidr" ]]; then
    printf '%s\n' "empty"
    return 0
  fi
  if [[ "$cidr" == "0.0.0.0/0" ]]; then
    printf '%s\n' "world-open 0.0.0.0/0 is refused"
    return 0
  fi
  if [[ "$cidr" != */32 ]]; then
    printf '%s\n' "must be a single host CIDR ending in /32 (wider networks refused)"
    return 0
  fi
  if [[ ! "$cidr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/32$ ]]; then
    printf '%s\n' "not a dotted IPv4 /32 (placeholder or non-IPv4)"
    return 0
  fi
  printf '%s\n' "invalid IPv4 octets (each must be 0-255 without leading zeros)"
}
