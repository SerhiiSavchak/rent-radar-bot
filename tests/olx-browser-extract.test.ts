import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { extractOlxListingsViaBrowser, isOlxCategoryHtmlResponse } from "../src/sources/olx/olx-browser.extract.ts";
import { OLX_BROWSER_APARTMENTS_URL } from "../src/probe/olx-browser-classify.ts";
import {
  collectOfferLikeObjects,
  extractListingsFromOlxBrowserDocuments,
  extractListingsFromOlxCatalogHtml,
  inspectPrerenderedState,
  normalizeEmbeddedOlxAd,
  parsePrerenderedState,
} from "../src/sources/olx/olx-browser.html-extract.ts";
import {
  olxCatalogHtmlCardsOnly,
  olxCatalogHtmlWithEmbeddedOffersApiShape,
  olxCatalogHtmlWithMalformedPrerendered,
  olxCatalogHtmlWithNextDataOffers,
  olxCatalogHtmlWithPrerenderedOffers,
} from "./fixtures/olx-catalog-html.ts";
import {
  derivedOracleApartmentBusinessAd,
  derivedOracleApartmentPrivateAd,
  derivedOracleHousePrivateAd,
  derivedOracleMainDocumentHtml,
  derivedOracleMalformedPrerenderedHtml,
  derivedOracleRenderedHtmlWithoutState,
  derivedOracleTruncatedMainDocumentHtml,
} from "./fixtures/olx-prerendered-oracle-derived.ts";

describe("OLX HTML structured extract", () => {
  it("extracts validated listings from __PRERENDERED_STATE__", () => {
    const html = olxCatalogHtmlWithPrerenderedOffers();
    const state = parsePrerenderedState(html);
    expect(state).toBeTruthy();
    expect(collectOfferLikeObjects(state).length).toBe(1);

    const result = extractListingsFromOlxCatalogHtml(html);
    expect(result.source).toBe("prerendered_state");
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]?.sourceId).toBe("934944232");
    expect(result.listings[0]?.price?.amount).toBe(14000);
    expect(result.listings[0]?.publishedAt?.toISOString()).toBe(
      new Date("2026-09-15T10:00:00+03:00").toISOString(),
    );
    expect(result.listings[0]?.refreshedAt?.toISOString()).toBe(
      new Date("2026-09-16T10:00:00+03:00").toISOString(),
    );
    expect(result.listings[0]?.location.city).toBe("Львів");
    expect(result.listings[0]?.sellerType).toBe("unknown");
  });

  it("keeps missing seller/date/geo as unknown without inventing values", () => {
    const html = olxCatalogHtmlWithPrerenderedOffers({
      omitCreatedTime: true,
      omitMap: true,
    });
    const result = extractListingsFromOlxCatalogHtml(html);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]?.publishedAt).toBeUndefined();
    expect(result.listings[0]?.location.latitude).toBeUndefined();
    expect(result.listings[0]?.sellerType).toBe("unknown");
  });

  it("rejects prerendered ads without a city label", () => {
    const html = olxCatalogHtmlWithPrerenderedOffers({ omitLocation: true });
    const result = extractListingsFromOlxCatalogHtml(html);
    expect(result.listings).toHaveLength(0);
    expect(result.rejections.some((r) => r.reason === "rejected_missing_location")).toBe(true);
  });

  it("rejects card markers alone", () => {
    const result = extractListingsFromOlxCatalogHtml(olxCatalogHtmlCardsOnly());
    expect(result.listings).toHaveLength(0);
    expect(result.source).toBe("none");
    expect(result.rejections.some((r) => r.reason === "dom_fallback_insufficient")).toBe(true);
    expect(result.rejections.some((r) => r.reason === "no_structured_html_payload")).toBe(true);
  });

  it("records malformed prerendered payload", () => {
    const result = extractListingsFromOlxCatalogHtml(olxCatalogHtmlWithMalformedPrerendered());
    expect(result.listings).toHaveLength(0);
    expect(
      result.rejections.some(
        (r) =>
          r.reason === "prerendered_state_truncated" ||
          r.reason === "prerendered_state_malformed" ||
          r.reason === "no_structured_html_payload" ||
          r.reason === "dom_fallback_insufficient",
      ),
    ).toBe(true);
  });

  it("parses embedded offers API shape and Next data", () => {
    const apiShape = extractListingsFromOlxCatalogHtml(olxCatalogHtmlWithEmbeddedOffersApiShape());
    expect(apiShape.source).toBe("embedded_offers_api_shape");
    expect(apiShape.listings[0]?.sourceId).toBe("111");

    const next = extractListingsFromOlxCatalogHtml(olxCatalogHtmlWithNextDataOffers());
    expect(next.source).toBe("next_data");
    expect(next.listings[0]?.sourceId).toBe("222");
    expect(next.listings[0]?.sellerType).toBe("business");
  });

  it("normalizes cityName-style location without inventing ownership", () => {
    const normalized = normalizeEmbeddedOlxAd({
      id: 1,
      title: "Тест",
      url: "https://www.olx.ua/d/uk/obyavlenie/t-ID11aaaa.html",
      created_time: "2026-09-15T10:00:00+03:00",
      isBusiness: false,
      location: { cityName: "Львів", districtName: "Сихів" },
      price: { value: 9000, currency: "UAH" },
    }) as Record<string, unknown>;
    expect((normalized.location as { city?: { name?: string } })?.city?.name).toBe("Львів");
    expect(Array.isArray(normalized.params)).toBe(true);
    expect(normalized.business).toBe(false);
  });
});

