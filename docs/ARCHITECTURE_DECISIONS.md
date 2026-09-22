# Architecture decisions

Evidence date: 2026-09-21.  
Only decisions supported by the current code and the live checks in `docs/RENT_RADAR_STATUS.md` are recorded here.

## ADR: seller classification is evidence-based and permissive

Status: **final** for the delivery gate. `classifyOwner` still returns `sellerType` and `ownerEvidenceLevel`. It also returns `evidenceItems` (`source`, `type`, `value`, `strength`). `sellerAssessmentFromClassification` maps that to `metadata.sellerAssessment` (`state`, `confidence`, `evidence`, `send`). Parsers copy the assessment onto the listing. The delivery gate is still `isSellerEligible`.

| Conceptual state | Current code                                                                                                                                                                                        | Delivery                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| CONFIRMED_OWNER  | `sellerType=owner` from a platform flag (`isOwner`, characteristic 1437 = від власника, RIELTOR label `Власник`)                                                                                    | SEND                       |
| LIKELY_OWNER     | `ownerEvidenceLevel=self_declared`. `sellerType` stays `unknown`. Title wording alone is not a platform confirmation.                                                                               | SEND                       |
| UNKNOWN          | no platform role and no explicit intermediary evidence. Includes OLX `isBusiness` and a LUN card whose only extra fact is `site.internalName`.                                                      | SEND                       |
| LIKELY_AGENT     | Not emitted in v1. A weak hint must stay sendable, and no current signal is classified here.                                                                                                        | SEND if it is ever emitted |
| CONFIRMED_AGENT  | `sellerType=agent` or `business`, or `ownerEvidenceLevel` `intermediary` / `conflict` (platform role, agency id/name passed into the classifier, or explicit intermediary text such as «я рієлтор») | DROP                       |

DIM.RIA `agency_id` is stored as evidence text and is not passed into `classifyOwner`, so it is not an agent drop. `user_id` is stored as `metadata.userId` and as a context note. It is not ownership proof. A private-account flag and OLX `isBusiness` are not ownership and are not an agent drop. A LUN `site.internalName` of `rieltor.ua` is provenance, not intermediary evidence.

## ADR: UNKNOWN seller is sent

Status: **final**.

`isSellerEligible` with the default policy `reject_intermediaries` returns true when `sellerRejectionReason` is undefined. Unknown listings are not dropped. Confirmed platform agents and businesses are dropped.

## ADR: uncertain dedup is sent

Status: **final**. Implemented in `src/delivery/cross-source-dedup.ts`.

Only `confirmed_duplicate` suppresses delivery. `possible_duplicate` and `unique` continue. There is no opaque score.

What can suppress:

1. Same `source + sourceId`, or the same canonical listing URL, via the existing seen-listing store.
2. An explicit foreign listing identity. A LUN `urlRaw` whose host is OLX, RIELTOR, or DIM.RIA is normalized (tracking query and hash removed; OLX token case kept). If that token or `/view/{id}` matches another listing's own identity, the later listing is a confirmed duplicate.
3. A shared LUN `groupId` between two LUN listings. The key is `lun:group:{id}`. It is never compared to an OLX, RIELTOR, or DIM.RIA id.

What cannot suppress:

- `similarPageIds` and `hasDuplicates` are kept on the provenance record. They are not identity keys.
- Rooms, area, and price, including the same combination on the same coordinates.
- Title or description text. v1 does not compute text similarity.
- Image perceptual hashing and AI/LLM similarity. They are not part of v1.

An uncertain attribute overlap is reported as `possible_duplicate` with reason `attribute_overlap_not_sufficient` and is still sent.

## ADR: explicit provenance outranks fuzzy similarity

Status: **final**. The dropper uses only the hierarchy above.

LUN catalog cards expose platform-provided links:

- `groupId` on 48/48 cards in the 2026-09-21 flats+houses fetch
- `similarPageIds` (LUN ids) on 27/48
- `hasDuplicates` boolean on 26/48 true
- `urlRaw` plus `site.internalName`: 35/48 `rieltor.ua`, 13/48 `olx.ua`

`readProvenance` stores source, source listing id, canonical URL, external source name, external URL, external listing id when the URL pattern is deterministic, `groupId`, `similarPageIds`, `hasDuplicates`, and the raw site name. DIM.RIA and RIELTOR cards inspected in the source-layer batch did not expose a foreign listing id, so they contribute only their own identity.

Confirmed identity rows live in SQLite table `cross_source_identities` (schema version 4). `enqueueIfNew` inserts them in the same transaction as the new `telegram_outbox` row. `markSeen` does not. A freshness rejection, a silent baseline row, or a crash before that commit cannot suppress a later twin. A failed Telegram send still leaves the keeper retryable and still suppresses the twin, because the outbox row and the identity keys committed together. Reopening the same database keeps the match. Schema 5 removes an identity row only after 90 days, and only when that listing has no pending, sending, failed, or recently sent outbox row.

## ADR: DIM.RIA official API cannot be consumed blindly every 10 minutes

Status: **final**.

The free package is about 1000 requests/month and 30/hour. A 10-minute poll is 4320 cycles/month, so even one official call per cycle exceeds the monthly cap. Two searches plus two detail calls would be about 17280/month.

Production acquisition is public HTML (`DOMRIA_ACQUISITION=html`). Official requests per normal poll: **0**. `DOMRIA_ACQUISITION=official` calls `developers.ria.com` only when the faster of `POLL_INTERVAL_SECONDS` and `TELEGRAM_POLL_INTERVAL_MS` fits the free package, and detail calls are capped by `DOMRIA_MAX_INFO_PER_POLL`. A 10-minute tick does not fit, so the official client stays idle. The HTML parser remains the working path (verified live).

