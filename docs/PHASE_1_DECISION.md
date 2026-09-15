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
| RIELTOR adapter + two-request owner-only cycle | `src/sources/rieltor/` added 2026-09-15; `f-owners=1` verified as a filter, not a two-request API | **Adapter present**; earlier “two-request cycle” **not** reproduced |
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

Adapter added 2026-09-15 (`src/sources/rieltor/`). Live routes `/lvov/flats-rent/` and `/lvov/houses-rent/` resolve to Lviv (not a fallback city). Houses H1 is long-term rental. Platform labels `Власник` / `Рієлтор` come from catalog cards; `f-owners=1` is a real filter **only** on `data-listing-items` (recommended “поруч” cards must be ignored). Owner houses around Lviv were a **valid empty** catalog in this sample. First-page apartment count 743 ⇒ truncated unless paginated; the adapter caps pages and records `TRUNCATED`. See `evidence/phase-1/rieltor.md`.

## Runtime alternatives (docs only, not provisioned)

Browser-for-OLX is **deprioritized**: ordinary HTTP worked from an isolated fetch server
(Cursor WebFetch), which is **not** a production host. HTTP-only comparison is in
`evidence/phase-1/http-runtime.md`.

**A. Direct OLX HTTP** — works from at least one non-residential environment; 403 from this
workstation. Hosted zero-cost IP: **NOT TESTED**.

**B. Indirect OLX via LUN** — incomplete coverage (3/19 token matches); not a replacement.

**C. Shared HTTP runtime (no browser)**

| Candidate | Verdict |
|-----------|---------|
| Deno Deploy | **Disqualified**: AUP lists scrapers as not acceptable use |
| Cloudflare Workers Free | Cron every 10 min is allowed; **10 ms CPU** per cron is a poor fit for four HTML parsers; no `node:sqlite` files |
| Oracle Always Free `E2.1.Micro` (x86, 1 GB) | **Recommended to TEST**: Always Free VM, hard no-bill tenancy, systemd, sqlite, 10 TB egress. A1 is not preferred merely because it was the browser-era suggestion |
| GCP `e2-micro` | Backup HTTP VM; paid billing account after trial; overage billed; 1 GB/month egress |

Trial credits ≠ permanent zero-cost. Free compute ≠ a proven free complete deployment.
OLX may still 403 a cloud IP.

## Cloudflare Workers Free (bounded probe, 2026-09-16)

Isolated probe lives in `probe/cloudflare-workers/` + `src/probe/`. No D1/SQLite/Telegram.
Bundle dry-run: **835.72 KiB**. `wrangler whoami` unauthenticated. Hosted OLX **NOT TESTED**.
Parser CPU on Free (10 ms) **UNPROVEN**. Full four-source cycle **OPEN**.
Details: `evidence/phase-1/cloudflare-workers.md`.

## Remaining Phase 1 blockers

1. No hosted unattended zero-cost soak. Hosted OLX HTTP from a candidate VM: **NOT TESTED**.
   The successful “second environment” was Cursor WebFetch, not a deployable runtime.
2. DIM.RIA official API needs `DOMRIA_API_KEY` (unset here). HTML fallback **works** live;
   free API quota is incompatible with 144 cycles/day even with a key.
3. LUN RSC remains unofficial.
4. RIELTOR full-catalog pagination (38 apartment pages) and multi-day polling: not done.
   Adapter exists; first-page scans are truncated by design.
5. Continuous monitor / Telegram production path not closed (Telegram must not be sent here).

## Recommended next action (one)

**Do not provision Oracle from this task.** After `wrangler login` on the operator’s
Workers Free account, deploy **only** `probe/cloudflare-workers` and GET `/live-olx`
with `x-probe-token`. If no Cloudflare login exists, hosted OLX stays NOT TESTED.

Phase 1 source layer is **not** marked complete.
