# Recovery status

Updated: 2026-09-16T23:30+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`

## Current task

Oracle Always Free Micro via **Cloud Shell provisioner** (not manual console form). FIPS fix: RSA-3072 SSH keys; `plan` never generates keys.

| Step | Status |
|------|--------|
| Script `scripts/oracle-cloud-shell/provision-e2-micro.sh` + `ssh-key-fips.inc.sh` | **READY** (offline `bash -n` + unit tests OK; not live FIPS-verified here) |
| Instructions | `scripts/oracle-cloud-shell/README.md` |
| VM created by agent | **NO** — awaiting your Cloud Shell `plan` → `apply` |
| Hosted OLX on Oracle | **NOT TESTED** |

## Next exact console action

Upload **three** files into `~/rent-radar-phase1-oracle/`: `provision-e2-micro.sh`, `tenancy-discovery.inc.sh`, `ssh-key-fips.inc.sh`. Move aside any failed ed25519 leftovers under `ssh/`, then:

```bash
cd ~/rent-radar-phase1-oracle && chmod +x provision-e2-micro.sh && export OCI_CLI_REGION=eu-frankfurt-1 && ./provision-e2-micro.sh plan
```
