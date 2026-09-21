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

Status: **classified. Hosting migration is still pending.**

OLX ordinary HTTP is `OLX_HTTP` fail: 3/3 CloudFront 403 on 2026-09-21. Stock Playwright Chromium extracted 85 real listings on 3/3 runs with HTTP 200 and no CAPTCHA bypass. Classification: `OLX_BROWSER_REQUIRED`.

Required runtime: `BROWSER_CAPABLE_RUNTIME` (Node 22+, Playwright 1.63, matching Chromium). Cloudflare Workers cannot host that browser. This batch does not change the host. `ENABLE_OLX` stays off. `ENABLE_OLX_BROWSER` stays off until the chosen host repeats the extract.
