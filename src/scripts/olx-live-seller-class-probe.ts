/**
 * Live class probe: take current Private catalog listings and run linked seller HTML classification.
 * No Telegram. No SQLite writes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractOlxListingsViaBrowser } from "../sources/olx/olx-browser.extract.ts";
import { resolveOlxBrowserBudgets } from "../sources/olx/olx-browser.source.ts";
import { createCycleOlxSellerVerifier } from "../delivery/olx-detail-seller.ts";

const OUT = join(process.env.HOME ?? process.cwd(), "rent-radar-runtime", "evidence", "seller-detail-hold");
mkdirSync(OUT, { recursive: true, mode: 0o700 });
const budgets = resolveOlxBrowserBudgets();
const started = Date.now();
const extract = await extractOlxListingsViaBrowser({
  timeoutMs: budgets.timeoutMs,
  categoryBudgetMs: budgets.categoryBudgetMs,
  totalBudgetMs: budgets.totalBudgetMs,
  commit: "local-probe",
});
const sample = extract.listings.slice(0, 6);
const verify = createCycleOlxSellerVerifier({
  peers: extract.listings,
  now: () => new Date(),
  timeoutMs: budgets.timeoutMs,
  maxRequests: 6,
  maxBrowserFallbacks: 6,
  maxProfileProbes: 6,
});
const decisions = [];
for (const listing of sample) {
  const decision = await verify(listing);
  decisions.push({
    sourceId: listing.sourceId,
    url: listing.url,
    sellerType: listing.sellerType,
    metadata: {
      accountRegistrationYear: listing.metadata?.accountRegistrationYear,
      isBusiness: listing.metadata?.isBusiness,
      distinctPreciseRealEstateProperties: listing.metadata?.distinctPreciseRealEstateProperties,
    },
    decision,
  });
  console.log(JSON.stringify(decisions.at(-1), null, 2));
}
const out = {
  at: new Date().toISOString(),
  catalogCount: extract.listings.length,
  privateComplete: extract.privateScan?.apartments.status === "complete" && extract.privateScan?.houses.status === "complete",
  elapsedMs: Date.now() - started,
  decisions,
};
const path = join(OUT, `olx-live-seller-class-${Date.now()}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log("wrote", path);
