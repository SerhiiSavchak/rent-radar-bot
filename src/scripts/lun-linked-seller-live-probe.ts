/**
 * Live LUN → linked DOM.RIA seller class probe. No Telegram. No SQLite.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LunSource } from "../sources/lun/lun.source.ts";
import { createCycleDomriaSellerVerifier } from "../delivery/domria-detail-seller.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { getConfig } from "../config/env.ts";

const OUT = join(process.env.HOME ?? process.cwd(), "rent-radar-runtime", "evidence", "seller-detail-hold");
mkdirSync(OUT, { recursive: true, mode: 0o700 });
const source = new LunSource();
const result = await source.inspectLatest({ includeHouses: true });
const config = getConfig();
const filtered = applyListingFilters(result.listings, config).filter((r) => r.accepted);
const withLink = result.listings.filter((l) => {
  const u = typeof l.metadata?.originalUrl === "string" ? l.metadata.originalUrl : l.url;
  return /dom.ria|domria/i.test(u) || /dom.ria|domria/i.test(JSON.stringify(l.metadata ?? {}));
}).slice(0, 8);
const sample = (withLink.length > 0 ? withLink : result.listings.slice(0, 5));
const verify = createCycleDomriaSellerVerifier({
  peers: result.listings,
  now: () => new Date(),
  timeoutMs: 25_000,
});
const decisions = [];
for (const listing of sample) {
  const decision = await verify(listing);
  decisions.push({
    sourceId: listing.sourceId,
    url: listing.url,
    originalUrl: listing.metadata?.originalUrl,
    sellerType: listing.sellerType,
    decision,
  });
  console.log(JSON.stringify(decisions.at(-1), null, 2));
}
const out = {
  at: new Date().toISOString(),
  lunHealthy: result.health.healthy,
  lunCount: result.listings.length,
  acceptedCount: filtered.length,
  linkedCandidates: withLink.length,
  decisions,
};
const path = join(OUT, `lun-linked-seller-${Date.now()}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log("wrote", path);
