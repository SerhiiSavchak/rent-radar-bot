import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { readOlxStructuredCatalogPage } from "../src/sources/olx/olx-browser.html-extract.ts";
import { extractOlxListingsViaBrowser } from "../src/sources/olx/olx-browser.extract.ts";
import { buildOlxPrivateCatalogReport } from "../src/sources/olx/olx-private-catalog.report.ts";
import {
  derivedOracleApartmentPrivateAd,
  derivedOracleHousePrivateAd,
  type DerivedOlxCatalogAd,
} from "./fixtures/olx-prerendered-oracle-derived.ts";

/**
 * Live OLX `listing.listing.pageNumber` is 0-based.
 * `OlxStructuredCatalogPage.pageNumber` is the 1-based logical page.
 */

type RawPage = { pageNumber: number; totalPages: number; totalElements: number };

function state(page: Partial<RawPage> & { ads?: unknown[] }) {
  return { listing: { listing: { ads: [], ...page } } };
}

function catalogHtml(ads: unknown[], page: RawPage): string {
  const encoded = JSON.stringify(JSON.stringify({ listing: { listing: { ads, ...page } } }));
  return `<!DOCTYPE html><html lang="uk"><head><title>OLX</title></head><body>
<script>window.__PRERENDERED_STATE__ = ${encoded};</script>
</body></html>`;
}

