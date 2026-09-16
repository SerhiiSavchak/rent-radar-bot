# Recovery status

Updated: 2026-09-17T00:15+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`

## Current task

Oracle Always Free OLX cycle 1 **reviewed**: ordinary HTTP **FAIL** (403 CloudFront). Classification + houses HTML URL diagnostics fixed in repo. No further live OLX cycles in this pass.

| Step | Status |
|------|--------|
| Oracle Micro provisioned / experiment run | **DONE** (operator) |
| HTTP transport on Oracle | **FAIL** |
| Browser transport | **Unproven** |
| Decision doc | `docs/PHASE_1_DECISION.md` |
| Review note | `evidence/phase-1/oracle-olx/oracle-cycle-1-review.md` |

## Next exact action

Copy VM `cycle-1.json` into `evidence/phase-1/oracle-olx/` and commit it if not already present. Do not start another live OLX cycle until that archive step is done.
