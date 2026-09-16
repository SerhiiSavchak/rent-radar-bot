# Recovery status

Updated: 2026-09-16T23:45+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`

## Current task

Oracle Always Free Micro via **Cloud Shell provisioner**. SSH CIDR: explicit env wins over `state.env`; host `/32` only.

| Step | Status |
|------|--------|
| Provisioner + helpers | **READY** (offline `bash -n` + CIDR/FIPS/tenancy tests) |
| Instructions | `scripts/oracle-cloud-shell/README.md` |
| VM created by agent | **NO** — awaiting your Cloud Shell `plan` → `apply` |
| Hosted OLX on Oracle | **NOT TESTED** |

## Next exact console action

Upload **four** files into `~/rent-radar-phase1-oracle/`: `provision-e2-micro.sh`, `tenancy-discovery.inc.sh`, `ssh-key-fips.inc.sh`, `ssh-cidr.inc.sh`. Verify CIDR with plan (no apply yet):

```bash
cd ~/rent-radar-phase1-oracle && chmod +x provision-e2-micro.sh && export OCI_CLI_REGION=eu-frankfurt-1 && SSH_ALLOWED_CIDR="37.55.172.239/32" ./provision-e2-micro.sh plan
```

Expect: `SSH_ALLOWED_CIDR effective=37.55.172.239/32 source=environment`
