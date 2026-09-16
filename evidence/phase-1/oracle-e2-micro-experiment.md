# Oracle Always Free E2.1.Micro — OLX experiment pack

Date prepared: 2026-09-16  
Branch / intended commit: `cursor/phase-1-source-layer-closure-8797` @ `d3891ed` or later tip  
Status: **Cloud Shell provisioner ready; VM not created by the agent.**  
Use `scripts/oracle-cloud-shell/provision-e2-micro.sh` in Oracle Cloud Shell (`plan` then `apply`).

This is a **hosting feasibility** experiment (real `OlxSource` over ordinary HTTP). Not a production deploy. No browser, proxies, CAPTCHA bypass, Telegram, or database work.

## Access check (this workstation)

| Check | Result |
|-------|--------|
| `oci` CLI | **not installed** |
| `~/.oci` / `OCI_*` env | **absent** |
| SSH config / known Oracle hosts | **none found** |
| Cloudflare Workers login | irrelevant; does not imply Oracle access |

## Official Always Free facts (checked 2026-09-16)

Sources:

- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://www.oracle.com/cloud/free/

| Item | Always Free rule |
|------|------------------|
| Shape | Up to **two** `VM.Standard.E2.1.Micro` (AMD), home region only |
| CPU / RAM | 1/8 OCPU (burstable), **1 GB** RAM |
| Network | 1 VNIC, **public IP** optional, up to **50 Mbps** internet |
| Boot + block | **200 GB** total Always Free Block Volume in **home region**; default boot ~**50 GB** |
| Images | Linux images labeled **Always Free Eligible** (Ubuntu / Oracle Linux / CentOS) |
| Egress | Documented Always Free outbound allowance is large relative to this probe (see OCI Free Tier / networking docs; prior notes used 10 TB/month class figures for Free networking — treat VM traffic within Always Free networking limits and avoid paid NAT/gateways) |
| Idle reclaim | May reclaim if 7-day 95th CPU **and** network **both** &lt; 20% (memory rule is A1-only) |
| Capacity | `"out of host capacity"` is common; retry AD / wait — **do not** upgrade to paid solely to get capacity unless the operator explicitly accepts PAYG risk |
| Signup | Free Tier account; **credit/debit card** used for identity (authorization hold; not a charge for Always Free usage while tenancy stays within Always Free limits) |
| Trial credits | Optional $300 / 30 days on top; Always Free continues after trial if account remains eligible |

**Do not attach** Autonomous DB, load balancers, extra paid volumes, or non–Always Free images for this experiment.

## ONE proposed VM configuration (request authorization before create)

| Field | Value |
|-------|--------|
| Purpose | Temporary Phase 1 OLX HTTP probe |
| Region | Tenancy **home region** only |
| Shape | `VM.Standard.E2.1.Micro` |
| Image | Canonical **Ubuntu 22.04** (Always Free Eligible) — or Oracle Linux Always Free Eligible |
| Boot volume | **50 GB** (default; counts toward 200 GB Always Free pool) |
| Networking | New or existing Always Free VCN + **public subnet**; assign **ephemeral public IPv4** |
| Ingress | SSH **22** from operator IP only |
| Egress | Default (HTTPS 443 to internet) |
| Extra volumes / LB / DB | **None** |
| Account posture | Stay on Free Tier / Always Free; **do not** enable paid upgrades for this test |

Estimated Always Free consumption if authorized: 1 Micro instance + 50 GB boot ≈ within 2 Micros / 200 GB caps.

## Runtime requirements

| Item | Requirement |
|------|-------------|
| OS | Ubuntu 22.04 (or other Always Free Linux) |
| Node | **22.13+** (repo `.nvmrc` = `22.13.0`; `engines.node >=22.13.0`) |
| Install | `npm ci` (lockfile) |
| Secrets | No OLX API key. Optional `.env` copy of `.env.example` with `ENABLE_OLX` irrelevant for this script |
| Browser / Chromium | **Not installed** |
| DB | **Not used** |

## Minimal reproducible procedure (on the VM)

```bash
# 1) System
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # expect v22.x

# 2) Checkout (use the commit that contains this experiment pack)
git clone https://github.com/SerhiiSavchak/rent-radar-bot.git
cd rent-radar-bot
git fetch origin
git checkout cursor/phase-1-source-layer-closure-8797
git rev-parse HEAD   # record in evidence

# 3) Dependencies
npm ci

# 4) Single OLX cycle (apartments + houses separately, JSON evidence)
mkdir -p evidence/phase-1/oracle-olx
OLX_EXPERIMENT_CYCLES=1 OLX_EXPERIMENT_OUT_DIR=evidence/phase-1/oracle-olx \
  npm run live:olx:experiment

# 5) If BOTH categories success=true, run two more ~10 minutes apart (same process):
OLX_EXPERIMENT_CYCLES=3 OLX_EXPERIMENT_INTERVAL_MS=600000 \
  OLX_EXPERIMENT_OUT_DIR=evidence/phase-1/oracle-olx \
  npm run live:olx:experiment

# 6) Optional one four-source cycle (only after OLX PASS); honest truncation/partials:
npm run live:all

# 7) Cleanup temporary processes (no cron/systemd installed by this pack)
#    Do not delete the VM unless the operator asks.
```

Alternate one-shot (combined categories, less detailed): `npm run live:olx`.

## Success criteria (do **not** treat bare HTTP 200 as PASS)

Per category (`apartments` / `houses`):

- `resultKind === "ok"`
- `extracted > 0`
- `blocked === false`
- `contentType` includes JSON when status 200
- cities / sample IDs present (Lviv or ~15 km suburbs expected)
- `valid_empty` ≠ success for this market probe
- `parser_failure` / `http_error` / 403 / 429 = FAIL; **stop** blocked routes

Three successful cycles ⇒ **preliminary** hosted OLX access only (not multi-day soak).

## Evidence outputs

Written under `evidence/phase-1/oracle-olx/cycle-N.json`:

- HTTP status, resultKind, blocked, elapsedMs
- sellerTypes / private-account evidence counts
- cities, propertyTypes, sampleIds (non-sensitive)
- rss / heap snapshots

After the run, copy those files into the git repo on a machine with push access (or commit from the VM if configured).

## Cleanup

- Kill any leftover `npm run live:olx:experiment` / sleep loops
- Do **not** install persistent cron for this Phase 1 probe unless a later soak task asks
- Do **not** delete a pre-existing VM without operator approval

## Execution status

| Step | Status |
|------|--------|
| Procedure + proposed VM | **DONE** (this file) |
| Script `npm run live:olx:experiment` | **DONE** (in repo) |
| Account / VM | **DONE** (operator Always Free Micro) |
| Hosted OLX on Oracle (cycle 1) | **FAIL** — API 403 CloudFront; see `oracle-olx/oracle-cycle-1-review.md` |
| Browser transport | **Unproven** |
