import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  emptyOlxBrowserExtractResult,
  mapOlxBrowserExtractToFetchResult,
} from "../src/sources/olx/olx-browser.source.ts";
import { buildOlxPrivateCatalogReport } from "../src/sources/olx/olx-private-catalog.report.ts";
import {
  extractOlxListingsViaBrowser,
  type OlxBrowserExtractResult,
} from "../src/sources/olx/olx-browser.extract.ts";
import { buildOlxBrowserCategoryUrl } from "../src/sources/olx/olx-browser.coverage.ts";
import {
  derivedOracleApartmentBusinessAd,
  derivedOracleApartmentPrivateAd,
  derivedOracleHousePrivateAd,
  type DerivedOlxCatalogAd,
} from "./fixtures/olx-prerendered-oracle-derived.ts";

/**
 * Private-only OLX catalog scan.
 * Completeness is structured totalPages, not createdTime / lastRefreshTime order.
 */

type Pagination = { pageNumber: number; totalPages: number; totalElements: number };

type PrivateCategoryScan = {
  status: string;
  expectedPages: number | null;
  fetchedPages: number[];
  totalElements: number | null;
  uniqueListingIds: number;
  businessLeakCount: number;
  privateFilterContractLeak: boolean;
};

function catalogHtml(ads: unknown[], pagination: Pagination): string {
  const state = { listing: { listing: { ads, ...pagination } } };
  const encoded = JSON.stringify(JSON.stringify(state));
  const first = ads[0] as { url?: string } | undefined;
  return `<!DOCTYPE html><html lang="uk"><head><title>OLX</title></head><body>
<div data-cy="l-card"><a href="${first?.url ?? "/d/uk/obyavlenie/x-ID11aaaa.html"}">card</a></div>
<script>window.__PRERENDERED_STATE__ = ${encoded};</script>
</body></html>`;
}

function apartment(id: number, createdTime: string, business = false): DerivedOlxCatalogAd {
  const base = business ? derivedOracleApartmentBusinessAd() : derivedOracleApartmentPrivateAd();
  return {
    ...base,
    id,
    isBusiness: business,
    createdTime,
    url: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${id}.html`,
    urlPath: `/d/uk/obyavlenie/orenda-ID${id}.html`,
  };
}

function house(id: number): DerivedOlxCatalogAd {
  const base = derivedOracleHousePrivateAd();
  return {
    ...base,
    id,
    isBusiness: false,
    url: `https://www.olx.ua/d/uk/obyavlenie/budynok-ID${id}.html`,
    urlPath: `/d/uk/obyavlenie/budynok-ID${id}.html`,
  };
}

function requestedPage(url: string): number {
  const value = new URL(url).searchParams.get("page");
  return value === null ? 1 : Number(value);
}

function assertPrivateCatalogUrl(url: string, page: number): void {
  const parsed = new URL(url);
  expect(parsed.searchParams.get("search[private_business]")).toBe("private");
  expect(parsed.searchParams.get("search[dist]")).toBe("15");
  expect(parsed.searchParams.get("owner_type")).toBeNull();
  expect(parsed.searchParams.get("search[order]")).toBeNull();
  if (page <= 1) {
    expect(parsed.searchParams.get("page")).toBeNull();
  } else {
    expect(parsed.searchParams.get("page")).toBe(String(page));
  }
}

function privateScan(result: OlxBrowserExtractResult): {
  apartments: PrivateCategoryScan;
  houses: PrivateCategoryScan;
} | undefined {
  return (
    result as OlxBrowserExtractResult & {
      privateScan?: { apartments: PrivateCategoryScan; houses: PrivateCategoryScan };
    }
  ).privateScan;
}

function timeoutError(url: string): Error {
  const err = new Error(
    `page.goto: Timeout 45000ms exceeded.\nCall log:\n  - navigating to "${url}", waiting until "domcontentloaded"`,
  );
  err.name = "TimeoutError";
  return err;
}

