import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Listing } from "../src/domain/listing.ts";
import { closeDb, hasSeenListing, resetDbForTests, saveListing } from "../src/storage/db.ts";

function listing(sourceId: string, url: string): Listing {
  return {
    source: "lun",
    sourceId,
    url,
    title: "Test",
    location: { raw: "Lviv" },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: new Date("2026-09-13T10:00:00Z"),
  };
}

describe("deduplication", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-"));
  const dbPath = join(dir, "test.sqlite");

  afterEach(() => {
    closeDb();
  });

  it("does not treat a repeated source+id as new", () => {
    resetDbForTests(dbPath);
    const first = listing("1", "https://lun.ua/uk/realty/1");
    expect(hasSeenListing(first)).toBe(false);
    saveListing(first);
    expect(hasSeenListing(first)).toBe(true);
    expect(hasSeenListing(listing("1", "https://lun.ua/uk/realty/1?utm=1"))).toBe(true);
  });

  it("falls back to canonical URL", () => {
    resetDbForTests(dbPath);
    saveListing(listing("10", "https://www.lun.ua/uk/realty/abc/"));
    expect(hasSeenListing(listing("99", "https://lun.ua/uk/realty/abc"))).toBe(true);
  });
});
