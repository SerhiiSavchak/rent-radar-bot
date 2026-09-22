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

DIM.RIA `agency_id` is stored as evidence text and is not passed into `classifyOwner`, so it is not an agent drop. `user_id` is stored as `metadata.userId` and as a context note. It is not ownership proof. A private-account flag and OLX `isBusiness` are not ownership and are not an agent drop. A LUN `site.internalName` of `rieltor.ua` is provenance, not intermediary evidence. When the same poll has already fetched the linked listing and that link is an explicit `urlRaw` / external id, a confirmed intermediary on the linked listing drops the other copy, and a confirmed owner is accepted, both without a detail request. A same-cycle RIELTOR card whose seller is still unknown does not skip that request. An unknown linked listing, OLX `isBusiness` alone, a LUN `groupId`, and rooms/area/price overlap do not drop the copy by themselves. A sendable new LUN listing may trigger one rebuilt `https://rieltor.ua/{locality}/{flats-rent|houses-rent}/view/{id}/` request. Only an explicit detail role `Рієлтор` or an explicit agency name drops the copy, and only when the final URL is still that same canonical listing. HTTP 429 stops further detail requests in that cycle. Confirmed owner and intermediary verdicts stay cached for 30 days. A transient detail failure (HTTP 403, HTTP 429, timeout, transport error, or parser failure) is cached for 60 seconds so the next poll can retry. That failure does not send on the first attempt and does not become an agent drop. The candidate is stored in `seller_verification_holds` for at most 20 minutes. A later confirmed intermediary closes the hold with no Telegram send. A later confirmed owner, or a successful ambiguous page, sends through the normal outbox. If the hold expires while the seller is still unverified, the listing is sent once as unknown.

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

An uncertain attribute overlap is reported as `possible_duplicate` with reason `attribute_overlap_not_sufficient` and is still sent. The same explicit external identity can also carry a confirmed intermediary rejection onto the linked copy. `possible_duplicate` does not.

One real rental property cluster produces one Telegram notification. The first reliable representative is sent immediately; the poll does not wait for every source. A later copy is suppressed only when the cross-source identity is deterministic. Fuzzy similarity never suppresses a listing.

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

Accepted listing → SQLite `telegram_outbox` row `pending` → `sending` → `sent` only after the Bot API confirms success. A transient failure becomes `failed` with `next_attempt_at` (2 minutes, doubling, capped at 6 hours; Telegram `retry_after` can extend that). `TELEGRAM_DRY_RUN=true` does not write `sent`, seen, canary, or admin-alert delivery. An item-specific non-parse `400` stays `failed` and is not polled again. `401`, `403`, and chat-not-found are `operator_action`: the row stays queued, and `schema_meta` pauses the channel (10 minutes, doubling, cap 6 hours) so the rest of the queue is not hammered. New listings are still enqueued. After the pause, one probe resumes delivery and clears the pause on success. `sending` rows return to `pending` on reopen. Age never deletes an undelivered row. Telegram has no send idempotency key: a crash after Telegram accepts a message and before `markSent` commits can duplicate that one message. No-loss is preferred over claiming exactly-once. An HTML entity parse error is retried once as plain text. `ADMIN_TELEGRAM_CHAT_ID` receives one source alert after 3 consecutive failures and one recovery when that source is healthy again. A failed admin send does not stop listing delivery.

## ADR: UNKNOWN seller is retained

Status: **final**.

`UNKNOWN` and self-declared wording are sent. `sellerType` stays `unknown` for both. OLX `isBusiness` is recorded and does not become `sellerType=business`. Platform `agent` / `business` and explicit intermediary text, including «Я рієлтор», are dropped. The Telegram line for an unknown role is «Власник не підтверджено».

## ADR: source errors never become empty inventory

Status: **final**.

`ok` and `valid_empty` are the only healthy kinds. `parser_failure`, `http_error`, and `rate_limited` are unhealthy. An OLX browser crash is not `valid_empty`. A RIELTOR 429 is `rate_limited` even when an earlier page had cards. A LUN schema rejection of every card is `parser_failure`. DIM.RIA without the expected catalog structure is `parser_failure`. An empty catalog array, when the structure is present, stays `valid_empty`.

