# Recovery status

Updated: 2026-09-16T15:18+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`  
HEAD: `c9c59eb` (= `origin/...`; reported `d3891ed` is superseded)

## Current task

Oracle Always Free `VM.Standard.E2.1.Micro` OLX HTTP feasibility.

| Step | Status |
|------|--------|
| Repo / push | **OK** — no second push needed |
| OCI CLI / `~/.oci` / authorized VM | **MISSING** (rechecked) |
| Procedure + proposed free VM | **READY** — `evidence/phase-1/oracle-e2-micro-experiment.md` |
| `npm run live:olx:experiment` | **READY** in repo |
| Hosted Oracle OLX cycles | **NOT TESTED** |

## Temporary resources

None. No VM provisioned.

## Next exact action (operator)

Open https://www.oracle.com/cloud/free/ and create/confirm an Oracle Cloud Free Tier account (card for identity verification only). Then reply authorizing the Always Free `VM.Standard.E2.1.Micro` config in `oracle-e2-micro-experiment.md`, or provide SSH to an existing idle Micro.