describe("OLX browser extract integration", () => {
  function mockBrowser(
    renderedHtml: string,
    options?: { networkOffers?: unknown; mainDocumentHtml?: string },
  ): Browser {
    let responseHandler: ((response: Response) => void) | undefined;
    const mainHtml = options?.mainDocumentHtml ?? renderedHtml;
    let lastUrl =
      "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/";
    const page = {
      on: (event: string, handler: (response: Response) => void) => {
        if (event === "response") {
          responseHandler = handler;
        }
      },
      goto: vi.fn(async (navUrl: string) => {
        lastUrl = navUrl;
        if (options?.networkOffers) {
          responseHandler?.({
            url: () => "https://www.olx.ua/api/v1/offers/?category_id=1760",
            status: () => 200,
            headers: () => ({ "content-type": "application/json" }),
            json: async () => options.networkOffers,
            text: async () => JSON.stringify(options.networkOffers),
            body: async () => Buffer.from(JSON.stringify(options.networkOffers), "utf8"),
          } as unknown as Response);
        }
        responseHandler?.({
          url: () => "https://www.olx.ua/api/v1/config/",
          status: () => 200,
          headers: () => ({ "content-type": "application/json" }),
          json: async () => ({ ok: true }),
          text: async () => "{\"ok\":true}",
          body: async () => Buffer.from("{\"ok\":true}", "utf8"),
        } as unknown as Response);
        return {
          url: () => navUrl,
          status: () => 200,
          headers: () => ({ "content-type": "text/html; charset=utf-8" }),
          text: async () => mainHtml,
          body: async () => Buffer.from(mainHtml, "utf8"),
        };
      }),
      waitForLoadState: vi.fn(async () => undefined),
      locator: () => ({
        first: () => ({
          isVisible: async () => false,
          click: async () => undefined,
        }),
      }),
      url: () => lastUrl,
      title: async () => "OLX",
      content: async () => renderedHtml,
      close: vi.fn(async () => undefined),
    } as unknown as Page;

    const context = {
      newPage: async () => page,
      close: vi.fn(async () => undefined),
    } as unknown as BrowserContext;

    return {
      newContext: async () => context,
      close: vi.fn(async () => undefined),
    } as unknown as Browser;
  }

  it("returns validated listings from intercepted offers API", async () => {
    const offerPayload = {
      data: [
        {
          id: 555,
          title: "Квартира тест",
          url: "https://www.olx.ua/d/uk/obyavlenie/test-ID11abcd.html",
          created_time: "2026-09-15T10:00:00+03:00",
          last_refresh_time: "2026-09-16T10:00:00+03:00",
          business: false,
          params: [{ key: "price", value: { value: 12000, currency: "UAH" } }],
          location: { city: { name: "Львів" } },
        },
      ],
    };
    const browser = mockBrowser(olxCatalogHtmlCardsOnly(), { networkOffers: offerPayload });
    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      maxPagesPerCategory: 1,
      launch: async () => browser,
    });
    expect(result.extractionOk).toBe(true);
    expect(result.listings[0]?.sourceId).toBe("555");
    expect(result.apartments.extractSource).toBe("network_offers_api");
    expect(result.browserClosed).toBe(true);
  });

  it("extracts from prerendered HTML when network offers API is absent (Oracle failure mode)", async () => {
    const browser = mockBrowser(olxCatalogHtmlWithPrerenderedOffers());
    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      launch: async () => browser,
    });
    expect(result.accessibilityOk).toBe(true);
    expect(result.apartments.apiResponsesCaptured).toBe(0);
    expect(result.extractionOk).toBe(true);
    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.apartments.extractSource).toBe("prerendered_state");
    expect(result.apartments.rejections.some((r) => r.reason === "no_offers_api_payload_captured")).toBe(
      true,
    );
  });

  it("does not claim extraction success from accessibility / card markers alone", async () => {
    const browser = mockBrowser(olxCatalogHtmlCardsOnly());
    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      launch: async () => browser,
    });
    expect(result.accessibilityOk).toBe(true);
    expect(result.extractionOk).toBe(false);
    expect(result.listings).toHaveLength(0);
    expect(
      result.apartments.rejections.some((r) => r.reason === "dom_fallback_insufficient"),
    ).toBe(true);
    expect(result.apartments.networkJsonProbes?.some((p) => p.url.includes("/api/v1/config/"))).toBe(
      true,
    );
  });

  it("reads quoted prerendered state from the original document when rendered DOM dropped it", async () => {
    const ads = [derivedOracleApartmentPrivateAd()];
    const browser = mockBrowser(derivedOracleRenderedHtmlWithoutState(ads), {
      mainDocumentHtml: derivedOracleMainDocumentHtml(ads),
    });
    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      launch: async () => browser,
    });
    expect(inspectPrerenderedState(derivedOracleRenderedHtmlWithoutState(ads)).present).toBe(false);
    expect(result.extractionOk).toBe(true);
    expect(result.apartments.htmlInputKind).toBe("main_document");
    expect(result.apartments.extractSource).toBe("prerendered_state");
    expect(result.listings[0]?.sourceId).toBe("935081899");
    expect(result.listings[0]?.price?.amount).toBe(53650);
  });

  it("fails if the extractor silently uses rendered DOM when goto() HTML body has the state", async () => {
    const ads = [derivedOracleApartmentPrivateAd()];
    const main = derivedOracleMainDocumentHtml(ads);
    const rendered = derivedOracleRenderedHtmlWithoutState(ads);
    let contentCalled = false;
    let lastUrl = OLX_BROWSER_APARTMENTS_URL;
    const pageClose = vi.fn(async () => undefined);
    const contextClose = vi.fn(async () => undefined);
    const browserClose = vi.fn(async () => undefined);
    const page = {
      on: vi.fn(),
      goto: vi.fn(async (navUrl: string) => {
        lastUrl = navUrl;
        expect(
          isOlxCategoryHtmlResponse({
            requestedUrl: navUrl,
            responseUrl: navUrl,
            contentType: "text/html; charset=utf-8",
          }),
        ).toBe(true);
        return {
          url: () => navUrl,
          status: () => 200,
          headers: () => ({ "content-type": "text/html; charset=utf-8" }),
          body: async () => {
            if (contentCalled) {
              throw new Error("response.body() was read after page.content()");
            }
            return Buffer.from(main, "utf8");
          },
          text: async () => {
            throw new Error("response.text() must not be the production parser input");
          },
        };
      }),
      waitForLoadState: vi.fn(async () => undefined),
      content: async () => {
        contentCalled = true;
        return rendered;
      },
      url: () => lastUrl,
      title: async () => "OLX",
      close: pageClose,
    } as unknown as Page;
    const browser = {
      newContext: async () => ({
        newPage: async () => page,
        close: contextClose,
      }),
      close: browserClose,
    } as unknown as Browser;

    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      launch: async () => browser,
    });
    expect(result.apartments.htmlInputKind).toBe("main_document");
    expect(result.apartments.extractSource).toBe("prerendered_state");
    expect(result.extractionOk).toBe(true);
    expect(result.listings[0]?.sourceId).toBe("935081899");
    expect(result.browserClosed).toBe(true);
  });
});

