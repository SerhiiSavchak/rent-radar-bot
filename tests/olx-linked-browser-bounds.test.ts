import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCycleOlxSellerVerifier,
  fetchOlxLinkedDetailViaBrowser,
  type OlxLinkedBrowser,
  type OlxLinkedBrowserContext,
  type OlxLinkedBrowserPage,
  type OlxLinkedBrowserResponse,
} from "../src/delivery/olx-detail-seller.ts";
import type { Listing } from "../src/domain/listing.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";

const URL = "https://www.olx.ua/d/obyavlenie/orenda-ID99wRst.html";

function neverResolves<T = void>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function lun(token: string): Listing {
  return {
    source: "lun",
    sourceId: "bound-1",
    url: "https://lun.ua/uk/realty/bound-1",
    title: "Квартира",
    location: { raw: "Львів" },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: new Date("2026-09-25T08:00:00.000Z"),
    publishedAt: new Date("2026-09-25T07:00:00.000Z"),
    metadata: {
      ownerEvidenceLevel: "platform_confirmed",
      originalUrl: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${token}.html`,
    },
  };
}

function mockBrowser(input: {
  responseText?: () => Promise<string>;
  pageContent?: () => Promise<string>;
  pageClose?: () => Promise<void>;
  contextClose?: () => Promise<void>;
  browserClose?: () => Promise<void>;
  status?: number;
}): OlxLinkedBrowser {
  const response: OlxLinkedBrowserResponse = {
    status: () => input.status ?? 200,
    text: input.responseText ?? (async () => "<html>ok</html>"),
  };
  const page: OlxLinkedBrowserPage = {
    goto: async () => response,
    url: () => URL,
    content: input.pageContent ?? (async () => "<html>fallback</html>"),
    close: input.pageClose ?? (async () => undefined),
  };
  const context: OlxLinkedBrowserContext = {
    newPage: async () => page,
    close: input.contextClose ?? (async () => undefined),
  };
  return {
    newContext: async () => context,
    close: input.browserClose ?? (async () => undefined),
  };
}

describe("exact OLX linked browser fallback bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes when response.text never resolves", async () => {
    vi.useFakeTimers();
    const work = fetchOlxLinkedDetailViaBrowser(URL, 5_000, {
      launch: async () =>
        mockBrowser({
          responseText: () => neverResolves(),
          pageContent: async () => derivedOracleOfferDetailHtml({
            id: 1,
            url: URL,
            title: "Квартира",
            description: "Здам",
            user: { name: "Олена", company_name: null, sellerType: null },
            isBusiness: false,
          }),
        }),
      bodyBudgetMs: 40,
      closeBudgetMs: 40,
      launchBudgetMs: 40,
      navigationBudgetMs: 40,
    });
    const resultPromise = work;
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;
    expect(result.notes).toContain("body_read_timeout");
    expect(result.notes).toContain("body_content_fallback_used");
    expect(result.bodyText.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });

  it("completes unresolved when response.text and page.content never resolve", async () => {
    vi.useFakeTimers();
    const work = fetchOlxLinkedDetailViaBrowser(URL, 5_000, {
      launch: async () =>
        mockBrowser({
          responseText: () => neverResolves(),
          pageContent: () => neverResolves(),
        }),
      bodyBudgetMs: 30,
      closeBudgetMs: 30,
      launchBudgetMs: 30,
      navigationBudgetMs: 30,
    });
    await vi.advanceTimersByTimeAsync(250);
    const result = await work;
    expect(result.bodyContentFallbackTimedOut).toBe(true);
    expect(result.bodyText).toBe("");
    expect(result.timedOut).toBe(true);
    expect(result.notes).toContain("body_content_fallback_timeout");
  });

  it("completes when page.close never resolves", async () => {
    vi.useFakeTimers();
    const work = fetchOlxLinkedDetailViaBrowser(URL, 5_000, {
      launch: async () =>
        mockBrowser({
          pageClose: () => neverResolves(),
        }),
      bodyBudgetMs: 30,
      closeBudgetMs: 30,
      launchBudgetMs: 30,
      navigationBudgetMs: 30,
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await work;
    expect(result.pageCloseTimedOut).toBe(true);
    expect(result.browserClosed).toBe(false);
    expect(result.notes.some((note) => note.includes("page.close_timeout"))).toBe(true);
  });

  it("completes when context.close never resolves", async () => {
    vi.useFakeTimers();
    const work = fetchOlxLinkedDetailViaBrowser(URL, 5_000, {
      launch: async () =>
        mockBrowser({
          contextClose: () => neverResolves(),
        }),
      bodyBudgetMs: 30,
      closeBudgetMs: 30,
      launchBudgetMs: 30,
      navigationBudgetMs: 30,
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await work;
    expect(result.contextCloseTimedOut).toBe(true);
    expect(result.browserClosed).toBe(false);
  });

  it("completes when browser.close never resolves", async () => {
    vi.useFakeTimers();
    const work = fetchOlxLinkedDetailViaBrowser(URL, 5_000, {
      launch: async () =>
        mockBrowser({
          browserClose: () => neverResolves(),
        }),
      bodyBudgetMs: 30,
      closeBudgetMs: 30,
      launchBudgetMs: 30,
      navigationBudgetMs: 30,
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await work;
    expect(result.browserCloseTimedOut).toBe(true);
    expect(result.browserClosed).toBe(false);
  });

  it("raw 403 -> browser West Realty still rejects via verifier", async () => {
    const token = "99wRst";
    const html = derivedOracleOfferDetailHtml({
      id: 99,
      url: `https://www.olx.ua/d/obyavlenie/orenda-ID${token}.html`,
      title: "Квартира",
      description: "Здам",
      user: { name: "West Realty", company_name: "West Realty", sellerType: null },
      isBusiness: false,
    });
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-25T08:00:00.000Z"),
      timeoutMs: 5_000,
      fetchPage: async () => ({
        status: 403,
        finalUrl: `https://www.olx.ua/d/obyavlenie/orenda-ID${token}.html`,
        bodyText: "blocked",
      }),
      fetchViaBrowser: async (url) => ({
        status: 200,
        finalUrl: url,
        bodyText: html,
        browserClosed: true,
        browserCloseTimedOut: false,
        pageCloseTimedOut: false,
        contextCloseTimedOut: false,
        bodyContentFallbackTimedOut: false,
        timedOut: false,
        notes: ["test"],
      }),
    });
    const decision = await verify(lun(token));
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_confirmed_agent");
  });

  it("healthy browser path does not invent timeout flags", async () => {
    const result = await fetchOlxLinkedDetailViaBrowser(URL, 5_000, {
      launch: async () => mockBrowser({}),
      bodyBudgetMs: 100,
      closeBudgetMs: 100,
      launchBudgetMs: 100,
      navigationBudgetMs: 100,
    });
    expect(result.timedOut).toBe(false);
    expect(result.browserClosed).toBe(true);
    expect(result.pageCloseTimedOut).toBe(false);
    expect(result.contextCloseTimedOut).toBe(false);
    expect(result.browserCloseTimedOut).toBe(false);
    expect(result.bodyContentFallbackTimedOut).toBe(false);
    expect(result.bodyText).toContain("ok");
  });

  it("empty body after dual read timeout stays unresolved in verifier", async () => {
    const token = "empty1";
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-25T08:00:00.000Z"),
      timeoutMs: 5_000,
      fetchPage: async () => ({
        status: 403,
        finalUrl: `https://www.olx.ua/d/obyavlenie/orenda-ID${token}.html`,
        bodyText: "blocked",
      }),
      fetchViaBrowser: async (url) => ({
        status: 200,
        finalUrl: url,
        bodyText: "",
        browserClosed: true,
        browserCloseTimedOut: false,
        pageCloseTimedOut: false,
        contextCloseTimedOut: false,
        bodyContentFallbackTimedOut: true,
        timedOut: true,
        notes: ["body_content_fallback_timeout"],
      }),
    });
    const decision = await verify(lun(token));
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("detail_transport_failure");
    expect(decision.evidence).not.toMatch(/confirmed owner/i);
  });
});