function mockCatalog(handler: (url: string) => string | "timeout"): {
  browser: Browser;
  urls: string[];
  launch: () => Promise<Browser>;
} {
  const urls: string[] = [];
  const page = {
    on: vi.fn(),
    route: vi.fn(async () => undefined),
    goto: vi.fn(async (navUrl: string) => {
      urls.push(navUrl);
      const outcome = handler(navUrl);
      if (outcome === "timeout") {
        throw timeoutError(navUrl);
      }
      return {
        url: () => navUrl,
        status: () => 200,
        headers: () => ({ "content-type": "text/html; charset=utf-8" }),
        body: async () => Buffer.from(outcome, "utf8"),
        text: async () => outcome,
      };
    }),
    waitForLoadState: vi.fn(async () => undefined),
    content: vi.fn(async () => "<html></html>"),
    url: () => urls[urls.length - 1] ?? "https://www.olx.ua/",
    title: async () => "OLX",
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  const browser = {
    newContext: async () =>
      ({
        newPage: async () => page,
        close: vi.fn(async () => undefined),
      }) as unknown as BrowserContext,
    close: vi.fn(async () => undefined),
  } as unknown as Browser;
  return { browser, urls, launch: async () => browser };
}

async function scan(handler: (url: string) => string | "timeout"): Promise<{
  result: OlxBrowserExtractResult;
  urls: string[];
}> {
  const mocked = mockCatalog(handler);
  const result = await extractOlxListingsViaBrowser({
    timeoutMs: 5_000,
    categoryBudgetMs: 30_000,
    totalBudgetMs: 60_000,
    cleanupBudgetMs: 1_000,
    launch: mocked.launch,
  });
  return { result, urls: mocked.urls };
}

function housePage(): string {
  return catalogHtml([house(9001)], { pageNumber: 0, totalPages: 1, totalElements: 14 });
}

describe("OLX private-only catalog URL contract", () => {
  it("requests private + 15km for apartments and houses, without owner_type or sort", () => {
    for (const category of ["apartments", "houses"] as const) {
      const first = new URL(buildOlxBrowserCategoryUrl(category));
      expect(first.searchParams.get("search[private_business]")).toBe("private");
      expect(first.searchParams.get("search[dist]")).toBe("15");
      expect(first.searchParams.get("owner_type")).toBeNull();
      expect(first.searchParams.get("search[order]")).toBeNull();
      expect(first.searchParams.get("page")).toBeNull();
      const second = new URL(buildOlxBrowserCategoryUrl(category, { page: 2 }));
      expect(second.searchParams.get("search[private_business]")).toBe("private");
      expect(second.searchParams.get("search[dist]")).toBe("15");
      expect(second.searchParams.get("page")).toBe("2");
      expect(second.searchParams.get("owner_type")).toBeNull();
    }
  });
});

describe("OLX private-only structured full scan", () => {
  it("walks apartments pages 1..4 and houses page 1, dedupes ids, and ignores createdTime order", async () => {
    const { result, urls } = await scan((url) => {
      const page = requestedPage(url);
      if (url.includes("/doma/")) {
        assertPrivateCatalogUrl(url, page);
        return housePage();
      }
      assertPrivateCatalogUrl(url, page);
      const ads =
        page === 1
          ? [apartment(101, "2026-09-01T10:00:00+03:00"), apartment(102, "2026-09-20T10:00:00+03:00")]
          : page === 2
            ? [apartment(102, "2026-08-01T10:00:00+03:00"), apartment(103, "2026-09-28T10:00:00+03:00")]
            : page === 3
              ? [apartment(104, "2026-07-01T10:00:00+03:00")]
              : [apartment(105, "2026-09-29T10:00:00+03:00")];
      return catalogHtml(ads, { pageNumber: page - 1, totalPages: 4, totalElements: 140 });
    });

    const apartmentUrls = urls.filter((url) => url.includes("/kvartiry/"));
    const houseUrls = urls.filter((url) => url.includes("/doma/"));
    expect(apartmentUrls.map(requestedPage)).toEqual([1, 2, 3, 4]);
    expect(houseUrls.map(requestedPage)).toEqual([1]);
    expect(urls.indexOf(apartmentUrls[0]!)).toBeLessThan(urls.indexOf(houseUrls[0]!));

    const ids = result.listings.filter((item) => item.propertyType === "apartment").map((item) => item.sourceId);
    expect(ids).toEqual(["101", "102", "103", "104", "105"]);
    expect(result.listings.some((item) => item.sourceId === "9001")).toBe(true);

    const scanResult = privateScan(result);
    expect(scanResult?.apartments).toMatchObject({
      status: "complete",
      expectedPages: 4,
      fetchedPages: [1, 2, 3, 4],
      totalElements: 140,
      businessLeakCount: 0,
    });
    expect(scanResult?.houses).toMatchObject({
      status: "complete",
      expectedPages: 1,
      fetchedPages: [1],
      totalElements: 14,
      businessLeakCount: 0,
    });
    expect(result.coverage?.coverageTruncated).toBe(false);
    expect(result.coverage?.catchup?.apartment ?? null).toBeNull();
    expect(result.coverage?.catchup?.house ?? null).toBeNull();
    expect(result.notes.some((note) => note.includes("page_cursor_not_used_for_coverage"))).toBe(true);
    expect(result.notes.some((note) => note.includes("private_is_not_owner"))).toBe(true);
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.resultKind).toBe("ok");
    expect(mapped.health.healthy).toBe(true);
  });

  it("stops houses at totalPages=1 even when the page has fewer ads than a platform limit", async () => {
    const { urls } = await scan((url) => {
      const page = requestedPage(url);
      if (url.includes("/doma/")) {
        return catalogHtml([house(9001)], { pageNumber: 0, totalPages: 1, totalElements: 14 });
      }
      return catalogHtml([apartment(101, "2026-09-01T10:00:00+03:00")], {
        pageNumber: page - 1,
        totalPages: 1,
        totalElements: 140,
      });
    });
    expect(urls.filter((url) => url.includes("/kvartiry/")).map(requestedPage)).toEqual([1]);
    expect(urls.filter((url) => url.includes("/doma/")).map(requestedPage)).toEqual([1]);
  });

  it("treats a structured page mismatch as failure, never valid_empty", async () => {
    const { result } = await scan((url) => {
      if (url.includes("/doma/")) {
        return catalogHtml([], { pageNumber: 0, totalPages: 1, totalElements: 0 });
      }
      return catalogHtml([apartment(101, "2026-09-01T10:00:00+03:00")], {
        pageNumber: 1,
        totalPages: 4,
        totalElements: 140,
      });
    });
    expect(privateScan(result)?.apartments.status).toBe("page_mismatch");
    expect(result.listings.some((item) => item.sourceId === "101")).toBe(false);
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.resultKind).not.toBe("valid_empty");
    expect(mapped.resultKind).toBe("parser_failure");
    expect(mapped.health.healthy).toBe(false);
  });

  it("treats missing prerendered state as parser failure, not an empty catalog", async () => {
    const { result, urls } = await scan((url) => {
      if (url.includes("/doma/")) {
        return housePage();
      }
      return `<!DOCTYPE html><html><body><div data-cy="l-card">card</div></body></html>`;
    });
    expect(urls.filter((url) => url.includes("/kvartiry/"))).toHaveLength(1);
    expect(privateScan(result)?.apartments.status).toBe("parser_failure");
    expect(result.listings.some((item) => item.sourceId === "9001")).toBe(true);
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.resultKind).not.toBe("valid_empty");
    expect(mapped.health.healthy).toBe(false);
    expect(mapped.coverage?.coverageTruncated).toBe(true);
  });

  it("keeps earlier pages when page 3 times out and does not claim complete coverage", async () => {
    const { result, urls } = await scan((url) => {
      const page = requestedPage(url);
      if (url.includes("/doma/")) {
        return housePage();
      }
      if (page === 3) {
        return "timeout";
      }
      return catalogHtml([apartment(100 + page, "2026-09-01T10:00:00+03:00")], {
        pageNumber: page - 1,
        totalPages: 4,
        totalElements: 140,
      });
    });
    expect(urls.filter((url) => url.includes("/kvartiry/")).map(requestedPage)).toEqual([1, 2, 3]);
    expect(privateScan(result)?.apartments).toMatchObject({
      status: "navigation_failed",
      expectedPages: 4,
      fetchedPages: [1, 2],
      totalElements: 140,
    });
    expect(result.listings.map((item) => item.sourceId)).toEqual(expect.arrayContaining(["101", "102"]));
    expect(result.listings.some((item) => item.sourceId === "103")).toBe(false);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.coverage?.boundaryReached).toBe(false);
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.resultKind).not.toBe("valid_empty");
    expect(mapped.health.healthy).toBe(false);
  });

  it("marks coverage incomplete when totalPages changes during the scan", async () => {
    const { result, urls } = await scan((url) => {
      const page = requestedPage(url);
      if (url.includes("/doma/")) {
        return housePage();
      }
      const totalPages = page === 1 ? 4 : 6;
      return catalogHtml([apartment(100 + page, "2026-09-01T10:00:00+03:00")], {
        pageNumber: page - 1,
        totalPages,
        totalElements: 140,
      });
    });
    expect(urls.filter((url) => url.includes("/kvartiry/")).map(requestedPage)).toEqual([1, 2]);
    expect(privateScan(result)?.apartments.status).toBe("pagination_unstable");
    expect(privateScan(result)?.apartments.expectedPages).toBe(4);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.coverage?.boundaryReached).toBe(false);
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.health.healthy).toBe(false);
    expect(mapped.resultKind).not.toBe("valid_empty");
  });

  it("rejects a trusted Business card inside the Private catalog and degrades health", async () => {
    const { result } = await scan((url) => {
      if (url.includes("/doma/")) {
        return housePage();
      }
      return catalogHtml(
        [
          apartment(101, "2026-09-01T10:00:00+03:00", false),
          apartment(202, "2026-09-02T10:00:00+03:00", true),
        ],
        { pageNumber: 0, totalPages: 1, totalElements: 2 },
      );
    });
    expect(result.listings.some((item) => item.sourceId === "101")).toBe(true);
    expect(result.listings.some((item) => item.sourceId === "202")).toBe(false);
    expect(privateScan(result)?.apartments).toMatchObject({
      status: "complete",
      businessLeakCount: 1,
      privateFilterContractLeak: true,
    });
    expect(
      result.apartments.rejections.some((item) => item.reason === "olx_private_filter_contract_leak"),
    ).toBe(true);
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.listings.some((item) => item.sourceId === "202")).toBe(false);
    expect(mapped.health.healthy).toBe(false);
    expect(mapped.resultKind).toBe("ok");
    expect(mapped.health.message ?? "").toMatch(/private filter|business/i);
  });

  it("keeps a valid apartments result when houses navigation fails", async () => {
    const { result } = await scan((url) => {
      if (url.includes("/doma/")) {
        return "timeout";
      }
      return catalogHtml([apartment(101, "2026-09-01T10:00:00+03:00")], {
        pageNumber: 0,
        totalPages: 1,
        totalElements: 1,
      });
    });
    expect(result.listings.map((item) => item.sourceId)).toEqual(["101"]);
    expect(privateScan(result)?.apartments.status).toBe("complete");
    expect(privateScan(result)?.houses.status).toBe("navigation_failed");
    expect(result.houses.listings).toHaveLength(0);
    expect(
      result.houses.rejections.some((item) => item.reason === "category_page_navigation_failed"),
    ).toBe(true);
    expect(result.coverage?.coverageTruncated).toBe(true);
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.listings.map((item) => item.sourceId)).toEqual(["101"]);
    expect(mapped.resultKind).not.toBe("valid_empty");
    expect(mapped.health.healthy).toBe(false);
  });

  it("does not report valid_empty when apartments fail and houses are a real empty catalog", async () => {
    const { result } = await scan((url) => {
      if (url.includes("/doma/")) {
        return catalogHtml([], { pageNumber: 0, totalPages: 1, totalElements: 0 });
      }
      return "timeout";
    });
    expect(result.listings).toHaveLength(0);
    expect(privateScan(result)?.apartments.status).toBe("navigation_failed");
    expect(privateScan(result)?.houses.status).toBe("complete");
    expect(result.apartments.rejections.some((item) => item.reason === "category_page_navigation_failed")).toBe(
      true,
    );
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.resultKind).toBe("parser_failure");
    expect(mapped.resultKind).not.toBe("valid_empty");
    expect(mapped.health.healthy).toBe(false);
  });

  it("accepts a structured empty catalog as valid_empty only when both categories complete", async () => {
    const { result } = await scan(() => catalogHtml([], { pageNumber: 0, totalPages: 1, totalElements: 0 }));
    expect(privateScan(result)?.apartments.status).toBe("complete");
    expect(privateScan(result)?.houses.status).toBe("complete");
    expect(result.listings).toHaveLength(0);
    const mapped = mapOlxBrowserExtractToFetchResult(result, { startedMs: Date.now() });
    expect(mapped.resultKind).toBe("valid_empty");
    expect(mapped.health.healthy).toBe(true);
  });
});

