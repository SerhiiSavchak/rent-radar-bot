# Phase 1 decision (source layer)

Date: 2026-09-17  
Branch: `cursor/phase-1-source-layer-closure-8797`

Phase 1 is **not complete**.

## Cloudflare Workers Free

**REJECT** current poller on Workers Free (OLX HTTP PASS; Free CPU FAIL). See `evidence/phase-1/cloudflare-cpu-attribution.md`.

## Oracle Always Free — HTTP / browser / soak

| Probe | Result |
|-------|--------|
| OLX HTTP | **FAIL** CloudFront 403 |
| OLX stock Chromium (3 + soak 12) | **Page access PASS** (`browser_accessible`) — **not** deliverable listing parse |
| Soak 12×10min (`3af328c`) | **DEGRADED** — LUN/RIELTOR/OLX-browser 12/12; Domria 0/12 due to missing `resultKind` (fixed after soak); OLX HTTP 0/12 diagnostic |
| Domria extraction on Oracle | **Worked** (10 listings/cycle) but mis-scored until `resultKind` fix |

Evidence: `evidence/phase-1/oracle-soak/summary.json`, `REVIEW.md`.

## Telegram TEST delivery

Guarded sink (`TELEGRAM_TEST_MODE=true` only). HTTP sources only; OLX browser is **not** a Telegram transport. Unknown sellers labeled “not verified ownership”. Six-cycle unattended launcher: `scripts/oracle-telegram-test/`.

## Recommended next action

**RIELTOR access** is the next source task (`evidence/phase-1/rieltor.md`). OLX browser extract produced listings; ownership is still not platform-confirmed. The remaining OLX owner check is one offer-detail diagnostic on Oracle (`scripts/oracle-olx-verify/`). If that page has no stronger seller-role field, the OLX owner investigation is closed.

Durable baseline / dedupe / outbox and restart recovery remain **required before production Telegram acceptance**. In-memory TEST state is not enough.
