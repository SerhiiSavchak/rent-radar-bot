# Oracle Cloud Shell — Always Free E2.1.Micro provisioner

Script: `provision-e2-micro.sh`  
Companion OLX test (on the VM later): `npm run live:olx:experiment`  
Docs: `evidence/phase-1/oracle-e2-micro-experiment.md`

**This agent has not executed the script in your tenancy.** Resources are created only when you run `apply` in Cloud Shell.

## Free-tier assumptions (verified against official Always Free docs)

| Resource | Why free / allowed |
|----------|-------------------|
| `VM.Standard.E2.1.Micro` | Always Free (up to 2), **home region only**; Micro only in **one** AD |
| 50 GB boot | Within **200 GB** Always Free Block Volume |
| VCN + IGW + subnet + RT + SL + NSG | Free Tier networking |
| Ephemeral public IPv4 | Needed for **outbound HTTPS** without a **NAT Gateway** (NAT is **not** Always Free) |
| Bastion | Always Free, but **not** auto-created here (extra moving parts) |

**Not created:** NAT GW, load balancer, Autonomous DB, paid shapes, world-open SSH (`0.0.0.0/0`), IAM policy changes, billing upgrades.

## Restricted SSH method

1. Instance gets a public IP (egress via Internet Gateway).
2. Subnet uses a **custom security list with no ingress** (so the default SL cannot leave SSH open to the world).
3. **NSG** allows TCP/22 **only** from `SSH_ALLOWED_CIDR` (your `/32`).
4. You set that CIDR to your home IP **or** Cloud Shell’s egress IP after enabling **Public Network** in the Cloud Shell Network menu (`curl -4 -s https://api.ipify.org`).

Cloud Shell default **OCI Service Network** can run `oci` against the control plane but cannot reach public internet/GitHub until Public Network is enabled (IAM permitting).

## Exact Cloud Shell steps (upload → plan → apply)

### A. Upload (preferred — no private-repo URL)

1. Open OCI Console → **Cloud Shell** (region `eu-frankfurt-1` / home).
2. Gear / upload → upload **only** `provision-e2-micro.sh` from this folder (or a zip containing it).
3. In Cloud Shell:

```bash
mkdir -p ~/rent-radar-phase1-oracle
# if uploaded to home:
mv ~/provision-e2-micro.sh ~/rent-radar-phase1-oracle/ 2>/dev/null || true
chmod +x ~/rent-radar-phase1-oracle/provision-e2-micro.sh
cd ~/rent-radar-phase1-oracle
```

### B. Plan (read-only discovery)

```bash
export OCI_CLI_REGION=eu-frankfurt-1   # must be home region
./provision-e2-micro.sh plan
```

Confirm it selected an AD ending in `AD-3` (full name is tenancy-specific), shape `VM.Standard.E2.1.Micro`, and a Ubuntu/Oracle Linux image.

### C. Apply (creates ONE Micro)

```bash
# Enable Cloud Shell "Public Network", then:
export SSH_ALLOWED_CIDR="$(curl -4 -s https://api.ipify.org)/32"
echo "SSH allowlist will be: $SSH_ALLOWED_CIDR"
./provision-e2-micro.sh apply
```

On **Out of host capacity**, the script stops, keeps partial network state, and does **not** offer paid shapes. Retry `apply` later or run `./provision-e2-micro.sh cleanup`.

### D. Status / cleanup (script-created only)

```bash
./provision-e2-micro.sh status
./provision-e2-micro.sh cleanup   # only IDs in ~/rent-radar-phase1-oracle/state.env
```

## Project transfer + access (after apply)

Private repo: **do not** paste tokens into Cloud Shell history.

1. On your PC: zip the repo at commit `79760a4` or newer tip of `cursor/phase-1-source-layer-closure-8797` (exclude `.env` if it has Telegram secrets).
2. Upload the zip via Cloud Shell UI.
3. From Cloud Shell (Public Network + allowlisted IP):

```bash
source ~/rent-radar-phase1-oracle/state.env
scp -i ~/rent-radar-phase1-oracle/ssh/rrb-p1 \
  ~/rent-radar-bot.zip ${SSH_USER}@${PUBLIC_IP}:~/
ssh -i ~/rent-radar-phase1-oracle/ssh/rrb-p1 ${SSH_USER}@${PUBLIC_IP}
```

4. On the VM: install Node 22, `npm ci`, then:

```bash
OLX_EXPERIMENT_CYCLES=1 npm run live:olx:experiment
# if both categories success=true:
OLX_EXPERIMENT_CYCLES=3 OLX_EXPERIMENT_INTERVAL_MS=600000 npm run live:olx:experiment
npm run live:all   # one bounded four-source cycle after OLX PASS
```

Do not install a browser, database, Telegram, or cron for this probe.

## Static checks (workstation)

```bash
bash -n scripts/oracle-cloud-shell/provision-e2-micro.sh
```
