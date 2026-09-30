# OLX seller-filter false positives (2026-09-28)

Production delivered five direct OLX listings that a human marked unacceptable.
This note records **generic signals** only. Do not hardcode listing/seller IDs
into product logic.

## Live investigation (Playwright, Europe/Kyiv window)

HTTP alone returned CloudFront 403 for some URLs; stock Playwright opened all five.

| signal class | listings (tokens) | evidence |
| --- | --- | --- |
| Registration year 2026 | `11mdHH`, `11md8C`, `11mdYm`, `11mdwr` | Listing HTML → `seller_registration_year_2026`. Profile often 1 page / 1 RE ad / coarse-only. |
| Multi-page coarse inventory → likely | `11md9h` | Business account type (not agency proof alone). Profile `totalPages=2`, ≥3 coarse locations after paging → `profile_likely_intermediary`. |

## Fail-open paths that allowed delivery

1. **Direct OLX → `not_required`**: profile/unknown/incomplete returned `{ outcome: "not_required", drop: false }`, so the pipeline treated verification as optional and sent.
2. **No listing-HTML classification on direct OLX**: registration-year 2026 was never applied on the direct path (catalog cards do not carry `accountRegistrationYear`).
3. **Incomplete short-circuit**: unread profile pages returned `unknown` *before* evaluating already-visible likely/inventory signals.
4. **Hold target**: holds keyed only off `metadata.originalUrl`, so direct OLX (`listing.url`) never entered the hold table.
5. **Hold release**: unresolved holds auto-`send` after `SELLER_HOLD_MAX_MS`.

## Expected generic outcomes (post-fix)

- Registration year 2026 → terminal reject (not SEND).
- Complete profile with likely/inventory reject evidence → terminal reject.
- Incomplete / unreadable / timeout / parser failure / probe-cap → HOLD/retry, not SEND, not terminal seen.
- Confirmed owner with complete non-reject evidence → eligible SEND.
