# Recovery status

Updated: 2026-09-17T01:30+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`

## Current task

Oracle **soak harness** ready (`npm run live:oracle:soak`). Browser OLX preliminary PASS (3 cycles). Soak **NOT TESTED**.

## Next exact console action (VM)

```bash
SOAK_CYCLES=12 \
SOAK_INTERVAL_MS=600000 \
SOAK_OUT_DIR=evidence/phase-1/oracle-soak \
npm run live:oracle:soak
```
