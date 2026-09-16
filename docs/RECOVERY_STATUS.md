# Recovery status

Updated: 2026-09-16T12:00+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`  
HEAD: `d5d54b4` (= `origin/cursor/phase-1-source-layer-closure-8797`)

## Verified git state

Local and remote match after push of the CPU-decision commit.

## Completed this task

- [x] Push verification (`eca65c5` was already on origin; new commit `d5d54b4` pushed)
- [x] CPU attribution table → `evidence/phase-1/cloudflare-cpu-attribution.md`
- [x] No Free-CPU optimization; redeploy skipped
- [x] RIELTOR owner-filter live: apt declared=3 complete; houses valid_empty
- [x] Verdict **B** — reject Workers Free for poller CPU
- [x] `preferOwners` defaults from `OWNER_ONLY`

## Temporary resources

| Resource | Status |
|----------|--------|
| Hosted probe Worker | deleted earlier; not redeployed |

## Next exact action

Explicit task: provision Oracle Always Free `VM.Standard.E2.1.Micro` and run `npm run live:olx` only (no proxies). See `docs/PHASE_1_DECISION.md`.
