# Architecture decisions

Evidence date: 2026-09-21.  
Only decisions supported by the current code and the live checks in `docs/RENT_RADAR_STATUS.md` are recorded here.

## ADR: seller classification is evidence-based and permissive

Status: **final** for the delivery gate. The five names below are conceptual. The stored fields are `sellerType` (`owner` | `agent` | `business` | `unknown`) and `metadata.ownerEvidenceLevel`.

| Conceptual state | Current code                                                                                                          | Delivery                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| CONFIRMED_OWNER  | `sellerType=owner` from a platform flag (`isOwner`, characteristic 1437 = від власника, RIELTOR label `Власник`)      | SEND                                                    |
| LIKELY_OWNER     | `ownerEvidenceLevel=self_declared`. `sellerType` stays `unknown`. Title wording alone is not a platform confirmation. | SEND                                                    |
| UNKNOWN          | no platform role and no explicit intermediary evidence                                                                | SEND                                                    |
| LIKELY_AGENT     | agency id/name or explicit intermediary copy. `sellerRejectionReason` is `explicit_intermediary` or `conflict`.       | DROP, because that evidence is treated as strong enough |
| CONFIRMED_AGENT  | `sellerType=agent` or `business` from a platform role                                                                 | DROP                                                    |

`agency_id` on DIM.RIA and a private-account flag on OLX are not ownership and are not, by themselves, an agent drop.

## ADR: UNKNOWN seller is sent

Status: **final**.

`isSellerEligible` with the default policy `reject_intermediaries` returns true when `sellerRejectionReason` is undefined. Unknown listings are not dropped. Confirmed platform agents and businesses are dropped.

## ADR: uncertain dedup is sent

Status: **final as a rule, not implemented as cross-source matching**.

Exact repeats of the same source id / outbox fingerprint are suppressed. LUN `hasDuplicates`, `similarPageIds`, and `groupId` are stored on the listing and do not remove it. No fuzzy cross-source drop exists. An uncertain duplicate is therefore kept.

## ADR: explicit provenance outranks fuzzy similarity

Status: **final as a ranking rule. The dropper is not built.**

LUN catalog cards expose platform-provided links:

- `groupId` on 48/48 cards in the 2026-09-21 flats+houses fetch
- `similarPageIds` (LUN ids) on 27/48
- `hasDuplicates` boolean on 26/48 true
- `urlRaw` plus `site.internalName`: 35/48 `rieltor.ua`, 13/48 `olx.ua`

Those fields outrank any future text/price similarity. Similarity alone must not drop a listing. DIM.RIA and RIELTOR cards inspected here did not expose a foreign listing id.

## ADR: DIM.RIA official API cannot be consumed blindly every 10 minutes

Status: **final**.

The free package is about 1000 requests/month and 30/hour. A 10-minute poll is 4320 cycles/month, so even one official call per cycle exceeds the monthly cap. Two searches plus two detail calls would be about 17280/month.

Production acquisition is public HTML (`DOMRIA_ACQUISITION=html`). Official requests per normal poll: **0**. `DOMRIA_ACQUISITION=official` calls `developers.ria.com` only when the faster of `POLL_INTERVAL_SECONDS` and `TELEGRAM_POLL_INTERVAL_MS` fits the free package, and detail calls are capped by `DOMRIA_MAX_INFO_PER_POLL`. A 10-minute tick does not fit, so the official client stays idle. The HTML parser remains the working path (verified live).

## ADR: runtime remains undecided until OLX is classified

Status: **superseded** by the browser-runtime ADR below.

OLX ordinary HTTP is `OLX_HTTP` fail: 3/3 CloudFront 403 on 2026-09-21. Stock Playwright Chromium extracted 85 real listings on 3/3 local runs with HTTP 200 and no CAPTCHA bypass. Classification of the transport: `OLX_BROWSER_REQUIRED`. Hosted proof on the selected VM did not happen. See `OLX_HOSTED_BROWSER_BLOCKED` in `docs/RENT_RADAR_STATUS.md`.

## ADR: browser-capable runtime required by OLX

Status: **final for the requirement. Not proven on the target VM.**

Ordinary Node HTTP cannot acquire OLX (CloudFront 403). The working adapter is stock Playwright plus the repository's Chromium build, with no stealth plugin, proxy, or CAPTCHA solver. The process needs a `BROWSER_CAPABLE_RUNTIME`: Node 22+, Playwright 1.63, and that Chromium. Cloudflare Workers cannot provide it.

`ENABLE_OLX_BROWSER` stays false until five hosted cycles on the existing free VM succeed. This batch did not enable it.

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