describe("OLX private catalog verify report", () => {
  it("reports a rejected Business leak as a complete but degraded run", () => {
    const report = buildOlxPrivateCatalogReport({
      commit: "abc",
      elapsedMs: 12,
      result: emptyOlxBrowserExtractResult({
        privateScan: {
          apartments: {
            status: "complete",
            expectedPages: 4,
            fetchedPages: [1, 2, 3, 4],
            totalElements: 140,
            uniqueListingIds: 1,
            businessLeakCount: 1,
            privateFilterContractLeak: true,
            failureDetails: [],
            pageElapsedMs: [],
          },
          houses: {
            status: "complete",
            expectedPages: 1,
            fetchedPages: [1],
            totalElements: 14,
            uniqueListingIds: 0,
            businessLeakCount: 0,
            privateFilterContractLeak: false,
            failureDetails: [],
            pageElapsedMs: [],
          },
        },
      }),
    });
    expect(report.commit).toBe("abc");
    expect(report.apartmentsExpectedPages).toBe(4);
    expect(report.apartmentsFetchedPages).toEqual([1, 2, 3, 4]);
    expect(report.apartmentsTotalElements).toBe(140);
    expect(report.housesExpectedPages).toBe(1);
    expect(report.housesFetchedPages).toEqual([1]);
    expect(report.housesTotalElements).toBe(14);
    expect(report.businessLeakCount).toBe(1);
    expect(report.parserFailures).toEqual([]);
    expect(report.navigationFailures).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.healthDegraded).toBe(true);
    expect(report.elapsedMs).toBe(12);
  });
});

describe("OLX structured catalog page reader", () => {
  it("reads pageNumber, totalPages and totalElements and rejects a page without them", async () => {
    const mod = await import("../src/sources/olx/olx-browser.html-extract.ts");
    const read = (
      mod as {
        readOlxStructuredCatalogPage?: (state: unknown) => Pagination | undefined;
      }
    ).readOlxStructuredCatalogPage;
    expect(typeof read).toBe("function");
    if (typeof read !== "function") {
      return;
    }
    expect(
      read({
        listing: { listing: { pageNumber: 0, totalPages: 4, totalElements: 140, ads: [] } },
      }),
    ).toEqual({ pageNumber: 1, totalPages: 4, totalElements: 140 });
    expect(
      read({
        listing: { listing: { page_number: 1, total_pages: 4, total_elements: 14, ads: [] } },
      }),
    ).toEqual({ pageNumber: 2, totalPages: 4, totalElements: 14 });
    expect(read({ listing: { listing: { ads: [{ id: 1 }] } } })).toBeUndefined();
    expect(read({ listing: { listing: { pageNumber: 1.5, totalPages: 4, totalElements: 1 } } })).toBeUndefined();
  });
});
