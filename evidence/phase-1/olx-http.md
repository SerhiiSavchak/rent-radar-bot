# OLX ordinary HTTP (this environment)

Date: 2026-09-15  
Environment: Windows Node.js `fetch`, default Chrome-like User-Agent from `src/utils/http.ts`  
Command: `npm run live:olx`  
Bypass / proxies / CAPTCHA / headed browser: **not used**  
Second environment (cloud / residential / Xvfb): **NOT TESTED**

## Result

`resultKind=http_error`, listings=0, overall verdict FAIL.

| URL | HTTP | Body |
|-----|------|------|
| `api/v1/offers` apartments `category_id=1760` Lviv | **403** | CloudFront HTML (`server=CloudFront`, `x-cache=Error from cloudfront`) |
| `api/v1/offers` houses `category_id=1758` Lviv | **200** | JSON `{"data":[],"metadata":{"total_elements":0,...}}` — empty, not listings |
| HTML Lviv long-term apartments | **403** | CloudFront HTML |

This matches `docs/SOURCE_RESEARCH.md` (2026-09-13): mixed 403 + empty 200 is unstable, not a working integration.

No 10-minute repeat was run: there is no successful HTTP path to re-validate. No anti-bot bypass was attempted.

Parser unit tests still cover `business: false` as **private-account evidence**, not ownership.
