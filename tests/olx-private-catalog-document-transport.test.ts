import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { buildOlxPrivateCatalogReport } from "../src/sources/olx/olx-private-catalog.report.ts";
import { extractOlxListingsViaBrowser } from "../src/sources/olx/olx-browser.extract.ts";
import {
  derivedOracleApartmentPrivateAd,
  derivedOracleHousePrivateAd,
  type DerivedOlxCatalogAd,
} from "./fixtures/olx-prerendered-oracle-derived.ts";

/**
 * Production Private catalog transport: document-only routing and waitUntil commit.
 * A parsed main document must not wait for frontend hydration or /api/v1/offers.
 */

const ABORTED_TYPES = ["image", "font", "media", "stylesheet", "script", "xhr", "fetch", "other"] as const;

type Pagination = { pageNumber: number; totalPages: number; totalElements: number };

function catalogHtml(ads: unknown[], pagination: Pagination): string {
  const state = { listing: { listing: { ads, ...pagination } } };
  const encoded = JSON.stringify(JSON.stringify(state));
  return `<!DOCTYPE html><html lang="uk"><head><title>OLX</title></head><body>
<script>window.__PRERENDERED_STATE__ = ${encoded};</script>
</body></html>`;
}

function apartment(): DerivedOlxCatalogAd {
  const base = derivedOracleApartmentPrivateAd();
  return { ...base, id: 101, isBusiness: false };
}

function house(): DerivedOlxCatalogAd {
  const base = derivedOracleHousePrivateAd();
  return { ...base, id: 9001, isBusiness: false };
}

function timeoutError(url: string): Error {
  const err = new Error(
    `page.goto: Timeout 45000ms exceeded. Call log: navigating to "${url}", waiting until "domcontentloaded"`,
  );
  err.name = "TimeoutError";
  return err;
}

function mockTransport(handler: (url: string) => string | "timeout"): {
  browser: Browser;
  markers: string[];
  route: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  waitForLoadState: ReturnType<typeof vi.fn>;
  pageClose: ReturnType<typeof vi.fn>;
  contextClose: ReturnType<typeof vi.fn>;
} {
  const markers: string[] = [];
  const pageClose = vi.fn(async () => {
    markers.push("page.close");
  });
  const contextClose = vi.fn(async () => {
    markers.push("context.close");
  });
  const waitForLoadState = vi.fn(async (state: string) => {
    markers.push(`wait:${state}`);
  });
  const route = vi.fn(async (pattern: string, _routeHandler: (route: Route) => Promise<void>) => {
    markers.push(`route:${pattern}`);
  });
  const goto = vi.fn(async (navUrl: string, options?: { waitUntil?: string }) => {
    markers.push(`goto:${options?.waitUntil ?? "missing"}`);
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
  });
  const page = {
    on: vi.fn(),
    route,
    goto,
    waitForLoadState,
    content: vi.fn(async () => "<html></html>"),
    url: () => "https://www.olx.ua/",
    title: async () => "OLX",
    close: pageClose,
  } as unknown as Page;
  const browser = {
    newContext: async () =>
      ({
        newPage: async () => page,
        close: contextClose,
      }) as unknown as BrowserContext,
    close: vi.fn(async () => undefined),
  } as unknown as Browser;
  return { browser, markers, route, goto, waitForLoadState, pageClose, contextClose };
}

async function run(handler: (url: string) => string | "timeout") {
  const mocked = mockTransport(handler);
  const result = await extractOlxListingsViaBrowser({
    timeoutMs: 5_000,
    categoryBudgetMs: 30_000,
    totalBudgetMs: 60_000,
    cleanupBudgetMs: 1_000,
    launch: async () => mocked.browser,
  });
  return { ...mocked, result };
}

function onePageCatalog(url: string): string {
  if (url.includes("/doma/")) {
    return catalogHtml([house()], { pageNumber: 0, totalPages: 1, totalElements: 14 });
  }
  return catalogHtml([apartment()], { pageNumber: 0, totalPages: 1, totalElements: 140 });
}

