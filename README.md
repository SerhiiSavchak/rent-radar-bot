# rent-radar-bot

Phase 0 prototype for a future Telegram rental monitor. The goal of this phase is **not** a production bot. It is to prove, with live requests, whether OLX Ukraine, DIM.RIA and LUN can currently supply long-term apartment and house rentals around Lviv, and to normalize them into one listing model.

## Current Phase 0 status

Validated on 2026-09-13 against live sites from a Node.js process:

| Source | Live access from this environment | Approach used |
|--------|-----------------------------------|---------------|
| DIM.RIA | Yes (public search HTML + `__INITIAL_STATE__`) | Official API exists but needs `DOMRIA_API_KEY`; HTML fallback used when the key is absent |
| LUN | Yes (search HTML, JSON-LD + Next.js RSC cards) | No public listings API; structured embedded data |
| OLX | No (`403` CloudFront) | Ordinary HTTP to HTML and `api/v1/offers` is blocked; no WAF bypass was implemented |

See [docs/SOURCE_RESEARCH.md](docs/SOURCE_RESEARCH.md) for the measured results.

## Architecture

```
Scheduler / live scripts
    |
    +-- OLX Source Adapter
    +-- DIM.RIA Source Adapter
    +-- LUN Source Adapter
             |
             v
        Filters (owner, location/Haversine, property type)
             |
             v
       SQLite deduplication
             |
             v
        Console output (Telegram later)
```

Adapters are isolated. `Promise.allSettled` is used so one failed source does not stop the others.

## Requirements

- Node.js **22.13+** (uses built-in `node:sqlite`; 20 is not sufficient without a different SQLite driver)
- npm

## Installation

```bash
npm install
cp .env.example .env
```

## Environment variables

See `.env.example`. Important keys:

- `TARGET_CITY`, `TARGET_LAT`, `TARGET_LNG`, `TARGET_RADIUS_KM` — Lviv center and radius (defaults: Ratusha-area coordinates, 15 km)
- `SOURCE_TIMEOUT_MS`, `POLL_INTERVAL_SECONDS` — timeouts and future polling (polling is **not** started automatically)
- `DOMRIA_API_KEY` — official DIM.RIA API key from https://developers.ria.com
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — optional; if missing, output is console-only
- `DATABASE_PATH` — SQLite file for deduplication

Never commit `.env`.

## Commands

```bash
npm run typecheck
npm run lint
npm test

npm run live:olx
npm run live:domria
npm run live:lun
npm run live:all
```

Aliases:

```bash
npm run test:olx
npm run test:domria
npm run test:lun
npm run test:sources
```

Live commands hit real websites/APIs. They are **not** part of `npm test`.

Each live test prints `DATA KIND: LIVE DATA` (or would print MOCK/FIXTURE if that were used — live scripts never do). Verdicts are `PASS` / `PARTIAL` / `FAIL`.

One-shot monitor (still not an infinite loop):

```bash
npm start
```

## SQLite deduplication

Listings are stored with a unique key on `source + source_id` and a unique canonical URL. `hasSeenListing()` / `saveListing()` / `markSeen()` / `getRecentListings()` live in `src/storage`. Repeating search results are not treated as new listings.

## Telegram

Phase 0 only implements the Bot API sink. Create a bot with [@BotFather](https://t.me/BotFather), add it to a group, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Without those variables the app uses `ConsoleOutput`.

## Known limitations

- OLX is blocked by CloudFront for this Node.js client; reliability for unattended OLX monitoring is currently **low**.
- DIM.RIA official API is the maintainable path but requires a key and has a free cap of about 30 requests/hour and 1000/month. Search returns IDs only; each detail call consumes quota.
- LUN cards come from Next.js RSC payload plus JSON-LD. JSON-LD around Lviv currently swaps lat/lng; the adapter prefers GeoJSON `[lng, lat]` from cards.
- LUN `без посередників` / `isOwner` is a platform signal, not a legal guarantee.
- Radius filtering uses Haversine when coordinates exist. Listings without coordinates are not treated as “in Lviv” just because of the word “Lviv”.
- No infinite scheduler, no hosting, no multi-chat routing.

## Production roadmap

1. Obtain a DIM.RIA API key and measure real quota against the desired poll interval.
2. Decide whether OLX is in scope without anti-bot infrastructure (it should not be sold as reliable today).
3. Add a supervised long-running process with health alerts.
4. Wire Telegram groups, owner-only mode, and configurable saved searches.
5. Ask the existing-bot client what they dislike before locking UX.

## License

Private prototype.
