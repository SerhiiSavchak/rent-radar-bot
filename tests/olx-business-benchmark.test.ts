import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isOlxBusinessFullScanDue } from "../src/sources/olx/olx-browser.coverage.ts";
import type { OlxBrowserExtractResult } from "../src/sources/olx/olx-browser.extract.ts";
import {
  OLX_BUSINESS_BENCHMARK_BUDGETS,
  OLX_BUSINESS_BENCHMARK_HOT_AGE_MS,
  planOlxBusinessBenchmark,
  summarizeOlxBusinessBenchmark,
} from "../src/scripts/oracle-olx-browser-extract.ts";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const scriptSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/scripts/oracle-olx-browser-extract.ts"),
  "utf8",
);

describe("OLX business benchmark plan", () => {
  it("treats full mode as a due snapshot with no timestamp", () => {
    const plan = planOlxBusinessBenchmark("full", NOW);
    expect(plan.benchmarkMode).toBe("full");
    expect(plan.fullSnapshotDue).toBe(true);
    expect(plan.businessApartmentMode).toBe("full");
    expect("businessLastFullScanAt" in plan).toBe(false);
    expect(isOlxBusinessFullScanDue(undefined, NOW)).toBe(true);
  });

  it("supplies a recent in-memory timestamp so apartments stay hot", () => {
    const plan = planOlxBusinessBenchmark("hot", NOW);
    expect(plan.benchmarkMode).toBe("hot");
    expect(plan.businessLastFullScanAt).toBe(
      new Date(NOW.getTime() - OLX_BUSINESS_BENCHMARK_HOT_AGE_MS).toISOString(),
    );
    expect(plan.fullSnapshotDue).toBe(false);
    expect(plan.businessApartmentMode).toBe("hot");
    expect(isOlxBusinessFullScanDue(new Date(plan.businessLastFullScanAt ?? ""), NOW)).toBe(false);
  });

  it("keeps production acquisition budgets", () => {
    expect(OLX_BUSINESS_BENCHMARK_BUDGETS).toEqual({
      navigationTimeoutMs: 45_000,
      categoryBudgetMs: 180_000,
      totalBudgetMs: 360_000,
    });
  });

  it("has no Telegram, SQLite, or service-control dependency", () => {
    expect(scriptSource).not.toMatch(/from ["'][^"']*telegram/);
    expect(scriptSource).not.toMatch(/node:sqlite|better-sqlite3|sqlite3/);
    expect(scriptSource).not.toMatch(/DATABASE_PATH/);
    expect(scriptSource).not.toMatch(/schema_meta/);
    expect(scriptSource).not.toMatch(/systemctl/);
    expect(scriptSource).not.toMatch(/process\.env\.[A-Z0-9_]+\s*=[^=]/);
    expect(scriptSource).toContain("extractOlxListingsViaBrowser");
    expect(scriptSource).toContain("businessLastFullScanAt");
  });

  it("summarizes coverage without listing bodies", () => {
    const plan = planOlxBusinessBenchmark("hot", NOW);
    const summary = summarizeOlxBusinessBenchmark({
      pid: 42,
      commit: "abc",
      plan,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      result: {
        listings: [],
        wallClockMs: 10,
        budgetExceeded: false,
        browserClosed: true,
        privateScan: {
          apartments: {
            status: "complete",
            expectedPages: 4,
            fetchedPages: [1, 2, 3, 4],
            totalElements: 140,
            uniqueListingIds: 140,
          },
          houses: {
            status: "complete",
            expectedPages: 1,
            fetchedPages: [1],
            totalElements: 14,
            uniqueListingIds: 14,
          },
        },
        businessScan: {
          apartments: {
            mode: "hot",
            status: "complete",
            fullCoverage: false,
            pageCoverageComplete: false,
            parserCoverageHealthy: true,
            expectedPages: 25,
            fetchedPages: [1],
            totalElements: 1000,
            uniqueListingIds: 40,
            ceilingExceeded: false,
            failureDetails: [],
            parser: { rejectionReasonCounts: { duplicate_id: 3, adapt_failed_missing_id_or_title: 1 } },
          },
          houses: {
            mode: "full",
            status: "complete",
            fullCoverage: true,
            pageCoverageComplete: true,
            parserCoverageHealthy: true,
            expectedPages: 2,
            fetchedPages: [1, 2],
            totalElements: 70,
            uniqueListingIds: 28,
            ceilingExceeded: false,
            failureDetails: [],
            parser: { rejectionReasonCounts: {} },
          },
        },
        businessFullScan: {
          due: false,
          succeeded: false,
          pagesExpected: 25,
          pagesFetched: 1,
          ageStatus: "healthy",
        },
      } as unknown as OlxBrowserExtractResult,
    });
    expect(summary.benchmarkMode).toBe("hot");
    expect(summary.pid).toBe(42);
    expect(summary.businessApartments.fetchedPages).toEqual([1]);
    expect(summary.businessApartments.mode).toBe("hot");
    expect(summary.businessFullScan.previousTimestampInput).toBe(plan.businessLastFullScanAt);
    expect(summary.parser).toEqual({
      meaningfulFailureCount: 1,
      reasons: { adapt_failed_missing_id_or_title: 1 },
    });
    expect(summary.total).toEqual({ listingsReturned: 0, pagesFetched: 8 });
    expect(JSON.stringify(summary)).not.toContain("sampleListings");
  });
});
