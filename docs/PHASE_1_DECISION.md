# Phase 1 decision (source layer)

Date: 2026-09-15  
Branch: `cursor/phase-1-source-layer-closure-8797`  
Repo: `rent-radar-bot` at `origin` GitHub `SerhiiSavchak/rent-radar-bot`  
HEAD at recovery: `main` / `0bf0abb` (“add project architecture”)

This document records what is **in this repository**, what was **claimed elsewhere**, and what was **changed in this recovery**. Phase 1 is **not complete**.

## Inventory of reported claims

| Claim | Repository evidence | Verdict |
|-------|---------------------|---------|
| Branch `cursor/phase-1-source-layer-closure-8797` already existed | Only `main` / `origin/main` existed before this recovery | **Missing** (created now) |
| `evidence/phase-1/` | Absent before this commit | **Missing** (added) |
| `docs/PHASE_1_DECISION.md` | Absent before this commit | **Missing** (this file) |
| `AGENTS.md` | Not present | **Missing** |
| 103 tests | After this branch: 6 Vitest files, **22 tests** (`npm test`) | **Contradicted** |
| `runtime:olx` / headed Chromium + Xvfb | No Playwright/Chromium dependency, no Xvfb scripts | **Missing / unverified** |
| RIELTOR adapter + two-request owner-only cycle | No `src/sources/rieltor/`; LUN stores `urlRaw` which may point at rieltor.ua | **Missing adapter**; original URLs **verified in LUN parser** |
| DIM.RIA characteristic 1437 | `domria.parser.ts` + `DOMRIA_OFFER_TYPE` | **Verified**, then **corrected** (see below) |
| `agency_id` / `is_commercial` unreliable | Parser previously treated `agency_id > 0` as agent | **Verified as a bug**, **fixed** |
| LUN original source URLs | `metadata.originalUrl` from `card.urlRaw` | **Verified** |
| VALID_EMPTY vs PARSER_FAILURE | Types existed in `domain/source.ts`; LUN `inspectLatest` treated 0 listings as unhealthy | **Partially present**, **wired in LUN adapter** |
| Hosted autonomous zero-cost execution | No Dockerfile/deploy evidence, no soak logs | **Not demonstrated** |
| OLX CloudFront 403 on ordinary HTTP | `docs/SOURCE_RESEARCH.md` (2026-09-13) | **Verified as prior local result**; retested 2026-09-15 |
| OLX Partner API is advertiser-scoped | Documented, not implemented as search | **Unchanged** |
| Duplicate-pair research / false positives | No duplicate-pair evidence files | **Missing** |

## Critical source corrections made here

### DIM.RIA

Ownership is classified **only** from documented `characteristics_values["1437"]`:

- `1436` → owner  
- `1434` / `1435` → agent  
- `1473` / `1506` → business  
- missing or any other value → **unknown**

`agency_id` is recorded as evidence only. It no longer forces `sellerType=agent`.

### OLX (parser only)

`business: false` is preserved as **private-account evidence**. It is **not** treated as property ownership.

### LUN

`inspectLunHtml` distinguishes:

- `parser_failure`: HTTP 200 without `realties.cards`  
- `valid_empty`: marker present, zero cards  
- `ok`: cards parsed  

Zero listings with a broken page is no longer reported as a quiet empty market.

## OLX access

- **This environment (Windows Node HTTP, 2026-09-15):** `npm run live:olx` → apartments JSON **403** CloudFront, houses JSON **200 empty `data:[]`**, HTML **403**. `resultKind=http_error`. See `evidence/phase-1/olx-http.md`.  
- **Second environment (cloud / residential / Xvfb):** **NOT TESTED** — no other runtime is available in this workspace.  
- 10-minute repeat / fresh-process validation of a successful HTTP route: **not applicable** while HTTP remains blocked or empty.  
- Browser baseline for LUN∩OLX matching: **NOT TESTED** (no browser stack in repo).

LUN first-page sample 2026-09-15 (`npm run research:lun-origins`): 24 cards, **22 original hosts `olx.ua`**, 2 `dom.ria.com`, 0 `rieltor.ua`. That is **partial overlap**, not complete OLX coverage. Switching the product to “OLX via LUN only” would be a **scope change**, not an approved replacement. See `evidence/phase-1/lun-origins.md`.

## RIELTOR

No adapter. LUN may surface `rieltor.ua` original URLs. Pagination/truncation detection for a dedicated RIELTOR client is **unimplemented**. Do not treat a LUN first page as a complete RIELTOR scan.

## Runtime alternatives (docs only, not provisioned)

Compared from official docs, not from a live VM:

**A. Direct OLX HTTP** — cheapest if it works; currently fails or is empty in this environment.

**B. Indirect OLX via LUN** — HTTP HTML already works here; coverage incomplete; unofficial RSC; timestamps are ingest times.

**C. One shared Node runtime, browser only for OLX**

| | Oracle Always Free | Google Cloud Free Tier |
|--|--------------------|-------------------------|
| Compute | Always Free: up to 2× `VM.Standard.E2.1.Micro` (AMD, **1 GB**) and/or Ampere A1 Flex **2 OCPU / 12 GB** (1,500 OCPU-hours + 9,000 GB-hours/month) | 1 non-preemptible **`e2-micro`** / month in `us-west1`, `us-central1`, or `us-east1`; 30 GB-months standard PD |
| Chromium | **1 GB micros are a poor fit**. A1 12 GB is the plausible Always Free shape. Docs: **out of host capacity**; idle reclaim if 7-day 95th CPU, net, and (A1) mem all &lt; 20%. | `e2-micro` is **~1 GB RAM** — headed Chromium is unlikely to be reliable. Trial **$300 / 90 days is not Always Free**. Card required at signup. Over Free Tier on a **paid** account is billed. |
| 144 cycles/day | CPU is not the documented quota issue; idle reclaim, home-region capacity, and IP are. Official Always Free outbound: **10 TB/month**. | Chromium + 144 navigations/day will likely exceed Free Tier **1 GB/month** egress and RAM. |
| Spend control | Upgrade expands shapes; Always Free stays unlabeled-free; **usage above limits is charged**. Compartment quotas exist. | Free Trial auto-closes without upgrade; remaining credit is not a permanent host. |
| Unattended | Cron/systemd possible; **not demonstrated**. | Same. |

Official sources: [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Google Cloud Free Program](https://docs.cloud.google.com/free/docs/free-cloud-features). Details in `evidence/phase-1/hosting.md`.

Trial credits ≠ permanent zero-cost. Free compute ≠ a proven free **complete** deployment (disk, IP, DNS, egress, OLX traffic).

## Remaining Phase 1 blockers

1. No hosted unattended zero-cost soak.  
2. No second environment for OLX HTTP.  
3. No in-repo Chromium/Xvfb evidence.  
4. No RIELTOR adapter / pagination contract.  
5. LUN RSC is unofficial.  
6. DIM.RIA official API still needs a key; HTML fallback is not long-term.  
7. Continuous monitor / seed / Telegram production path not closed (and Telegram must not be sent in this task).

## Recommended next action (one)

**Provision nothing yet.** If OLX independence remains required, the smallest evidence step is: obtain **account access** to one Always Free **Ampere A1 (12 GB)** VM (or any existing non-datacenter host the operator already has), then run **only** the existing `npm run live:olx` ordinary HTTP probe from that host. If HTTP still 403, record it; do **not** add stealth/proxies. Only then decide whether a browser-for-OLX spike is even in scope.

Phase 1 source layer is **not** marked complete.
