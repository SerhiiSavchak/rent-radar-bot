# Oracle Cloud Shell — Always Free E2.1.Micro provisioner

Script: `provision-e2-micro.sh`  
Helpers: `tenancy-discovery.inc.sh`  
Companion OLX test (on the VM later): `npm run live:olx:experiment`  
Docs: `evidence/phase-1/oracle-e2-micro-experiment.md`

**This agent has not executed `apply` in your tenancy.**

## Cloud Shell auth (important)

Official Cloud Shell CLI config lives under **`/etc/oci/`**, not `~/.oci/config`:

- `OCI_CLI_CONFIG_FILE=/etc/oci/config`
- `OCI_CLI_PROFILE=<region>` (e.g. `eu-frankfurt-1`) — **no `[DEFAULT]` profile**
- `OCI_CLI_AUTH=instance_obo_user`

The provisioner discovers tenancy in this order:

1. `TENANCY_OCID` (explicit override)
2. `OCI_CLI_TENANCY`
3. `tenancy=` in the **active** profile of the effective config file
4. Read-only API: root compartment via `oci iam compartment list --include-root`
5. Validates with a read-only `oci iam tenancy get` / compartment get

It does **not** run `oci setup config` or create API keys.

### Optional override (from Console)

Governance / Administration → **Tenancy details** → copy **OCID**:

```bash
export TENANCY_OCID=ocid1.tenancy.oc1..aaaaaaaa...
```

## Free-tier assumptions

| Resource | Why free / allowed |
|----------|-------------------|
| `VM.Standard.E2.1.Micro` | Always Free (up to 2), **home region only**; Micro only in **one** AD |
| 50 GB boot | Within **200 GB** Always Free Block Volume |
| VCN + IGW + subnet + RT + SL + NSG | Free Tier networking |
| Ephemeral public IPv4 | Outbound HTTPS without paid **NAT Gateway** |

**Not created:** NAT GW, LB, DB, paid shapes, `0.0.0.0/0` SSH, IAM policy edits, billing upgrades.

## Restricted SSH

NSG allows TCP/22 only from `SSH_ALLOWED_CIDR`. Subnet uses a custom security list with **no** ingress (avoids default world-SSH). Public IP + IGW for egress (NAT is not Always Free).

## Exact Cloud Shell steps

### A. Replace the uploaded script

Upload **both** files into `~/rent-radar-phase1-oracle/` (Cloud Shell Upload):

- `provision-e2-micro.sh`
- `tenancy-discovery.inc.sh` (must sit next to the provisioner)

```bash
mkdir -p ~/rent-radar-phase1-oracle
mv ~/provision-e2-micro.sh ~/tenancy-discovery.inc.sh ~/rent-radar-phase1-oracle/ 2>/dev/null || true
chmod +x ~/rent-radar-phase1-oracle/provision-e2-micro.sh
cd ~/rent-radar-phase1-oracle
ls -l provision-e2-micro.sh tenancy-discovery.inc.sh
```

### B. Optional sanitized diagnostics (read-only)

If `plan` still fails, run **only** this block (no full env / config dumps):

```bash
echo "OCI_CLI_CONFIG_FILE=${OCI_CLI_CONFIG_FILE:+set}"
echo "OCI_CLI_PROFILE=${OCI_CLI_PROFILE:-<unset>}"
echo "OCI_CLI_AUTH=${OCI_CLI_AUTH:-<unset>}"
echo "OCI_CLI_TENANCY=${OCI_CLI_TENANCY:+set}"
echo "TENANCY_OCID=${TENANCY_OCID:+set}"
test -f "${OCI_CLI_CONFIG_FILE:-/etc/oci/config}" && echo "config_file=present" || echo "config_file=missing"
# profiles only (names), not secret values:
grep -E '^\[' "${OCI_CLI_CONFIG_FILE:-/etc/oci/config}" 2>/dev/null || true
oci iam region-subscription list --query 'data[?"is-home-region"]."region-name"' --output json
```

### C. Plan (read-only)

```bash
export OCI_CLI_REGION=eu-frankfurt-1
./provision-e2-micro.sh plan
```

### D. Apply (only after plan looks correct)

```bash
# Cloud Shell Network menu → Public Network, then:
export SSH_ALLOWED_CIDR="$(curl -4 -s https://api.ipify.org)/32"
./provision-e2-micro.sh apply
```

### E. Status / cleanup

```bash
./provision-e2-micro.sh status
./provision-e2-micro.sh cleanup
```

## Static / offline checks (workstation)

```bash
bash -n scripts/oracle-cloud-shell/provision-e2-micro.sh
bash -n scripts/oracle-cloud-shell/tenancy-discovery.inc.sh
bash scripts/oracle-cloud-shell/test-tenancy-discovery.sh
```

These do **not** prove live Cloud Shell authentication.