describe("OLX Oracle-derived prerendered catalog adapter", () => {
  it("maps camelCase catalog fields without inventing ownership", () => {
    const html = derivedOracleMainDocumentHtml([
      derivedOracleApartmentPrivateAd(),
      derivedOracleApartmentBusinessAd(),
    ]);
    const result = extractListingsFromOlxCatalogHtml(html, new Date(), { expectedCategoryId: 1760 });
    expect(result.source).toBe("prerendered_state");
    expect(result.listings).toHaveLength(2);

    const priv = result.listings.find((item) => item.sourceId === "935081899");
    expect(priv?.sellerType).toBe("unknown");
    expect(priv?.sellerEvidence?.some((item) => item.includes("private account"))).toBe(true);
    expect(priv?.metadata?.filterConsidersPrivateOwner).toBe(false);
    expect(priv?.metadata?.olxUserSellerType).toBeNull();
    expect(priv?.metadata?.coordinatesApproximate).toBe(true);
    expect(priv?.metadata?.coordinatesShowDetailed).toBe(false);
    expect(priv?.publishedAt?.toISOString()).toBe(new Date("2026-09-17T08:34:26+03:00").toISOString());
    expect(priv?.refreshedAt?.toISOString()).toBe(new Date("2026-09-17T08:40:09+03:00").toISOString());
    expect(priv?.metadata?.publishedAtProvenance).toBe("olx.createdTime");
    expect(priv?.metadata?.pushupTime).toBeUndefined();
    expect(priv?.location.city).toBe("Львів");
    expect(priv?.propertyType).toBe("apartment");

    const biz = result.listings.find((item) => item.sourceId === "931996810");
    expect(biz?.sellerType).toBe("business");
    expect(biz?.metadata?.pushupTime).toBe("2026-09-17T10:27:55+03:00");
    expect(result.diagnostics.ownerEligibleCount).toBe(0);
    expect(result.diagnostics.freshnessEligibleCount).toBe(2);
  });

  it("deduplicates by source + listing id and keeps old createdTime separate from refresh", () => {
    const stale = derivedOracleApartmentBusinessAd();
    const html = derivedOracleMainDocumentHtml([stale, { ...stale }, derivedOracleApartmentPrivateAd()]);
    const result = extractListingsFromOlxCatalogHtml(html, new Date(), { expectedCategoryId: 1760 });
    expect(result.listings).toHaveLength(2);
    expect(result.diagnostics.rawObjectCount).toBe(3);
    expect(result.diagnostics.uniqueIdCount).toBe(2);
    const biz = result.listings.find((item) => item.sourceId === "931996810");
    expect(biz?.publishedAt?.toISOString()).toBe(new Date("2026-08-17T01:13:35+03:00").toISOString());
    expect(biz?.refreshedAt?.toISOString()).toBe(new Date("2026-09-17T10:27:55+03:00").toISOString());
  });

  it("maps house private-account ads without treating title phrasing as ownership", () => {
    const html = derivedOracleMainDocumentHtml([derivedOracleHousePrivateAd()]);
    const result = extractListingsFromOlxCatalogHtml(html, new Date(), { expectedCategoryId: 330 });
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]?.propertyType).toBe("house");
    expect(result.listings[0]?.sellerType).toBe("unknown");
    expect(result.diagnostics.ownerEligibleCount).toBe(0);
  });

  it("does not recover listings from truncated quoted state", () => {
    const truncated = derivedOracleTruncatedMainDocumentHtml();
    expect(inspectPrerenderedState(truncated).truncated).toBe(true);
    const result = extractListingsFromOlxBrowserDocuments({
      mainDocumentHtml: truncated,
      renderedHtml: derivedOracleRenderedHtmlWithoutState([derivedOracleApartmentPrivateAd()]),
    });
    expect(result.listings).toHaveLength(0);
    expect(result.rejections.some((item) => item.reason === "prerendered_state_truncated")).toBe(true);
  });

  it("records malformed closed quoted state", () => {
    const result = extractListingsFromOlxCatalogHtml(derivedOracleMalformedPrerenderedHtml());
    expect(result.listings).toHaveLength(0);
    expect(
      result.rejections.some(
        (item) =>
          item.reason === "prerendered_state_malformed" || item.reason === "prerendered_state_truncated",
      ),
    ).toBe(true);
  });
});

