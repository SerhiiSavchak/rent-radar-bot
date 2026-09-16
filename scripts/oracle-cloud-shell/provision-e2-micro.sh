#!/usr/bin/env bash
# Rent Radar Bot — Always Free E2.1.Micro provisioner for Oracle Cloud Shell
# Modes: plan | apply | status | cleanup
#
# Authorized: ONE VM.Standard.E2.1.Micro + minimal free VCN/IGW/RT/SL/NSG/subnet
# + 50 GB boot. No NAT, LB, paid shapes, billing upgrade, or IAM policy changes.
# Never prints private keys. Never deletes resources it did not record.

set -euo pipefail

PREFIX="${PREFIX:-rrb-p1}"
SHAPE="VM.Standard.E2.1.Micro"
BOOT_GB="${BOOT_GB:-50}"
VCN_CIDR="${VCN_CIDR:-10.42.0.0/16}"
SUBNET_CIDR="${SUBNET_CIDR:-10.42.1.0/24}"
STATE_DIR="${STATE_DIR:-$HOME/rent-radar-phase1-oracle}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/state.env}"
KEY_DIR="${KEY_DIR:-$STATE_DIR/ssh}"
PUBLIC_KEY_FILE="${PUBLIC_KEY_FILE:-$KEY_DIR/${PREFIX}.pub}"
PRIVATE_KEY_FILE="${PRIVATE_KEY_FILE:-$KEY_DIR/${PREFIX}}"
DISPLAY_NAME="${DISPLAY_NAME:-${PREFIX}-olx-probe}"
SSH_ALLOWED_CIDR="${SSH_ALLOWED_CIDR:-}"

MODE="${1:-}"
[[ -n "$MODE" ]] || { echo "Usage: $0 {plan|apply|status|cleanup}" >&2; exit 2; }

mkdir -p "$STATE_DIR" "$KEY_DIR"
chmod 700 "$STATE_DIR" "$KEY_DIR" 2>/dev/null || true

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

need oci
need jq

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "${SCRIPT_DIR}/tenancy-discovery.inc.sh" ]]; then
  die "Missing ${SCRIPT_DIR}/tenancy-discovery.inc.sh — upload it next to provision-e2-micro.sh"
fi
if [[ ! -f "${SCRIPT_DIR}/ssh-key-fips.inc.sh" ]]; then
  die "Missing ${SCRIPT_DIR}/ssh-key-fips.inc.sh — upload it next to provision-e2-micro.sh"
fi
# shellcheck source=tenancy-discovery.inc.sh
source "${SCRIPT_DIR}/tenancy-discovery.inc.sh"
# shellcheck source=ssh-key-fips.inc.sh
source "${SCRIPT_DIR}/ssh-key-fips.inc.sh"

if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
fi

save_state() {
  umask 077
  cat >"$STATE_FILE" <<EOF
# rent-radar-bot Oracle Cloud Shell provisioner state — do not commit
CREATED_BY_SCRIPT='rent-radar-phase1-oracle'
TENANCY_OCID='${TENANCY_OCID:-}'
COMPARTMENT_OCID='${COMPARTMENT_OCID:-}'
REGION='${REGION:-}'
HOME_REGION='${HOME_REGION:-}'
AD_NAME='${AD_NAME:-}'
IMAGE_OCID='${IMAGE_OCID:-}'
IMAGE_NAME='${IMAGE_NAME:-}'
VCN_OCID='${VCN_OCID:-}'
IGW_OCID='${IGW_OCID:-}'
RT_OCID='${RT_OCID:-}'
SL_OCID='${SL_OCID:-}'
NSG_OCID='${NSG_OCID:-}'
SUBNET_OCID='${SUBNET_OCID:-}'
INSTANCE_OCID='${INSTANCE_OCID:-}'
PUBLIC_IP='${PUBLIC_IP:-}'
SSH_USER='${SSH_USER:-}'
SSH_ALLOWED_CIDR='${SSH_ALLOWED_CIDR:-}'
DISPLAY_NAME='${DISPLAY_NAME}'
EOF
  chmod 600 "$STATE_FILE"
  log "State saved: $STATE_FILE"
}

