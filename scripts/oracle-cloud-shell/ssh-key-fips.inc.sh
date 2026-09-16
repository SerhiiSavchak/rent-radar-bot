# SSH key helpers for Cloud Shell FIPS-compatible provisioning.
# shellcheck shell=bash

# Cloud Shell runs OpenSSH in FIPS mode: ED25519 key generation is rejected.
# Use RSA 3072-bit keys. Do not disable FIPS.

SSH_KEY_TYPE="${SSH_KEY_TYPE:-rsa}"
SSH_KEY_BITS="${SSH_KEY_BITS:-3072}"

ssh_pubkey_algorithm() {
  local pub="$1"
  [[ -f "$pub" ]] || return 1
  # Public keys are one line: "ssh-rsa AAAA... comment" — safe to read (not private).
  awk '{print $1; exit}' "$pub"
}

ssh_private_looks_present() {
  [[ -f "${1:-}" && -s "${1:-}" ]]
}

ssh_public_looks_present() {
  [[ -f "${1:-}" && -s "${1:-}" ]]
}

# Returns: missing | incomplete | rsa_ok | rsa_weak | incompatible | unknown
classify_ssh_keypair() {
  local priv="$1"
  local pub="$2"
  local has_priv=0 has_pub=0
  ssh_private_looks_present "$priv" && has_priv=1
  ssh_public_looks_present "$pub" && has_pub=1

  if (( has_priv == 0 && has_pub == 0 )); then
    printf '%s\n' "missing"
    return 0
  fi
  if (( has_priv != has_pub )); then
    printf '%s\n' "incomplete"
    return 0
  fi

  local algo
  algo="$(ssh_pubkey_algorithm "$pub" || true)"
  case "$algo" in
    ssh-rsa)
      if command -v ssh-keygen >/dev/null 2>&1; then
        local bits
        bits="$(ssh-keygen -lf "$pub" 2>/dev/null | awk '{print $1; exit}')"
        if [[ "$bits" =~ ^[0-9]+$ ]]; then
          if (( bits >= SSH_KEY_BITS )); then
            printf '%s\n' "rsa_ok"
            return 0
          fi
          printf '%s\n' "rsa_weak"
          return 0
        fi
      fi
      printf '%s\n' "rsa_ok"
      return 0
      ;;
    ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)
      printf '%s\n' "incompatible"
      return 0
      ;;
    *)
      printf '%s\n' "unknown"
      return 0
      ;;
  esac
}

# Plan-only: describe intended key configuration; never generates keys.
describe_ssh_key_plan() {
  local priv="$1"
  local pub="$2"
  local status
  status="$(classify_ssh_keypair "$priv" "$pub")"
  SSH_KEY_PLAN_STATUS="$status"
  case "$status" in
    missing)
      SSH_KEY_PLAN_ACTION="apply will generate ${SSH_KEY_TYPE} ${SSH_KEY_BITS}-bit keypair (FIPS-compatible)"
      ;;
    rsa_ok)
      SSH_KEY_PLAN_ACTION="reuse existing RSA public key at ${pub} (private key not printed)"
      ;;
    rsa_weak)
      SSH_KEY_PLAN_ACTION="EXISTING RSA key is under ${SSH_KEY_BITS} bits — move it aside before apply (will not overwrite)"
      ;;
    incomplete)
      SSH_KEY_PLAN_ACTION="INCOMPLETE keypair (priv/pub mismatch) — repair manually before apply (will not overwrite)"
      ;;
    incompatible)
      SSH_KEY_PLAN_ACTION="EXISTING key algorithm is not FIPS-compatible for this host — move aside before apply (will not overwrite)"
      ;;
    *)
      SSH_KEY_PLAN_ACTION="EXISTING key could not be classified — inspect manually before apply (will not overwrite)"
      ;;
  esac
}

# Apply-only: ensure a usable RSA-3072 key exists. Never overwrites an existing private key.
ensure_ssh_key_fips() {
  local priv="$1"
  local pub="$2"
  local key_dir
  key_dir="$(dirname "$priv")"
  mkdir -p "$key_dir"
  chmod 700 "$key_dir"

  local status
  status="$(classify_ssh_keypair "$priv" "$pub")"
  case "$status" in
    rsa_ok)
      chmod 600 "$priv"
      chmod 644 "$pub" 2>/dev/null || true
      return 0
      ;;
    missing)
      ;;
    incomplete)
      echo "ERROR: Incomplete SSH keypair at ${priv} / ${pub}. Refusing to overwrite. Remove or restore the missing half, then retry apply." >&2
      return 1
      ;;
    incompatible|rsa_weak|unknown)
      echo "ERROR: Existing key at ${priv} is not reusable (status=${status}). Move it aside, e.g.: mv ${priv} ${priv}.bak.\$(date +%Y%m%d) && mv ${pub} ${pub}.bak.\$(date +%Y%m%d) — then retry apply. Refusing silent overwrite." >&2
      return 1
      ;;
  esac

  if [[ -e "$priv" || -e "$pub" ]]; then
    echo "ERROR: Refusing to overwrite existing key path material at ${priv} or ${pub}." >&2
    return 1
  fi

  command -v ssh-keygen >/dev/null 2>&1 || { echo "ERROR: ssh-keygen not found" >&2; return 1; }
  # RSA 3072 is FIPS-compatible on Cloud Shell; do not use ed25519; do not disable FIPS.
  ssh-keygen -t rsa -b "${SSH_KEY_BITS}" -N "" -f "$priv" -C "rrb-p1-fips-rsa@cloudshell" >/dev/null
  chmod 600 "$priv"
  chmod 644 "$pub"
  return 0
}