function apartment(id: number): DerivedOlxCatalogAd {
  const base = derivedOracleApartmentPrivateAd();
  return {
    ...base,
    id,
    isBusiness: false,
    url: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${id}.html`,
    urlPath: `/d/uk/obyavlenie/orenda-ID${id}.html`,
  };
}

function house(): DerivedOlxCatalogAd {
  const base = derivedOracleHousePrivateAd();
  return {
    ...base,
    id: 9001,
    isBusiness: false,
    url: "https://www.olx.ua/d/uk/obyavlenie/budynok-ID9001.html",
    urlPath: "/d/uk/obyavlenie/budynok-ID9001.html",
  };
}

function requestedPage(url: string): number {
  const value = new URL(url).searchParams.get("page");
  return value === null ? 1 : Number(value);
}

async function scan(handler: (url: string) => string): Promise<{
  urls: string[];
  result: Awaited<ReturnType<typeof extractOlxListingsViaBrowser>>;
}> {
  const urls: string[] = [];
  const page = {
    on: vi.fn(),
    route: vi.fn(async () => undefined),
    goto: vi.fn(async (navUrl: string) => {
      urls.push(navUrl);
      const html = handler(navUrl);
      return {
        url: () => navUrl,
        status: () => 200,
        headers: () => ({ "content-type": "text/html; charset=utf-8" }),
        body: async () => Buffer.from(html, "utf8"),
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
  const result = await extractOlxListingsViaBrowser({
    timeoutMs: 5_000,
    categoryBudgetMs: 30_000,
    totalBudgetMs: 60_000,
    cleanupBudgetMs: 1_000,
    launch: async () => browser,
  });
  return { urls, result };
}

describe("OLX structured page index", () => {
  it("normalizes a live zero-based pageNumber once to a 1-based logical page", () => {
    expect(readOlxStructuredCatalogPage(state({ pageNumber: 0, totalPages: 4, totalElements: 140 }))).toEqual({
      pageNumber: 1,
      totalPages: 4,
      totalElements: 140,
    });
    expect(readOlxStructuredCatalogPage(state({ pageNumber: 1, totalPages: 4, totalElements: 140 }))).toEqual({
      pageNumber: 2,
      totalPages: 4,
      totalElements: 140,
    });
    expect(readOlxStructuredCatalogPage(state({ pageNumber: 3, totalPages: 4, totalElements: 140 }))).toEqual({
      pageNumber: 4,
      totalPages: 4,
      totalElements: 140,
    });
    expect(
      readOlxStructuredCatalogPage(
        state({ page_number: 0, total_pages: 1, total_elements: 14 } as unknown as RawPage),
      ),
    ).toEqual({ pageNumber: 1, totalPages: 1, totalElements: 14 });
  });

  it("rejects a negative, missing, or non-integer pageNumber and keeps totalPages rules", () => {
    expect(readOlxStructuredCatalogPage(state({ pageNumber: -1, totalPages: 4, totalElements: 140 }))).toBeUndefined();
    expect(readOlxStructuredCatalogPage(state({ totalPages: 4, totalElements: 140 }))).toBeUndefined();
    expect(readOlxStructuredCatalogPage(state({ pageNumber: 1.5, totalPages: 4, totalElements: 1 }))).toBeUndefined();
    expect(readOlxStructuredCatalogPage(state({ pageNumber: 0, totalPages: 0, totalElements: 140 }))).toBeUndefined();
    expect(readOlxStructuredCatalogPage(state({ pageNumber: 0, totalPages: 4, totalElements: -1 }))).toBeUndefined();
    expect(readOlxStructuredCatalogPage(state({ pageNumber: 0, totalPages: 1, totalElements: 0 }))).toEqual({
      pageNumber: 1,
      totalPages: 1,
      totalElements: 0,
    });
  });

  it("matches request page 1 to raw 0 and request page 4 to raw 3", async () => {
    const seenRaw: number[] = [];
    const { urls, result } = await scan((url) => {
      const logical = requestedPage(url);
      if (url.includes("/doma/")) {
        return catalogHtml([house()], { pageNumber: 0, totalPages: 1, totalElements: 14 });
      }
      const raw = logical - 1;
      seenRaw.push(raw);
      return catalogHtml([apartment(100 + logical)], {
        pageNumber: raw,
        totalPages: 4,
        totalElements: 140,
      });
    });
    expect(urls.filter((url) => url.includes("/kvartiry/")).map(requestedPage)).toEqual([1, 2, 3, 4]);
    expect(seenRaw).toEqual([0, 1, 2, 3]);
    expect(urls.filter((url) => url.includes("/doma/")).map(requestedPage)).toEqual([1]);
    expect(result.privateScan?.apartments).toMatchObject({
      status: "complete",
      expectedPages: 4,
      fetchedPages: [1, 2, 3, 4],
      totalElements: 140,
    });
    expect(result.privateScan?.houses).toMatchObject({
      status: "complete",
      expectedPages: 1,
      fetchedPages: [1],
      totalElements: 14,
    });
    const report = buildOlxPrivateCatalogReport({ commit: "index", elapsedMs: 1, result });
    expect(report.apartmentsFailureDetails).toEqual([]);
    expect(report.housesFailureDetails).toEqual([]);
    expect(report.parserFailures).toEqual([]);
  });

  it("still rejects a genuine mismatch and does not call raw 0 a missing state", async () => {
    const { result } = await scan((url) => {
      if (url.includes("/doma/")) {
        return catalogHtml([house()], { pageNumber: 0, totalPages: 1, totalElements: 14 });
      }
      return catalogHtml([apartment(101)], { pageNumber: 1, totalPages: 4, totalElements: 140 });
    });
    expect(result.privateScan?.apartments.status).toBe("page_mismatch");
    expect(result.privateScan?.houses.status).toBe("complete");
    expect(result.listings.some((item) => item.sourceId === "101")).toBe(false);
    expect(result.listings.some((item) => item.sourceId === "9001")).toBe(true);
    const report = buildOlxPrivateCatalogReport({ commit: "index", elapsedMs: 1, result });
    expect(report.apartmentsFailureDetails[0]?.reason).toBe("olx_page_mismatch");
    expect(report.apartmentsFailureDetails.some((item) => item.reason === "olx_structured_state_missing")).toBe(
      false,
    );
  });

  it("labels malformed pagination separately when prerendered state is present", async () => {
    const { result } = await scan((url) => {
      if (url.includes("/doma/")) {
        return catalogHtml([house()], { pageNumber: 0, totalPages: 1, totalElements: 14 });
      }
      return catalogHtml([apartment(101)], { pageNumber: -1, totalPages: 4, totalElements: 140 });
    });
    expect(result.privateScan?.apartments.status).toBe("parser_failure");
    expect(result.listings.some((item) => item.sourceId === "101")).toBe(true);
    const report = buildOlxPrivateCatalogReport({ commit: "index", elapsedMs: 1, result });
    expect(report.apartmentsFailureDetails[0]?.reason).toBe("olx_pagination_invalid");
    expect(report.apartmentsFailureDetails[0]?.reason).not.toBe("olx_structured_state_missing");
    expect(result.privateScan?.houses.status).toBe("complete");
  });
});
