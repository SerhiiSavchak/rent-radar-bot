import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/storage/migrations.ts";
import {
  assessOlxBrowserWalk,
  buildOlxBrowserCategoryUrl,
  crossedOlxPublicationBoundary,
  OLX_BROWSER_PAGE_BUDGET,
  organicPublicationTimes,
  planOlxBrowserPages,
} from "../src/sources/olx/olx-browser.coverage.ts";
import { OLX_DISTANCE_KM } from "../src/sources/olx/olx.source.ts";
import {
  ListingDecisionTraceBuffer,
  listingDecisionTraceHas,
} from "../src/delivery/listing-decision-trace.ts";
import { parseDomriaSearchIds } from "../src/sources/domria/domria-newest.ts";

describe("OLX browser coverage contract", () => {
  it("builds long-term Lviv URLs with verified 15km + newest-first controls", () => {
    const apartments = buildOlxBrowserCategoryUrl("apartments");
    const houses = buildOlxBrowserCategoryUrl("houses");
    expect(apartments).toContain("/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/");
    expect(houses).toContain("/doma/arenda-domov/lvov/");
    expect(apartments).toContain(`search%5Bdist%5D=${OLX_DISTANCE_KM}`);
    expect(apartments).toContain("search%5Border%5D=created_at%3Adesc");
    expect(buildOlxBrowserCategoryUrl("apartments", { page: 2 })).toContain("page=2");
    expect(planOlxBrowserPages({}).length).toBe(OLX_BROWSER_PAGE_BUDGET);
  });

  it("does not stop a walk because one promoted/old card appears alone", () => {
    const watermark = new Date("2026-09-25T12:00:00.000Z");
    const organic = organicPublicationTimes([
      {
        publishedAt: new Date("2026-09-20T12:00:00.000Z"),
        metadata: { olxIsPromoted: true },
      },
      { publishedAt: new Date("2026-09-25T11:50:00.000Z") },
    ]);
    expect(organic).toHaveLength(1);
    expect(crossedOlxPublicationBoundary(organic, watermark)).toBe(false);
    const assessed = assessOlxBrowserWalk({
      plannedPages: [1, 2],
      fetchedPages: [1],
      lastPageCardCount: 40,
      crossedBoundary: false,
      failed: false,
    });
    expect(assessed.coverageTruncated).toBe(true);
    expect(assessed.boundaryReached).toBe(false);
  });

  it("marks budget exhaustion as truncated, empty page as boundary reached", () => {
    expect(
      assessOlxBrowserWalk({
        plannedPages: [1, 2],
        fetchedPages: [1, 2],
        lastPageCardCount: 30,
        crossedBoundary: false,
        failed: false,
      }).coverageTruncated,
    ).toBe(true);
    expect(
      assessOlxBrowserWalk({
        plannedPages: [1, 2],
        fetchedPages: [1],
        lastPageCardCount: 0,
        crossedBoundary: false,
        failed: false,
      }).boundaryReached,
    ).toBe(true);
  });
});

describe("listing decision trace", () => {
  it("distinguishes collected-but-rejected from never-observed", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const trace = new ListingDecisionTraceBuffer(42);
    trace.record("olx", "111", "collected", "source_fetch");
    trace.record("olx", "111", "rejected_seller", "intermediary");
    expect(trace.flush(db)).toBe(2);
    expect(listingDecisionTraceHas(db, { source: "olx", sourceId: "111", stage: "collected" })).toBe(
      true,
    );
    expect(
      listingDecisionTraceHas(db, { source: "olx", sourceId: "111", stage: "rejected_seller" }),
    ).toBe(true);
    expect(listingDecisionTraceHas(db, { source: "olx", sourceId: "999" })).toBe(false);
  });
});

describe("DIM.RIA searchEngine parse distinctions", () => {
  it("keeps empty items as ok/empty and HTML/missing structure as parser failure", () => {
    expect(parseDomriaSearchIds('{"count":0,"items":[]}')).toEqual({
      ok: true,
      ids: [],
      empty: true,
    });
    expect(parseDomriaSearchIds("<!DOCTYPE html><html></html>").ok).toBe(false);
    if (!parseDomriaSearchIds("<html></html>").ok) {
      const failed = parseDomriaSearchIds("<html></html>");
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.reason).toBe("html_page_not_search_json");
      }
    }
    expect(parseDomriaSearchIds('{"count":1}').ok).toBe(false);
  });
});
