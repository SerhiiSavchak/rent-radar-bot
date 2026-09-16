# Recovery status

Updated: 2026-09-16T16:20+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`

## Current task

Oracle Always Free Micro via **Cloud Shell provisioner** (not manual console form).

| Step | Status |
|------|--------|
| Script `scripts/oracle-cloud-shell/provision-e2-micro.sh` | **READY** (`bash -n` OK) |
| Instructions | `scripts/oracle-cloud-shell/README.md` |
| VM created by agent | **NO** — awaiting your Cloud Shell `plan` → `apply` |
| Hosted OLX on Oracle | **NOT TESTED** |

## Next exact console action

Upload **both** `provision-e2-micro.sh` and `tenancy-discovery.inc.sh` into `~/rent-radar-phase1-oracle/`, then:

```bash
cd ~/rent-radar-phase1-oracle && chmod +x provision-e2-micro.sh && export OCI_CLI_REGION=eu-frankfurt-1 && ./provision-e2-micro.sh plan
```
