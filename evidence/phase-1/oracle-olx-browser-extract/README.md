# Oracle OLX browser extract — status

## Live Oracle after `75f7384` — extraction succeeded, not delivery-ready

Live `live:olx:browser-extract` on `75f738457d386173b9c554e0a3d069f04e681ddc` (2026-09-18T20:27:56Z):

- `extractionOk=true`, `accessibilityOk=true`, `browserClosed=true`
- apartments `51` validated (`rawOfferCount=52`, one `duplicate_id`)
- houses `38` validated (`rawOfferCount=39`, one `duplicate_id`)
- `extractSource=prerendered_state`, `htmlInputKind=main_document` for both categories
- schema failures gone
- **not wired to Telegram**; `ENABLE_OLX` stays false; this is extraction evidence only

Details: `cycle-75f7384.json`.

## Owner: `ownerEligibleCount=0` is correct, not a parser miss

OLX catalog ads never set a platform owner flag. Captured ads have:

- `isBusiness=false` + `user.sellerType=null` → private **account**
- `isBusiness=true` → business account
- title/description phrases such as «від власника» / «без комісії» are text evidence only

`classifyOwner` requires `platformOwner=true` for `sellerType=owner`. Private-account evidence is recorded separately and does **not** set `filterConsidersPrivateOwner`. Live samples in this run were all `sellerType=business`.

## Freshness: a timestamp is not a new Telegram publication

The `75f7384` diagnostic counted every listing with a `createdTime`/`publishedAt` Date (`freshnessEligibleCount=51/38`). Telegram policy is different (`listing-freshness.ts`, default 7 days, `TELEGRAM_STRICT_NEW_PUBLICATIONS=true`):

| sample `publishedAt` | `refreshedAt` | kind at probe time |
| --- | --- | --- |
| 2026-08-28 | 2026-09-18 | `refreshed_old` — not a new publication |
| 2026-09-08 | same-day refresh | `old_publication` |
| 2026-09-10 | 2026-09-18 | `old_publication` |
| 2026-09-12 | same-day refresh | `new_publication` (within 7 days) |
| 2026-09-17 | same-day refresh | `new_publication` |

Refresh/push-up must not relabel an old `createdTime` as «Нова публікація».

## Runtime 254.773s vs `totalBudgetMs=210000`

- apartments `elapsedMs=87478`, `timedOut=false`, full diagnostic capture written
- houses `elapsedMs=146207`, `timedOut=true`, extract still succeeded, rendered capture skipped (`originalBytes=0`)
- notes included `timeout_after_successful_extract=true`

Houses overran the 90s category budget because post-extract `page.content()` / cleanup was not aborted after listings were already parsed. Successful listings must be kept; the timeout must still be reported; capture after a successful main-document parse must not wait on rendered DOM.
