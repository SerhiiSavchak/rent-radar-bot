import { describe, expect, it, vi } from "vitest";
import { extractOlxListingsViaBrowser } from "../src/sources/olx/olx-browser.extract.ts";
import type { Browser, BrowserContext, Page, Response } from "playwright";

describe("OLX browser extract", () => {
  it("returns validated listings from intercepted offers API and keeps accessibility separate", async () => {
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

    let responseHandler: ((response: Response) => void) | undefined;
    const page = {
      on: (event: string, handler: (response: Response) => void) => {
        if (event === "response") {
          responseHandler = handler;
        }
      },
      goto: vi.fn(async () => {
        responseHandler?.({
          url: () => "https://www.olx.ua/api/v1/offers/?category_id=1760",
          json: async () => offerPayload,
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
      url: () => "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lviv/",
      title: async () => "OLX",
      content: async () =>
        '<html><body data-cy="l-card" class="css-1sw7q4x listing-card">card</body></html>',
    } as unknown as Page;

    const context = {
      newPage: async () => page,
      close: vi.fn(async () => undefined),
    } as unknown as BrowserContext;

    const browser = {
      newContext: async () => context,
      close: vi.fn(async () => undefined),
    } as unknown as Browser;

    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      maxPagesPerCategory: 1,
      launch: async () => browser,
    });

    expect(result.browserClosed).toBe(true);
    expect(browser.close).toHaveBeenCalled();
    expect(result.accessibilityOk).toBe(true);
    expect(result.extractionOk).toBe(true);
    expect(result.listings.length).toBeGreaterThanOrEqual(1);
    expect(result.listings[0]?.sourceId).toBe("555");
    expect(result.listings[0]?.price?.amount).toBe(12000);
    expect(result.listings[0]?.publishedAt?.toISOString()).toBe(
      new Date("2026-09-15T10:00:00+03:00").toISOString(),
    );
    expect(result.listings[0]?.sellerType).toBe("unknown");
  });

  it("does not claim extraction success from accessibility alone", async () => {
    const page = {
      on: vi.fn(),
      goto: vi.fn(async () => ({
        status: () => 200,
        headers: () => ({ "content-type": "text/html" }),
      })),
      waitForLoadState: vi.fn(async () => undefined),
      locator: () => ({
        first: () => ({
          isVisible: async () => false,
          click: async () => undefined,
        }),
      }),
      url: () => "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lviv/",
      title: async () => "OLX",
      content: async () =>
        '<html><body data-cy="l-card" class="css-1sw7q4x listing-card">card</body></html>',
    } as unknown as Page;

    const context = {
      newPage: async () => page,
      close: vi.fn(async () => undefined),
    } as unknown as BrowserContext;

    const browser = {
      newContext: async () => context,
      close: vi.fn(async () => undefined),
    } as unknown as Browser;

    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 5_000,
      launch: async () => browser,
    });

    expect(result.accessibilityOk).toBe(true);
    expect(result.extractionOk).toBe(false);
    expect(result.listings).toHaveLength(0);
    expect(
      result.apartments.rejections.some((r) => r.reason === "no_offers_api_payload_captured"),
    ).toBe(true);
  });
});
