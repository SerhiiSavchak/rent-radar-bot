# Recovery status

Updated: 2026-09-16T12:00+03:00  
Branch: `cursor/phase-1-source-layer-closure-8797`

## Verified git state

| Item | Value |
|------|-------|
| Local HEAD (pre-commit of this pass) | `eca65c5` matched `origin/...` after fetch; `git push` → Everything up-to-date |
| Working tree | dirty with CPU attribution + RIELTOR owner-filter default |

## Step progress

- [x] Step 1 — save / verify remote (`eca65c5` on origin)
- [x] Step 2 — CPU attribution → `evidence/phase-1/cloudflare-cpu-attribution.md`
- [x] Step 3 — no credible Free-CPU optimization; no redeploy
- [x] Step 4 — redeploy skipped (evidence sufficient)
- [x] Step 5 — RIELTOR: owner filter `declared=3` / houses empty / truncated=false live
- [x] Step 6 — Verdict **B** (reject Workers Free for poller CPU)

## Temporary resources

| Resource | Status |
|----------|--------|
| Hosted probe Worker | already deleted (prior session); not redeployed |
| Stuck push | completed successfully (`Everything up-to-date`) |

## Next exact action

Commit + push this decision pass; then operator starts Oracle E2.1.Micro OLX smoke task (not this session).