describe("OLX private catalog document transport", () => {
  it("installs document-only routing before commit navigation and aborts subresources", async () => {
    const { markers, route, goto } = await run(onePageCatalog);
    const routeMarks = markers.filter((mark) => mark.startsWith("route:"));
    const gotoMarks = markers.filter((mark) => mark.startsWith("goto:"));
    expect(routeMarks.length).toBe(gotoMarks.length);
    expect(routeMarks.length).toBeGreaterThan(0);
    expect(gotoMarks.every((mark) => mark === "goto:commit")).toBe(true);
    for (let index = 0; index < markers.length; index += 1) {
      if (!markers[index]?.startsWith("goto:")) {
        continue;
      }
      let previous: string | undefined;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (markers[cursor]?.startsWith("route:")) {
          previous = markers[cursor];
          break;
        }
      }
      expect(previous).toBe("route:**/*");
    }
    expect(goto.mock.calls.every((call) => (call[1] as { waitUntil?: string }).waitUntil === "commit")).toBe(
      true,
    );

    const routeHandler = route.mock.calls[0]?.[1] as
      | ((route: Route) => Promise<void>)
      | undefined;
    expect(routeHandler).toBeTypeOf("function");
    const continued: string[] = [];
    const aborted: string[] = [];
    const fake = (type: string): Route =>
      ({
        request: () => ({ resourceType: () => type }),
        continue: async () => {
          continued.push(type);
        },
        abort: async () => {
          aborted.push(type);
        },
      }) as unknown as Route;
    await routeHandler!(fake("document"));
    for (const type of ABORTED_TYPES) {
      await routeHandler!(fake(type));
    }
    expect(continued).toEqual(["document"]);
    expect(aborted).toEqual([...ABORTED_TYPES]);
  });

  it("does not wait for networkidle or offers API after a successful main-document parse", async () => {
    const { result, waitForLoadState, pageClose, contextClose } = await run(onePageCatalog);
    expect(result.extractionOk).toBe(true);
    expect(result.privateScan?.apartments.status).toBe("complete");
    expect(result.privateScan?.houses.status).toBe("complete");
    expect(waitForLoadState).not.toHaveBeenCalled();
    expect(
      result.apartments.rejections.some((item) => item.reason === "no_offers_api_payload_captured"),
    ).toBe(false);
    expect(
      result.houses.rejections.some((item) => item.reason === "no_offers_api_payload_captured"),
    ).toBe(false);
    expect(result.apartments.apiResponsesCaptured).toBe(0);
    expect(pageClose).toHaveBeenCalled();
    expect(contextClose).toHaveBeenCalled();
    expect(result.browserClosed).toBe(true);
  });

  it("treats a structured empty main document as parsed and skips networkidle", async () => {
    const { result, waitForLoadState } = await run(() =>
      catalogHtml([], { pageNumber: 0, totalPages: 1, totalElements: 0 }),
    );
    expect(result.privateScan?.apartments.status).toBe("complete");
    expect(result.privateScan?.houses.status).toBe("complete");
    expect(waitForLoadState).not.toHaveBeenCalled();
    expect(
      result.apartments.rejections.some((item) => item.reason === "no_offers_api_payload_captured"),
    ).toBe(false);
  });

  it("keeps navigation_failed isolated and reports a short per-page detail", async () => {
    const { result } = await run((url) => (url.includes("/doma/") ? "timeout" : onePageCatalog(url)));
    expect(result.privateScan?.apartments.status).toBe("complete");
    expect(result.privateScan?.houses.status).toBe("navigation_failed");
    expect(result.listings.some((listing) => listing.sourceId === "101")).toBe(true);
    expect(result.listings.some((listing) => listing.propertyType === "house")).toBe(false);

    const report = buildOlxPrivateCatalogReport({
      commit: "transport",
      elapsedMs: result.wallClockMs,
      result,
    });
    expect(report.navigationFailures).toEqual(["houses"]);
    expect(report.parserFailures).toEqual([]);
    expect(report.apartmentsFailureDetails).toEqual([]);
    expect(report.housesFailureDetails).toHaveLength(1);
    expect(report.housesFailureDetails[0]).toMatchObject({
      page: 1,
      reason: "category_page_navigation_failed",
    });
    const detail = report.housesFailureDetails[0]?.detail ?? "";
    expect(detail).toMatch(/Timeout|page\.goto/);
    expect(detail).not.toMatch(/https?:\/\//);
    expect(detail.length).toBeLessThanOrEqual(180);
    expect(detail).not.toContain("__PRERENDERED_STATE__");
    expect(report.apartmentsPageElapsedMs).toHaveLength(1);
    expect(report.housesPageElapsedMs).toHaveLength(1);
    expect(report.apartmentsPageElapsedMs[0]).toBeGreaterThanOrEqual(0);
    expect(report.housesPageElapsedMs[0]).toBeGreaterThanOrEqual(0);
    expect(report.complete).toBe(false);
  });

  it("does not drop a completed houses scan when apartments navigation fails", async () => {
    const { result } = await run((url) => (url.includes("/kvartiry/") ? "timeout" : onePageCatalog(url)));
    expect(result.privateScan?.apartments.status).toBe("navigation_failed");
    expect(result.privateScan?.houses.status).toBe("complete");
    expect(result.listings.some((listing) => listing.sourceId === "9001")).toBe(true);
    const report = buildOlxPrivateCatalogReport({
      commit: "transport",
      elapsedMs: 1,
      result,
    });
    expect(report.navigationFailures).toEqual(["apartments"]);
    expect(report.apartmentsFailureDetails[0]?.page).toBe(1);
    expect(report.apartmentsFailureDetails[0]?.reason).toBe("category_page_navigation_failed");
    expect(report.housesFailureDetails).toEqual([]);
    expect(report.housesFetchedPages).toEqual([1]);
  });
});