discover_context() {
  log "Discovering tenancy / region / ADs / images…"
  log "OCI config file: ${OCI_CLI_CONFIG_FILE:-<unset>}  profile: ${OCI_CLI_PROFILE:-<unset>}  auth: ${OCI_CLI_AUTH:-<unset>}"

  local discovered=""
  TENANCY_DISCOVERY_SOURCE=""
  RESOLVED_TENANCY_OCID=""
  if resolve_tenancy_ocid_offline; then
    TENANCY_OCID="$RESOLVED_TENANCY_OCID"
    log "Tenancy from ${TENANCY_DISCOVERY_SOURCE}"
  else
    log "Offline tenancy discovery missed (Cloud Shell uses /etc/oci/config + region profiles, not ~/.oci/config [DEFAULT]). Trying read-only OCI API…"
    local api_out api_rc=0
    api_out="$(discover_tenancy_via_oci_api)" || api_rc=$?
    if (( api_rc == 0 )) && is_tenancy_ocid "$api_out"; then
      TENANCY_OCID="$api_out"
      TENANCY_DISCOVERY_SOURCE="oci_api:compartment_list_include_root"
      log "Tenancy from ${TENANCY_DISCOVERY_SOURCE}"
    else
      case "$api_out" in
        authentication)
          die "OCI authentication failure while discovering tenancy. Cloud Shell session may need refresh (re-open Cloud Shell). Do not run oci setup config."
          ;;
        permission)
          die "OCI permission failure while listing compartments. Your user lacks IAM inspect on compartments/tenancy."
          ;;
      esac
      die "Tenancy discovery failed. Set an explicit override from Console (Governance → Tenancy details → OCID), then: export TENANCY_OCID=ocid1.tenancy...."
    fi
  fi

  local validation
  validation="$(validate_tenancy_ocid "$TENANCY_OCID")" || true
  case "$validation" in
    ok) log "Tenancy OCID validated (read-only)" ;;
    authentication)
      die "Discovered tenancy OCID but OCI authentication failed on validate. Re-open Cloud Shell; do not run oci setup config."
      ;;
    permission)
      die "Discovered tenancy OCID but IAM read was denied (permission failure)."
      ;;
    *)
      die "Discovered value did not validate as a readable tenancy/root compartment. Check TENANCY_OCID override from Console."
      ;;
  esac

  COMPARTMENT_OCID="${COMPARTMENT_OCID:-$TENANCY_OCID}"

  HOME_REGION="$(oci iam region-subscription list --output json \
    | jq -r '.data[] | select(.["is-home-region"]==true) | .["region-name"]' | head -1)"
  [[ -n "$HOME_REGION" ]] || die "Could not resolve home region (permission or auth failure on region-subscription list)"
  REGION="${OCI_CLI_REGION:-${REGION:-$HOME_REGION}}"
  export OCI_CLI_REGION="$REGION"
  if [[ "$REGION" != "$HOME_REGION" ]]; then
    die "Region '$REGION' != home '$HOME_REGION'. Always Free Micro is home-region only. export OCI_CLI_REGION=$HOME_REGION"
  fi
  log "Home/active region: $REGION"

  AD_JSON="$(oci iam availability-domain list --compartment-id "$TENANCY_OCID" --output json)"
  log "Availability domains:"
  jq -r '.data[] | "  - " + .name' <<<"$AD_JSON"
  # Prefer *AD-3 (tenancy-specific prefix); do not hardcode another tenancy's AD string.
  AD_NAME="$(jq -r '.data[] | select(.name|test("AD-3$")) | .name' <<<"$AD_JSON" | head -1)"
  if [[ -z "$AD_NAME" || "$AD_NAME" == "null" ]]; then
    AD_NAME="$(jq -r '.data[0].name' <<<"$AD_JSON")"
  fi
  [[ -n "$AD_NAME" && "$AD_NAME" != "null" ]] || die "No availability domain found"
  log "Selected AD: $AD_NAME (Micro is only creatable in one AD per multi-AD region)"

  if ! oci compute shape list --compartment-id "$COMPARTMENT_OCID" --all --output json \
      | jq -e --arg s "$SHAPE" '[.data[].shape] | index($s) != null' >/dev/null; then
    die "Shape $SHAPE not listed. Aborting — no paid substitute."
  fi

  IMAGE_JSON="$(oci compute image list \
    --compartment-id "$COMPARTMENT_OCID" \
    --operating-system "Canonical Ubuntu" \
    --operating-system-version "22.04" \
    --shape "$SHAPE" \
    --sort-by TIMECREATED --sort-order DESC \
    --all --output json)"
  IMAGE_OCID="$(jq -r '
    .data
    | map(select((.["display-name"] // "") | test("Minimal|aarch64|GPU"; "i") | not))
    | .[0].id // empty
  ' <<<"$IMAGE_JSON")"
  SSH_USER="ubuntu"
  if [[ -z "$IMAGE_OCID" ]]; then
    IMAGE_OCID="$(oci compute image list \
      --compartment-id "$COMPARTMENT_OCID" \
      --operating-system "Oracle Linux" \
      --shape "$SHAPE" \
      --sort-by TIMECREATED --sort-order DESC \
      --all --output json | jq -r '.data[0].id // empty')"
    SSH_USER="opc"
  fi
  [[ -n "$IMAGE_OCID" ]] || die "No compatible Ubuntu/Oracle Linux image for $SHAPE"
  IMAGE_NAME="$(oci compute image get --image-id "$IMAGE_OCID" --output json | jq -r '.data["display-name"]')"
  log "Image: $IMAGE_NAME ($IMAGE_OCID); ssh user=$SSH_USER"

  EXISTING_INSTANCE="$(oci compute instance list --compartment-id "$COMPARTMENT_OCID" --lifecycle-state RUNNING --all --output json \
    | jq -r --arg n "$DISPLAY_NAME" '.data[] | select(.["display-name"]==$n) | .id' | head -1)"
  if [[ -n "${EXISTING_INSTANCE:-}" ]]; then
    INSTANCE_OCID="$EXISTING_INSTANCE"
    log "Found existing RUNNING instance $DISPLAY_NAME ($INSTANCE_OCID)"
  fi
}

ensure_ssh_key() {
  # Apply-only. Plan must never call this (Cloud Shell FIPS rejects ed25519 generation).
  need ssh-keygen
  log "Ensuring FIPS-compatible RSA-${SSH_KEY_BITS} SSH key (private key not printed)…"
  if ! ensure_ssh_key_fips "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE"; then
    die "SSH key preparation failed (see message above). No cloud resources were created yet."
  fi
  local status
  status="$(classify_ssh_keypair "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE")"
  [[ "$status" == "rsa_ok" ]] || die "SSH keypair not ready after ensure (status=${status})"
  chmod 700 "$KEY_DIR"
  chmod 600 "$PRIVATE_KEY_FILE"
  chmod 644 "$PUBLIC_KEY_FILE"
  log "SSH public key ready at $PUBLIC_KEY_FILE (algo=$(ssh_pubkey_algorithm "$PUBLIC_KEY_FILE"))"
}

print_plan() {
  describe_ssh_key_plan "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE"
  cat <<EOF

======== PLAN (read-only; no create; no key generation) ========
Tenancy:        $TENANCY_OCID
Compartment:    $COMPARTMENT_OCID
Region:         $REGION (home)
AD:             $AD_NAME
Shape:          $SHAPE
Image:          $IMAGE_NAME
Boot:           ${BOOT_GB} GB (Always Free pool = 200 GB total)
Name:           $DISPLAY_NAME
SSH CIDR:       ${SSH_ALLOWED_CIDR:-<REQUIRED for apply>}
SSH key type:   ${SSH_KEY_TYPE} ${SSH_KEY_BITS}-bit (FIPS-compatible; not ed25519)
SSH priv path:  $PRIVATE_KEY_FILE
SSH pub path:   $PUBLIC_KEY_FILE
SSH key status: $SSH_KEY_PLAN_STATUS
SSH key action: $SSH_KEY_PLAN_ACTION
State file:     $STATE_FILE

Create if missing (tag created-by=${PREFIX}):
  VCN, IGW, public RT, custom Security List (no world SSH),
  NSG (SSH only from SSH_ALLOWED_CIDR; egress 80/443/53),
  public subnet, ONE Micro + ephemeral public IPv4.

Never: NAT GW, LB, DB, extra volumes, paid shapes, 0.0.0.0/0 SSH, IAM edits.

Why public IP (not private+NAT): NAT Gateway is not Always Free. Public IP + IGW
gives outbound HTTPS for the OLX probe without paid NAT.

Restricted SSH: NSG allowlist SSH_ALLOWED_CIDR only. Discover IP:
  # In Cloud Shell: Network menu -> Public Network, then:
  curl -4 -s https://api.ipify.org; echo
  export SSH_ALLOWED_CIDR=<ip>/32

Cloud Shell FIPS: plan never generates keys; apply creates RSA ${SSH_KEY_BITS} only if missing.
=============================================
EOF
}

validate_apply() {
  [[ "${BOOT_GB}" == "50" ]] || die "BOOT_GB must be 50 for this Always Free script"
  [[ -n "$SSH_ALLOWED_CIDR" ]] || die "export SSH_ALLOWED_CIDR=x.x.x.x/32 before apply"
  [[ "$SSH_ALLOWED_CIDR" != "0.0.0.0/0" ]] || die "Refusing world-open SSH"
  [[ "$SSH_ALLOWED_CIDR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || die "Bad SSH_ALLOWED_CIDR format"
  if [[ -n "${INSTANCE_OCID:-}" ]]; then
    die "Instance already exists/recorded ($INSTANCE_OCID). Use '$0 status' — no duplicate create."
  fi
  describe_ssh_key_plan "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE"
  case "${SSH_KEY_PLAN_STATUS:-}" in
    missing|rsa_ok) ;;
    *)
      die "SSH key not ready for apply (status=${SSH_KEY_PLAN_STATUS}). ${SSH_KEY_PLAN_ACTION}. Fix keys before apply — no cloud resources will be created."
      ;;
  esac
}

create_all() {
  # Keys first — before any OCI create — so a FIPS/key failure leaves no partial cloud spend.
  ensure_ssh_key
  local pubkey
  pubkey="$(tr -d '\n' <"$PUBLIC_KEY_FILE")"

  if [[ -z "${VCN_OCID:-}" ]]; then
    log "Creating VCN…"
    VCN_OCID="$(oci network vcn create \
      --compartment-id "$COMPARTMENT_OCID" \
      --display-name "${PREFIX}-vcn" \
      --cidr-blocks "[\"$VCN_CIDR\"]" \
      --dns-label rrbp1 \
      --freeform-tags "{\"created-by\":\"${PREFIX}\"}" \
      --wait-for-state AVAILABLE --output json | jq -r '.data.id')"
    save_state
  else log "Reuse VCN $VCN_OCID"; fi

  if [[ -z "${IGW_OCID:-}" ]]; then
    log "Creating IGW…"
    IGW_OCID="$(oci network internet-gateway create \
      --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" \
      --display-name "${PREFIX}-igw" --is-enabled true \
      --freeform-tags "{\"created-by\":\"${PREFIX}\"}" \
      --wait-for-state AVAILABLE --output json | jq -r '.data.id')"
    save_state
  fi

  if [[ -z "${RT_OCID:-}" ]]; then
    log "Creating route table…"
    RT_OCID="$(oci network route-table create \
      --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" \
      --display-name "${PREFIX}-rt" \
      --route-rules "[{\"cidrBlock\":\"0.0.0.0/0\",\"networkEntityId\":\"${IGW_OCID}\"}]" \
      --freeform-tags "{\"created-by\":\"${PREFIX}\"}" \
      --wait-for-state AVAILABLE --output json | jq -r '.data.id')"
    save_state
  fi

  # Custom SL with egress only — prevents default SL world-SSH on the subnet.
  if [[ -z "${SL_OCID:-}" ]]; then
    log "Creating security list (egress only; SSH via NSG)…"
    SL_OCID="$(oci network security-list create \
      --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" \
      --display-name "${PREFIX}-sl" \
      --egress-security-rules "[{\"destination\":\"0.0.0.0/0\",\"protocol\":\"all\",\"isStateless\":false,\"destinationType\":\"CIDR_BLOCK\"}]" \
      --ingress-security-rules "[]" \
      --freeform-tags "{\"created-by\":\"${PREFIX}\"}" \
      --wait-for-state AVAILABLE --output json | jq -r '.data.id')"
    save_state
  fi

  if [[ -z "${NSG_OCID:-}" ]]; then
    log "Creating NSG…"
    NSG_OCID="$(oci network nsg create \
      --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" \
      --display-name "${PREFIX}-nsg" \
      --freeform-tags "{\"created-by\":\"${PREFIX}\"}" \
      --output json | jq -r '.data.id')"
    oci network nsg rules add --nsg-id "$NSG_OCID" --security-rules "[
      {\"direction\":\"INGRESS\",\"protocol\":\"6\",\"source\":\"${SSH_ALLOWED_CIDR}\",\"sourceType\":\"CIDR_BLOCK\",\"isStateless\":false,
       \"tcpOptions\":{\"destinationPortRange\":{\"min\":22,\"max\":22}},\"description\":\"ssh-operator\"},
      {\"direction\":\"EGRESS\",\"protocol\":\"6\",\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"isStateless\":false,
       \"tcpOptions\":{\"destinationPortRange\":{\"min\":443,\"max\":443}},\"description\":\"https\"},
      {\"direction\":\"EGRESS\",\"protocol\":\"6\",\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"isStateless\":false,
       \"tcpOptions\":{\"destinationPortRange\":{\"min\":80,\"max\":80}},\"description\":\"http\"},
      {\"direction\":\"EGRESS\",\"protocol\":\"17\",\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"isStateless\":false,
       \"udpOptions\":{\"destinationPortRange\":{\"min\":53,\"max\":53}},\"description\":\"dns-udp\"},
      {\"direction\":\"EGRESS\",\"protocol\":\"6\",\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"isStateless\":false,
       \"tcpOptions\":{\"destinationPortRange\":{\"min\":53,\"max\":53}},\"description\":\"dns-tcp\"}
    ]" >/dev/null
    save_state
  fi

  if [[ -z "${SUBNET_OCID:-}" ]]; then
    log "Creating public subnet…"
    SUBNET_OCID="$(oci network subnet create \
      --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" \
      --display-name "${PREFIX}-subnet" --cidr-block "$SUBNET_CIDR" \
      --route-table-id "$RT_OCID" \
      --security-list-ids "[\"${SL_OCID}\"]" \
      --prohibit-public-ip-on-vnic false \
      --dns-label rrbp1sub \
      --freeform-tags "{\"created-by\":\"${PREFIX}\"}" \
      --wait-for-state AVAILABLE --output json | jq -r '.data.id')"
    save_state
  fi

  log "Launching instance (fail-fast on capacity; no paid fallback)…"
  set +e
  LAUNCH_OUT="$(oci compute instance launch \
    --compartment-id "$COMPARTMENT_OCID" \
    --availability-domain "$AD_NAME" \
    --shape "$SHAPE" \
    --display-name "$DISPLAY_NAME" \
    --image-id "$IMAGE_OCID" \
    --subnet-id "$SUBNET_OCID" \
    --assign-public-ip true \
    --nsg-ids "[\"${NSG_OCID}\"]" \
    --metadata "{\"ssh_authorized_keys\":\"${pubkey}\"}" \
    --boot-volume-size-in-gbs "$BOOT_GB" \
    --freeform-tags "{\"created-by\":\"${PREFIX}\",\"purpose\":\"olx-http-probe\"}" \
    --wait-for-state RUNNING \
    --output json 2>"$STATE_DIR/launch.err")"
  RC=$?
  set -e
  if (( RC != 0 )); then
    log "Launch failed — preserving partial state for resume/cleanup"
    sed -n '1,100p' "$STATE_DIR/launch.err" >&2 || true
    die "Capacity/launch error. Re-run apply after capacity recovers, or '$0 cleanup'. Do not upgrade billing via this script."
  fi

  INSTANCE_OCID="$(jq -r '.data.id' <<<"$LAUNCH_OUT")"
  save_state

  for _ in $(seq 1 36); do
    PUBLIC_IP="$(oci compute instance list-vnics --instance-id "$INSTANCE_OCID" --output json \
      | jq -r '.data[0]["public-ip"] // empty')"
    [[ -n "$PUBLIC_IP" ]] && break
    sleep 5
  done
  save_state
  [[ -n "$PUBLIC_IP" ]] || die "No public IP yet; re-run '$0 status'"

  cat <<EOF

======== APPLY COMPLETE ========
Instance: $INSTANCE_OCID
Public IP: $PUBLIC_IP
SSH: ssh -i $PRIVATE_KEY_FILE ${SSH_USER}@${PUBLIC_IP}
State: $STATE_FILE
(Private key path only — key material not printed)
================================
EOF
}

show_status() {
  discover_context
  if [[ -f "$STATE_FILE" ]]; then
    grep -E '^(REGION|AD_NAME|INSTANCE_OCID|PUBLIC_IP|VCN_OCID|SUBNET_OCID|NSG_OCID|SSH_ALLOWED_CIDR|SSH_USER)=' "$STATE_FILE" || true
  fi
  if [[ -n "${INSTANCE_OCID:-}" ]]; then
    oci compute instance get --instance-id "$INSTANCE_OCID" --output json \
      | jq '{id:.data.id,name:.data["display-name"],state:.data["lifecycle-state"],ad:.data["availability-domain"],shape:.data.shape}'
  fi
}

cleanup_created() {
  [[ -f "$STATE_FILE" ]] || die "No state file — refusing cleanup"
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  [[ "${CREATED_BY_SCRIPT:-}" == "rent-radar-phase1-oracle" ]] || die "Bad state marker; refusing cleanup"
  log "Cleaning ONLY IDs from $STATE_FILE"

  if [[ -n "${INSTANCE_OCID:-}" ]]; then
    oci compute instance terminate --instance-id "$INSTANCE_OCID" --preserve-boot-volume false --force --wait-for-state TERMINATED || true
    INSTANCE_OCID=""; PUBLIC_IP=""; save_state
  fi
  if [[ -n "${SUBNET_OCID:-}" ]]; then
    oci network subnet delete --subnet-id "$SUBNET_OCID" --force --wait-for-state TERMINATED || true
    SUBNET_OCID=""; save_state
  fi
  if [[ -n "${NSG_OCID:-}" ]]; then
    oci network nsg delete --nsg-id "$NSG_OCID" --force || true
    NSG_OCID=""; save_state
  fi
  if [[ -n "${SL_OCID:-}" ]]; then
    oci network security-list delete --security-list-id "$SL_OCID" --force --wait-for-state TERMINATED || true
    SL_OCID=""; save_state
  fi
  if [[ -n "${RT_OCID:-}" ]]; then
    oci network route-table delete --rt-id "$RT_OCID" --force --wait-for-state TERMINATED || true
    RT_OCID=""; save_state
  fi
  if [[ -n "${IGW_OCID:-}" ]]; then
    oci network internet-gateway delete --ig-id "$IGW_OCID" --force --wait-for-state TERMINATED || true
    IGW_OCID=""; save_state
  fi
  if [[ -n "${VCN_OCID:-}" ]]; then
    oci network vcn delete --vcn-id "$VCN_OCID" --force --wait-for-state TERMINATED || true
    VCN_OCID=""; save_state
  fi
  log "Cleanup done. Keys remain in $KEY_DIR until you delete them."
}

case "$MODE" in
  plan) discover_context; print_plan; save_state ;;
  apply) discover_context; validate_apply; print_plan; create_all ;;
  status) show_status ;;
  cleanup) cleanup_created ;;
  *) die "Unknown mode '$MODE'" ;;
esac
