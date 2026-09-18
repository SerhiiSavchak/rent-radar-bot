# Oracle OLX browser extract — status

## Live extraction (`75f7384`) — not delivery-ready

Live `live:olx:browser-extract` on `75f738457d386173b9c554e0a3d069f04e681ddc` (2026-09-18T20:27:56Z):

- `extractionOk=true`, 51 apartments + 38 houses, `prerendered_state` / `main_document`
- **not wired to Telegram**; `ENABLE_OLX` stays false
- Timing fix in `1446347` (skip rendered capture after success) is **live-unverified**

Details: `cycle-75f7384.json`.

## Ownership audit (full captured ads, not sampleListings)

Source: baab323 diagnostic capture `listing.listing.ads` salvaged from truncated main-document HTML (apartments 52, houses 37). Re-classified with the current evidence levels. `user.sellerType` was **null on every ad**. `isBusiness`: 85 true / 4 false.

| evidence level | count | what it is |
| --- | --- | --- |
| platform-confirmed owner | **0** | OLX catalog has no owner flag |
| explicit self-declared owner | **3** | private account + «від власника» / «без посередників» |
| private account, unknown ownership | **1** | `isBusiness=false`, no owner claim (`934070005` «приватного будинку» is the building, not the seller) |
| intermediary / business | **85** | `isBusiness=true`; includes «без комісії» / «без рієлтора» copy |
| conflict | **0** | no business ad combined with «від власника» / «без посередників» |

Representative self-declared ids: `924128798`, `933587870` (title «від власника»); `935081899` (description «без посередник»). Business ads `934939054` and `934659823` say «без комісії»; `934405532` says «без рієлтора» — those stay intermediary.

**Missing for platform-confirmed owners:** OLX `user.sellerType` is always null in this catalog payload. Next bounded check (not this task): a single offer detail page / `api/v1/offers/{id}` for whether a non-null seller role exists off-catalog. Until then the default `OWNER_ONLY` gate cannot accept OLX listings.

Self-declared delivery is **opt-in** (`OWNER_ACCEPT_SELF_DECLARED=true`) and labeled «Самозаява … не позначка майданчика». Private account alone never establishes ownership. Agency + owner phrasing is `conflict`. Misleading copy such as «looking for an owner» / «owners, contact us» is not a self-declaration.

## Freshness

Extract `freshnessEligibleCount` / `withinAgeWindowCount` is the 7-day **age window**, not Telegram send eligibility. Delivery also requires a per-source silent baseline, unseen dedupe keys, and `publishedAt` **after monitoring started**. A listing first seen after baseline with `publishedAt` before that baseline is `late_discovered`. Restart state is in-memory only: downtime publications are swallowed on silent re-baseline. There is no approved durable TEST store.

## Runtime

`1446347` stops rendered-DOM capture after a successful main-document parse. Not re-checked live in this task.