## ADR: operational SQLite state is bounded and restart-safe

Status: **final for schema 7**.

SQLite stores current operations, not a historical archive. Schema 4 is the previous production shape (through `cross_source_identities`). Schema 5 adds `source_health` and the indexes used by retention. Schema 6 adds `external_seller_verifications` for linked RIELTOR seller checks. Schema 7 adds outbox retry scheduling (`next_attempt_at`, `error_class`) and `source_admin_alerts`. Schema 8 adds `seller_verification_holds` for a short linked-seller retry. Migration is incremental: it does not rebuild or delete existing rows. Expired verification rows are deleted by the same 24-hour cleanup. A hold whose `release_at` is more than 24 hours in the past is deleted by that cleanup; an open hold inside its 20-minute window is left for the poller. Alert rows are current incident state, not a history log.

`source_health` has one row per source: `ok`, `valid_empty`, `parser_failure`, `http_error`, `rate_limited`, `transport_failure`, `browser_failure`, `disabled`. Healthy `ok` / `valid_empty` reset `consecutive_failures` and set `last_success_at`. Failure statuses increment the streak and leave `last_success_at` in place. `disabled` does not change the streak. `parser_failure` is never stored as `valid_empty`, and only when an adapter returns that structured result. HTTP 429 is `rate_limited`. The poller's `transport_blocked` result (HTTP 403) is stored as `transport_failure`. A thrown network or adapter exception is also `transport_failure`. A thrown OLX Playwright acquisition is `browser_failure`. Each poll writes `disabled` for domria, lun, rieltor, and olx when that source's flag is off, including when `createCollectionAdapters` omits the adapter. OLX is one row: it is enabled when either `ENABLE_OLX` or `ENABLE_OLX_BROWSER` is on. Error text is truncated and redacted. Successful HTML is not stored.

The canonical poller runs cleanup on startup and then at most once every 24 hours (`schema_meta.state_cleanup_at`). One cleanup pass deletes:

- `seen_listings` with `last_seen_at` older than 30 days, unless a pending, sending, failed, or still-kept sent outbox row matches them
- `cross_source_identities` older than 90 days, unless a pending, sending, failed, or sent-within-30-days outbox row matches that listing
- `telegram_outbox` rows with status `sent` and `sent_at` older than 30 days
- `external_seller_verifications` rows whose `expires_at` has passed
- `seller_verification_holds` rows whose `release_at` is more than 24 hours behind the cleanup clock

Age never deletes pending, sending, or failed outbox rows, `source_baselines`, `poller_lock`, seller-policy keys, or the current `source_health` row. There is no poll-diagnostic history table and no source-health history table, so the 14-day and 30-day history windows are not applied.

## ADR: acquired catalog cards are kept; RIELTOR walks newest-first until a publication boundary

Status: **final** for the poll sample. A global prefix of 10 discarded cards that the same response had already returned. DIM.RIA, LUN, and OLX now keep the rental cards from that already-acquired response, split by apartment and house, with a safety cap of 120 cards per category. Live first responses on 2026-09-22 were LUN 24 cards per category and OLX 51 apartments plus 36 houses, so the cap does not hide a normal first page.

RIELTOR's public catalog default is advertising activity, not publication time. The public query `sort=bycreated` returned newest-first pages on 2026-09-22: page 1 timestamps descended, and page 2 was older than page 1, for both flats and houses, across three captures. The poll uses that order. With no stored boundary it fetches page 1 and records the newest publication. Later polls stop once a card is at least 30 minutes older than that boundary, and they do not scan the declared catalog. Three pages is only a guard. If that guard is reached first, `coverageTruncated` is recorded on the source health row and the boundary is not advanced. That scan is not complete coverage of the hundreds of declared listings.

`DATABASE_PATH` defaults to `./data/rent-radar.sqlite` inside the checkout. That file may already be the live Oracle inventory database. This batch does not move it. Cleanup deletes rows only. `resetDbForTests` refuses the default path. Deleting rows does not shrink the file; SQLite reuses free pages.
