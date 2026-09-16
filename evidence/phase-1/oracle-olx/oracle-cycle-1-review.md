# Oracle Always Free OLX — cycle 1 review

Date of review: 2026-09-17  
Branch: `cursor/phase-1-source-layer-closure-8797`  
Command on VM: `npm run live:olx:experiment` (bounded to cycle 1)

## Workspace note

At review time, raw `evidence/phase-1/oracle-olx/cycle-1.json` was **not present** in this git workspace (operator ran the experiment on the VM). Facts below are from the operator’s report of that run. Paste/commit the VM `cycle-1.json` when available; do not invent status fields.

## Operator-reported facts (VM)

| Item | Value |
|------|--------|
| Shape | `VM.Standard.E2.1.Micro` |
| OS / runtime | Ubuntu, Node **22.23.2**, x64 |
| Process start | OK |
| `api/v1/offers` (apartments + houses) | HTTP **403**, `content-type: text/html`, CloudFront |
| HTML fallback | HTTP **200**, no parseable listing payload |
| Experiment stop | Stopped after cycle 1 (no further hammering) |

## Classification (verified in code)

| Observation | Expected experiment outcome |
|-------------|----------------------------|
| API 403 CloudFront HTML | `failureReason=transport_blocked`, `blocked=true`, `success=false` |
| HTML 200 without supported listing JSON | adapter / notes path = not success; alone → `parser_failure` |
| HTML 200 must not count as hosted OLX PASS | enforced (`classifyOlxExperimentCategory` + success criteria) |

When API is 403 and HTML is 200, **transport_blocked wins** for the experiment failure reason (API block is the decisive signal). HTML 200 is diagnostic only and is not successful OLX API access.

## Diagnostic bug found in repo (independent of missing JSON)

Houses-only HTML fallback previously always requested the **apartments** catalog URL  
`.../kvartiry/dolgosrochnaya-arenda-kvartir/lvov/`.  
Fixed: houses-only uses `.../doma/arenda-domov/lvov/` via `selectOlxHtmlFallbackUrl`.

Also: reported `httpStatus` no longer prefers HTML 200 over API 403.

## Comparison (facts only)

| Environment | OLX `api/v1/offers` | Notes |
|-------------|---------------------|--------|
| Cloudflare Workers (2026-09-15) | **PASS** JSON 200, listings | See `cloudflare-hosted-live-olx-cycle{1,2,3}.json` |
| Local workstation | **FAIL** 403 CloudFront | `evidence/phase-1/olx-http.md` |
| Oracle Always Free Micro (cycle 1) | **FAIL** 403 CloudFront | This review |
| Browser transport | **Unproven** | Not attempted |

## Verdict

- Oracle ordinary HTTP transport for OLX: **FAIL**
- Browser transport: still **unproven**
- No bypass / proxies / IP rotation attempted or recommended in this review
