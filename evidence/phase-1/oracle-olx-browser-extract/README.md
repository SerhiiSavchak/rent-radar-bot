# Oracle OLX browser extract — status

## Live Oracle after `4dab997` / capture `baab323` — extraction still unproven live

Capture `capture-1789666022490` (commit `baab323`) showed:

- `apartments/houses/main-document.html` contain quoted `window.__PRERENDERED_STATE__ = "<JSON-encoded string>"`
- matching `rendered.html` files **do not**
- evidenced path: `decodedState.listing.listing.ads` (apartments 52/49 unique, houses 37/37)
- camelCase catalog fields (`createdTime`, `isBusiness`, `price.regularPrice`, `location.cityName`, `map.show_detailed=false`)
- diagnostic HTML dumps were clipped at 2,000,000 bytes (original 3,879,053 / 4,308,077); ads arrays survived, the outer state did not
- run wall clock 239,458 ms vs `totalBudgetMs=125000`; categories 73,596 / 154,115 vs 60,000 with `timedOut=false` because capture/sanitization ran after the check

**Do not claim live OLX success. Do not wire OLX into Telegram** until a live Oracle extract reports `validatedListingCount > 0` after this parser change.

## What the extractor reads now

- **Parser input:** original Playwright navigation body first (`htmlInputKind=main_document`), then rendered DOM, then `/api/v1/offers` if intercepted.
- Quoted `__PRERENDERED_STATE__` is decoded with `JSON.parse` only (no `eval`).
- Production parser cap (`parserMaxHtmlBytes=8_000_000`) is separate from diagnostic HTML dump cap (`maxHtmlBytes=2_000_000`). Complete `listing.listing.ads` is saved as `relevant-state.json` with `originalBytes` / `savedBytes` / `truncated`.
- `timeoutMs` = `page.goto` only. `categoryBudgetMs` / `totalBudgetMs` cover parse, capture, and cleanup; expiry skips the next category and still closes the browser.

## Seller / freshness honesty

- `isBusiness=false` = private account, **not** verified property ownership (`sellerType=unknown`).
- `user.sellerType` is null in the captured offers.
- `createdTime` → `publishedAt` (`publishedAtProvenance=olx.createdTime`); `lastRefreshTime` / `pushupTime` stay separate.
- `map.show_detailed=false` is recorded as approximate coordinates.

Offline fixtures for this adapter are labeled **derived** from the Oracle capture; they are not a live probe.