## ADR: runtime remains undecided until OLX is classified

Status: **superseded** by the browser-runtime ADR below.

OLX ordinary HTTP is `OLX_HTTP` fail: 3/3 CloudFront 403 on 2026-09-21. Stock Playwright Chromium extracted 85 real listings on 3/3 local runs with HTTP 200 and no CAPTCHA bypass. Classification of the transport: `OLX_BROWSER_REQUIRED`. Hosted proof on the existing Oracle VM is PASS; see `docs/RENT_RADAR_STATUS.md`.

## ADR: browser-capable runtime required by OLX

Status: **final. Hosted proof PASS.**

Ordinary Node HTTP cannot acquire OLX (CloudFront 403). The working adapter is stock Playwright plus the repository's Chromium build, with no stealth plugin, proxy, or CAPTCHA solver. The process needs a `BROWSER_CAPABLE_RUNTIME`: Node 22+, Playwright 1.63, and that Chromium. Cloudflare Workers cannot provide it.

Issue #2 accepts five hosted Playwright cycles on the existing free VM, with browser cleanup, all four sources in one poll, and the systemd poller alive after restart and reboot. The repository default `ENABLE_OLX_BROWSER` remains false so a checkout does not start Chromium by itself. The accepted VM run used the browser. This batch did not change the flag and did not repeat the hosted cycles.

## ADR: normal OLX HTTP path is not production acquisition

Status: **final**.

`ENABLE_OLX` stays false. When browser mode is on, the HTTP adapter is omitted. There is no silent fallback from a browser failure to `api/v1/offers`.

## ADR: exactly one canonical durable poll/delivery path

Status: **final**.

Production collection and Telegram delivery run only through `src/scripts/test-telegram-poll.ts`, started by `deploy/systemd/rent-radar-telegram.service` / `rent-radar-telegram.timer`, or by `npm run live:test-telegram:poll`.

`src/index.ts` exits 2. `ListingMonitorService.collectNewListings()` throws. Neither writes the seen-listing table nor sends Telegram.

## ADR: Telegram delivery must use persistent outbox semantics

Status: **final**.

Accepted listing → SQLite baseline/dedupe state → pending `telegram_outbox` row → Telegram attempt → `sent` only after success. Failure leaves the row retryable. A process restart reopens the same file and retries. A successful row is not sent again.

## ADR: UNKNOWN seller is retained

Status: **final**.

`UNKNOWN` and self-declared wording are sent. `sellerType` stays `unknown` for both. OLX `isBusiness` is recorded and does not become `sellerType=business`. Platform `agent` / `business` and explicit intermediary text, including «Я рієлтор», are dropped. The Telegram line for an unknown role is «Власник не підтверджено».

## ADR: source errors never become empty inventory

Status: **final**.

`ok` and `valid_empty` are the only healthy kinds. `parser_failure`, `http_error`, and `rate_limited` are unhealthy. An OLX browser crash is not `valid_empty`. A RIELTOR 429 is `rate_limited` even when an earlier page had cards. A LUN schema rejection of every card is `parser_failure`. DIM.RIA without the expected catalog structure is `parser_failure`. An empty catalog array, when the structure is present, stays `valid_empty`.

## ADR: operational SQLite state is bounded and restart-safe

Status: **final for schema 5**.

SQLite stores current operations, not a historical archive. Schema 4 is the previous production shape (through `cross_source_identities`). Schema 5 adds `source_health` and the indexes used by retention. Migration is incremental: it does not rebuild or delete existing rows.

`source_health` has one row per source: `ok`, `valid_empty`, `parser_failure`, `http_error`, `rate_limited`, `transport_failure`, `browser_failure`, `disabled`. Healthy `ok` / `valid_empty` reset `consecutive_failures` and set `last_success_at`. Failure statuses increment the streak and leave `last_success_at` in place. `disabled` does not change the streak. `parser_failure` is never stored as `valid_empty`, and only when an adapter returns that structured result. HTTP 429 is `rate_limited`. The poller's `transport_blocked` result (HTTP 403) is stored as `transport_failure`. A thrown network or adapter exception is also `transport_failure`. A thrown OLX Playwright acquisition is `browser_failure`. Each poll writes `disabled` for domria, lun, rieltor, and olx when that source's flag is off, including when `createCollectionAdapters` omits the adapter. OLX is one row: it is enabled when either `ENABLE_OLX` or `ENABLE_OLX_BROWSER` is on. Error text is truncated and redacted. Successful HTML is not stored.

The canonical poller runs cleanup on startup and then at most once every 24 hours (`schema_meta.state_cleanup_at`). One cleanup pass deletes:

- `seen_listings` with `last_seen_at` older than 30 days, unless a pending, sending, failed, or still-kept sent outbox row matches them
- `cross_source_identities` older than 90 days, unless a pending, sending, failed, or sent-within-30-days outbox row matches that listing
- `telegram_outbox` rows with status `sent` and `sent_at` older than 30 days

Age never deletes pending, sending, or failed outbox rows, `source_baselines`, `poller_lock`, seller-policy keys, or the current `source_health` row. There is no poll-diagnostic history table and no source-health history table, so the 14-day and 30-day history windows are not applied.

`DATABASE_PATH` defaults to `./data/rent-radar.sqlite` inside the checkout. That file may already be the live Oracle inventory database. This batch does not move it. Cleanup deletes rows only. `resetDbForTests` refuses the default path. Deleting rows does not shrink the file; SQLite reuses free pages.
