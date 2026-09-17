import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { extractOlxListingsViaBrowser } from "../src/sources/olx/olx-browser.extract.ts";
import {
  collectOfferLikeObjects,
  extractListingsFromOlxCatalogHtml,
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
      omitLocation: true,
      omitMap: true,
    });
    const result = extractListingsFromOlxCatalogHtml(html);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]?.publishedAt).toBeUndefined();
    expect(result.listings[0]?.location.city).toBeUndefined();
    expect(result.listings[0]?.location.latitude).toBeUndefined();
    expect(result.listings[0]?.sellerType).toBe("unknown");
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
    expect(result.rejections.some((r) => r.reason === "no_structured_html_payload" || r.reason === "dom_fallback_insufficient")).toBe(
      true,
    );
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
  function mockBrowser(html: string, networkOffers?: unknown): Browser {
    let responseHandler: ((response: Response) => void) | undefined;
    const page = {
      on: (event: string, handler: (response: Response) => void) => {
        if (event === "response") {
          responseHandler = handler;
        }
      },
      goto: vi.fn(async () => {
        if (networkOffers) {
          responseHandler?.({
            url: () => "https://www.olx.ua/api/v1/offers/?category_id=1760",
            status: () => 200,
            headers: () => ({ "content-type": "application/json" }),
            json: async () => networkOffers,
          } as unknown as Response);
        }
        // Unrelated JSON probe (diagnostics).
        responseHandler?.({
          url: () => "https://www.olx.ua/api/v1/config/",
          status: () => 200,
          headers: () => ({ "content-type": "application/json" }),
          json: async () => ({ ok: true }),
        } as unknown as Response);
        return {
          status: () => 200,
          headers: () => ({ "content-type": "text/html" }),
        };
      }),
      waitForLoadState: vi.fn(async () => undefined),
      locator: () => ({
        first: () => ({
          isVisible: async () => false,
          click: async () => undefined,
        }),
      }),
      url: () => "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/",
      title: async () => "OLX",
      content: async () => html,
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
    const browser = mockBrowser(olxCatalogHtmlCardsOnly(), offerPayload);
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
});
