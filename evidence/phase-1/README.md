# Phase 1 evidence index

Created: 2026-09-15 on branch `cursor/phase-1-source-layer-closure-8797`.

| File | What it records |
|------|-----------------|
| `inventory.md` | Claim vs git evidence |
| `olx-http.md` | Bounded ordinary HTTP probes (this environment) |
| `lun-origins.md` | LUN original URL host census |
| `rieltor.md` | RIELTOR routes, owner filter, truncation |
| `hosting.md` | Earlier browser-era Oracle vs GCP notes |
| `http-runtime.md` | HTTP-only runtime research (Deno / CF / Oracle / GCP) |
| `cloudflare-workers.md` | Isolated Workers probe: compatibility, bundle dry-run, local fixtures/OLX |
| `cloudflare-cpu-attribution.md` | Platform cpuTime per hosted invocation |
| `oracle-e2-micro-experiment.md` | Always Free E2.1.Micro proposed config + OLX HTTP experiment procedure |
| `oracle-olx/` | Cycle JSON / review from `npm run live:olx:experiment` |
| `oracle-olx-browser/` | Cycle JSON from `npm run live:olx:browser-experiment` (stock Chromium) |
| `oracle-soak/` | Unattended multi-source soak + `REVIEW.md` |
| `oracle-olx-browser/` | Stock Chromium page-access cycles (not deliverable parse) |
| `../docs/PHASE_1_DECISION.md` | Decision and remaining blockers |

Commands used for quality:

```
npm run typecheck
npm run lint
npm test
npm run live:olx
npm run research:lun-origins
```

No Telegram messages were sent. No cloud resources were provisioned.
