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

### OLX (query + parser, second pass later on 2026-09-15)

- Search ids corrected and regression-tested (`tests/olx-parser.test.ts`): region **5**,
  city **176**, categories **1760/330**, `distance=15`. The old ids silently searched
  Краснодон and «Продаж квартир».
- Coordinates are now read from `map.{lat,lon}` (where the real API puts them) with the
  approximation `radius` preserved in metadata; the old code read `location.lat/lon`, which
  does not exist in real payloads, so live records would have lost coordinates entirely.
- `publishedAt` now uses `created_time`; `last_refresh_time` is kept separately so bumped old
  listings are not mistaken for new ones.
- `extractOlxUrlToken` added for exact identity matching by URL token **string** (numeric
  base62 decoding of the token was disproven on a live counterexample).

### LUN

`inspectLunHtml` distinguishes:

- `parser_failure`: HTTP 200 without `realties.cards`  
- `valid_empty`: marker present, zero cards  
- `ok`: cards parsed  

Zero listings with a broken page is no longer reported as a quiet empty market.

## OLX access (updated later on 2026-09-15)

- **This workstation (Windows Node HTTP):** apartments JSON **403** CloudFront, HTML **403**;
  retested with corrected query params — still **403**. The block is per-environment.
- **Second environment (isolated fetch server, ordinary HTTP, no bypass): TESTED and WORKING.**
  `api/v1/offers` returned **200 with real Lviv listings** (`total_elements=1000` apartments,
  80 houses within 15 km), fresh records created the same evening. Identical queries ~10 min
  apart returned live shifted windows (distinct `search_id`s, no shared cache). See
  `evidence/phase-1/olx-http.md`.
- **Root cause of the old “houses 200 empty”:** the hardcoded query ids were wrong —
  `region_id=12&city_id=13` is **Краснодон (Луганська обл.)** and `category_id=1758` is
  **«Продаж квартир»**. Corrected and regression-tested: region 5 (Львівська), city 176
  (Львів), categories **1760** (оренда квартир) / **330** (оренда будинків), `distance=15`
  for the ~15 km radius (suburbs have their own city ids).
- Multi-day stability and a fresh-process soak from a runtime we control: **still not done**.
- Browser baseline for LUN∩OLX matching: **NOT TESTED** (no browser stack in repo); a direct
  OLX HTTP baseline was used instead.

LUN∩OLX (2026-09-15, same observation window, matched by URL token string): LUN flats first
page had 19 olx.ua originals; **3 of 19** appeared in a 52-record direct OLX created_at
window (~17:05–21:30). The unfiltered OLX feed moves ~50 listings per 4.5 h while LUN's
owner-filtered first page spans days — a first-page LUN scan cannot replace direct 10-minute
OLX polling without deeper pagination. Partial overlap remains **not** complete OLX coverage;
“OLX via LUN only” stays a **scope change**. See `evidence/phase-1/lun-origins.md`.

## RIELTOR

No adapter. LUN may surface `rieltor.ua` original URLs. Pagination/truncation detection for a dedicated RIELTOR client is **unimplemented**. Do not treat a LUN first page as a complete RIELTOR scan.

## Runtime alternatives (docs only, not provisioned)

Compared from official docs, not from a live VM:

**A. Direct OLX HTTP** — **works via ordinary HTTP from at least one non-residential
environment** (verified 2026-09-15 with real records, correct geo/category params, and a
10-minute repeat). Fails with 403 from this workstation. Whether a specific zero-cost host
is in the unblocked set is the remaining question — no browser requirement demonstrated so far.

**B. Indirect OLX via LUN** — HTTP HTML already works here; coverage incomplete (3/19 token
matches against a same-evening direct window; first-page cadence too slow versus ~50 OLX
listings per 4.5 h); unofficial RSC; timestamps are ingest times.

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
2. ~~No second environment for OLX HTTP~~ → **resolved for feasibility** (ordinary HTTP works
   from a non-residential environment); still open: proving a specific zero-cost host is
   unblocked and stable over days.  
3. No in-repo Chromium/Xvfb evidence — and, per item 2, a browser may not be needed at all.  
4. No RIELTOR adapter / pagination contract.  
5. LUN RSC is unofficial.  
6. DIM.RIA official API still needs a key; HTML fallback is not long-term.  
7. Continuous monitor / seed / Telegram production path not closed (and Telegram must not be sent in this task).

## Recommended next action (one)

**Provision nothing yet.** Ordinary OLX HTTP is now proven feasible outside this workstation,
so the browser-for-OLX spike is **deprioritized**. The single next step is: obtain account
access to one candidate zero-cost host (Oracle Always Free A1 preferred over GCP `e2-micro`,
which is irrelevant now that Chromium RAM is not required — even a 1 GB micro may suffice for
plain HTTP), and run **only** `npm run live:olx` (now with corrected Lviv/category ids) from
that host at ~10-minute intervals for a bounded soak. If that host is 403-blocked, record it
and try the other free tier; do **not** add stealth/proxies.

Phase 1 source layer is **not** marked complete.