describe("OLX browser extract deadlines", () => {
  it("cancels hanging navigation at the total deadline, skips houses, and closes the browser", async () => {
    const pageClose = vi.fn(async () => {
      hungReject?.(new Error("Target closed"));
    });
    const contextClose = vi.fn(async () => undefined);
    const browserClose = vi.fn(async () => undefined);
    let hungReject: ((error: Error) => void) | undefined;
    const page = {
      on: vi.fn(),
      goto: vi.fn(
        () =>
          new Promise((_, reject) => {
            hungReject = reject;
          }),
      ),
      waitForLoadState: vi.fn(async () => undefined),
      content: vi.fn(async () => ""),
      url: () => "about:blank",
      title: async () => "",
      close: pageClose,
    } as unknown as Page;
    const browser = {
      newContext: async () => ({
        newPage: async () => page,
        close: contextClose,
      }),
      close: browserClose,
    } as unknown as Browser;

    const started = Date.now();
    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 80,
      categoryBudgetMs: 80,
      totalBudgetMs: 80,
      launch: async () => browser,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3_000);
    expect(result.apartments.timedOut).toBe(true);
    expect(result.houses.rejections.some((item) => item.reason === "total_budget_exhausted")).toBe(true);
    expect(result.houses.timedOut).toBe(true);
    expect(result.browserClosed).toBe(true);
    expect(pageClose).toHaveBeenCalled();
    expect(contextClose).toHaveBeenCalled();
    expect(browserClose).toHaveBeenCalled();
    expect(result.notes.some((item) => item.includes("houses_skipped_total_budget"))).toBe(true);
  });
});
