import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import {
  DEFAULT_OLX_CAPTURE_LIMITS,
  extractCardFragmentsFromHtml,
  inventoryScriptsFromHtml,
  isAnalyticsUrl,
  sanitizeHeaders,
  truncateUtf8Bytes,
  writeOlxCategoryCapture,
} from "../src/sources/olx/olx-browser.capture.ts";
import { extractOlxListingsViaBrowser } from "../src/sources/olx/olx-browser.extract.ts";
import { olxCatalogHtmlCardsOnly } from "./fixtures/olx-catalog-html.ts";

describe("OLX browser capture helpers", () => {
  it("sanitizes cookies/authorization and skips analytics hosts", () => {
    expect(
      sanitizeHeaders({
        "content-type": "text/html",
        cookie: "sid=secret",
        Authorization: "Bearer x",
      }),
    ).toEqual({
      "content-type": "text/html",
      cookie: "[REDACTED]",
      Authorization: "[REDACTED]",
    });
    expect(isAnalyticsUrl("https://www.google-analytics.com/g/collect")).toBe(true);
    expect(isAnalyticsUrl("https://www.olx.ua/api/v1/offers/")).toBe(false);
  });

  it("bounds HTML bytes, script inventory, and card fragments", () => {
    const huge = "a".repeat(5_000);
    const clipped = truncateUtf8Bytes(huge, 100);
    expect(clipped.truncated).toBe(true);
    expect(clipped.bytes).toBe(100);

    const html = `<html><body>
      <script id="one" type="application/json">${"x".repeat(500)}</script>
      <script src="https://www.olx.ua/static/app.js"></script>
      <div data-cy="l-card"><a href="/d/uk/obyavlenie/a-ID11aaaa.html">A</a></div>
      <div data-cy="l-card"><a href="/d/uk/obyavlenie/b-ID11bbbb.html">B</a></div>
      <div data-cy="l-card"><a href="/d/uk/obyavlenie/c-ID11cccc.html">C</a></div>
    </body></html>`;
    const scripts = inventoryScriptsFromHtml(html, { ...DEFAULT_OLX_CAPTURE_LIMITS, maxScripts: 1 });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.id).toBe("one");
    expect(scripts[0]?.inlinePreview?.length).toBeLessThanOrEqual(
      DEFAULT_OLX_CAPTURE_LIMITS.maxInlinePreviewChars,
    );

    const cards = extractCardFragmentsFromHtml(html, { ...DEFAULT_OLX_CAPTURE_LIMITS, maxCards: 2 });
    expect(cards).toHaveLength(2);
    expect(cards[0]?.href).toContain("ID11aaaa");
  });

  it("writes capture artifacts and cleans up on failure path (browserClosed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "olx-cap-"));
    try {
      const paths = writeOlxCategoryCapture({
        captureDir: root,
        category: "apartments",
        commit: "deadbeef",
        startedAt: new Date().toISOString(),
        requestedUrl: "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/",
        finalUrl: "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/",
        httpStatus: 200,
        mainDocumentHtml: "<html>main</html>",
        renderedHtml: olxCatalogHtmlCardsOnly(),
        scripts: inventoryScriptsFromHtml(olxCatalogHtmlCardsOnly()),
        cards: extractCardFragmentsFromHtml(olxCatalogHtmlCardsOnly()),
        networkMeta: [
          {
            url: "https://www.google-analytics.com/x",
            status: 200,
            contentType: "text/plain",
            matchedOffersApi: false,
            skippedReason: "analytics_host",
          },
        ],
      });
      expect(readFileSync(paths.manifestPath, "utf8")).toContain("deadbeef");
      expect(readFileSync(paths.mainDocumentPath!, "utf8")).toContain("main");
      expect(readFileSync(paths.renderedHtmlPath!, "utf8")).toContain("data-cy");

      const close = vi.fn(async () => undefined);
      const page = {
        on: vi.fn(),
        goto: vi.fn(async () => {
          throw new Error("nav failed");
        }),
        waitForLoadState: vi.fn(async () => undefined),
        locator: () => ({
          first: () => ({
            isVisible: async () => false,
            click: async () => undefined,
          }),
        }),
        url: () => "about:blank",
        title: async () => "",
        content: async () => "",
      } as unknown as Page;
      const context = {
        newPage: async () => page,
        close: vi.fn(async () => undefined),
      } as unknown as BrowserContext;
      const browser = {
        newContext: async () => context,
        close,
      } as unknown as Browser;

      await expect(
        extractOlxListingsViaBrowser({
          timeoutMs: 5_000,
          categoryBudgetMs: 5_000,
          totalBudgetMs: 10_000,
          launch: async () => browser,
          captureDir: join(root, "run"),
          commit: "deadbeef",
        }),
      ).rejects.toThrow(/nav failed/);
      expect(close).toHaveBeenCalled();
      expect(context.close).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("OLX browser extract budgets + capture wiring", () => {
  function mockBrowser(html: string): Browser {
    let responseHandler: ((response: Response) => void) | undefined;
    const page = {
      on: (event: string, handler: (response: Response) => void) => {
        if (event === "response") {
          responseHandler = handler;
        }
      },
      goto: vi.fn(async () => {
        responseHandler?.({
          url: () => "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/",
          status: () => 200,
          headers: () => ({ "content-type": "text/html" }),
          text: async () => html,
          json: async () => {
            throw new Error("not json");
          },
        } as unknown as Response);
        responseHandler?.({
          url: () => "https://www.google-analytics.com/g/collect",
          status: () => 200,
          headers: () => ({ "content-type": "text/plain" }),
          text: async () => "skip",
          json: async () => ({}),
        } as unknown as Response);
        return {
          status: () => 200,
          headers: () => ({ "content-type": "text/html" }),
          text: async () => html,
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

  it("keeps extractionOk=false for card-only HTML and can write capture dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "olx-cap2-"));
    try {
      const browser = mockBrowser(olxCatalogHtmlCardsOnly());
      const result = await extractOlxListingsViaBrowser({
        timeoutMs: 5_000,
        categoryBudgetMs: 5_000,
        totalBudgetMs: 12_000,
        maxPagesPerCategory: 1,
        launch: async () => browser,
        captureDir: root,
        commit: "abc123",
      });
      expect(result.extractionOk).toBe(false);
      expect(result.listings).toHaveLength(0);
      expect(result.browserClosed).toBe(true);
      expect(result.budgets.navigationTimeoutMs).toBe(5_000);
      expect(result.apartments.htmlInputKind).toBe("rendered_dom");
      expect(result.apartments.capturePaths?.manifestPath).toContain("apartments");
      expect(readFileSync(result.apartments.capturePaths!.manifestPath, "utf8")).toContain("abc123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
