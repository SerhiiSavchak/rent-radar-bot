import type { Listing } from "../domain/listing.ts";
import type { SourceFetchResult } from "../domain/source.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { getConfig } from "../config/env.ts";

export type LiveVerdict = "PASS" | "PARTIAL" | "FAIL";

export function verdictFor(result: SourceFetchResult, required: string[]): LiveVerdict {
  if (result.listings.length === 0) {
    return "FAIL";
  }
  const sample = result.listings.slice(0, 5);
  const missing = required.filter((field) => sample.every((listing) => missingField(listing, field)));
  if (missing.length > 0) {
    return "PARTIAL";
  }
  if (result.health.healthy !== true) {
    return "PARTIAL";
  }
  return "PASS";
}

function missingField(listing: Listing, field: string): boolean {
  if (field === "publishedAt") {
    return !listing.publishedAt;
  }
  if (field === "coordinates") {
    return listing.location.latitude === undefined || listing.location.longitude === undefined;
  }
  if (field === "sellerTypeKnown") {
    return listing.sellerType === "unknown";
  }
  return false;
}

export function printLiveReport(label: string, result: SourceFetchResult, required: string[]): LiveVerdict {
  const config = getConfig();
  const duration = result.health.latencyMs ?? 0;
  const status = verdictFor(result, required);
  const filtered = applyListingFilters(result.listings, config);
  console.log("==================================================");
  console.log(`LIVE SOURCE TEST: ${label}`);
  console.log(`DATA KIND: ${result.dataKind}`);
  console.log(`Transport: ${result.transport}`);
  console.log(`HTTP/API status: ${result.httpStatus ?? "n/a"}`);
  console.log(`Listings discovered: ${result.listings.length}`);
  console.log(`Execution duration: ${duration} ms`);
  console.log(`Health: ${result.health.healthy ? "healthy" : "unhealthy"}`);
  if (result.health.message) {
    console.log(`Message: ${result.health.message}`);
  }
  if (result.rawNotes?.length) {
    console.log("Notes:");
    for (const note of result.rawNotes) {
      console.log(`  - ${note}`);
    }
  }
  const sample = result.listings.slice(0, Math.min(10, Math.max(3, result.listings.length)));
  for (const listing of sample) {
    const extra = filtered.find((item) => item.listing.sourceId === listing.sourceId);
    console.log("----------");
    console.log(`source: ${listing.source}`);
    console.log(`title: ${listing.title}`);
    console.log(
      `price: ${listing.price ? `${listing.price.amount} ${listing.price.currency}/${listing.price.period ?? "unknown"}` : "n/a"}`,
    );
    console.log(`location: ${listing.location.raw}`);
    console.log(`listing URL: ${listing.url}`);
    console.log(`listing ID: ${listing.sourceId}`);
    console.log(`publication date/time: ${listing.publishedAt?.toISOString() ?? "n/a"}`);
    console.log(`property type: ${listing.propertyType}`);
    console.log(`seller/owner classification: ${listing.sellerType}`);
    console.log(
      `filter considers private/owner: ${String(listing.metadata?.filterConsidersPrivateOwner ?? listing.sellerType === "owner")}`,
    );
    console.log(`raw seller classification evidence: ${(listing.sellerEvidence ?? []).join(" | ") || "n/a"}`);
    if (extra?.distanceKm !== undefined) {
      console.log(`haversine distance to Lviv center: ${extra.distanceKm.toFixed(2)} km`);
    } else {
      console.log("haversine distance to Lviv center: n/a (no coordinates or not computed)");
    }
  }
  console.log("==================================================");
  console.log(`RESULT: ${status}`);
  return status;
}

export function exitByVerdict(verdicts: LiveVerdict[]): void {
  if (verdicts.includes("FAIL") && verdicts.every((item) => item === "FAIL")) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}
