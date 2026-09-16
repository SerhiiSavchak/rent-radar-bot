# Recovery status

Updated: 2026-09-16T14:55+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`  
Baseline HEAD verified: `d3891ed` (then experiment-pack commit)

## Current task

Oracle Always Free `VM.Standard.E2.1.Micro` OLX feasibility experiment.

| Step | Status |
|------|--------|
| Access check (oci / ~/.oci / VM) | **MISSING** on this workstation |
| Experiment procedure + proposed VM | **DONE** → `evidence/phase-1/oracle-e2-micro-experiment.md` |
| Script `npm run live:olx:experiment` | **DONE** (local smoke: both categories transport_blocked, as expected) |
| Hosted Oracle execution | **NOT STARTED** (no authorized VM) |

## Temporary resources

None provisioned. No Oracle VM created.

## Next exact action (operator)

1. Create or confirm Oracle Cloud **Free Tier** account: https://www.oracle.com/cloud/free/  
2. Reply authorizing creation of the proposed Always Free E2.1.Micro (see experiment doc), **or** provide SSH to an existing unused Micro in the home region.
