# Recovery status

Updated: 2026-09-17T00:25+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`

## Current task

Oracle OLX **browser** probe prepared (`npm run live:olx:browser-experiment`). Not executed from this agent. Oracle HTTP remains FAIL; browser transport **NOT TESTED**.

| Step | Status |
|------|--------|
| Oracle Micro HTTP OLX | **FAIL** (403 CloudFront) |
| Browser probe in repo | **READY** |
| Browser probe on Oracle IP | **NOT TESTED** |

## Next exact console action (on VM `92.5.160.179`)

```bash
cd ~/rent-radar-bot && git pull && npm ci
npx playwright install --with-deps chromium
OLX_BROWSER_OUT_DIR=evidence/phase-1/oracle-olx-browser npm run live:olx:browser-experiment
```
