/**
 * Bounded OLX catalog extraction via stock Playwright.
 * Opt-in only — not wired into Telegram delivery until a live Oracle check passes.
 *
 * Separates:
 * - browser accessibility (page/card markers reachable)
 * - extraction success (validated Listing objects)
 *
 * Oracle evidence (2026-09-17): HTML 200 + card markers, but apiResponsesCaptured=0.
 * Catalog SSR often embeds offers in __PRERENDERED_STATE__ without a client /api/v1/offers call.
 */

import { chromium, type Browser, type Response } from "playwright";
import type { Listing } from "../../domain/listing.ts";
import {
  OLX_BROWSER_APARTMENTS_URL,
  OLX_BROWSER_HOUSES_URL,
  classifyOlxBrowserProbe,
  type OlxBrowserOutcome,
} from "../../probe/olx-browser-classify.ts";
import {
  extractListingsFromOlxCatalogHtml,
  type OlxHtmlExtractDiagnostics,
} from "./olx-browser.html-extract.ts";
import { parseOlxOffersPayload } from "./olx.parser.ts";

export type OlxBrowserExtractRejection = {
  reason: string;
  detail?: string;
};

export type OlxNetworkJsonProbe = {
  url: string;
  status: number;
  contentType: string;
  matchedOffersApi: boolean;
};

export type OlxBrowserCategoryExtract = {
  category: "apartments" | "houses";
  requestedUrl: string;
  finalUrl: string;
  accessibility: OlxBrowserOutcome;
  accessibilityOk: boolean;
  apiResponsesCaptured: number;
  rawOfferCount: number;
  validatedListingCount: number;
  listings: Listing[];
  rejections: OlxBrowserExtractRejection[];
  elapsedMs: number;
  httpStatus?: number;
  extractSource?: string;
  htmlDiagnostics?: OlxHtmlExtractDiagnostics;
  networkJsonProbes?: OlxNetworkJsonProbe[];
};

export type OlxBrowserExtractResult = {
  apartments: OlxBrowserCategoryExtract;
  houses: OlxBrowserCategoryExtract;
  listings: Listing[];
  accessibilityOk: boolean;
  extractionOk: boolean;
  browserClosed: boolean;
  notes: string[];
};

export type OlxBrowserExtractDeps = {
  timeoutMs: number;
  /** Max catalog pages per category (bounded). */
  maxPagesPerCategory?: number;
  /** Max concurrent pages (hard-capped at 1 for Oracle Micro). */
  concurrency?: number;
  launch?: () => Promise<Browser>;
  now?: () => Date;
};

const OFFERS_API_RE = /\/api\/v1\/offers\/?/i;
const MAX_NETWORK_PROBES = 40;

function dedupeListings(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  return listings.filter((listing) => {
    const key = `${listing.source}:${listing.sourceId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function extractCategory(
  browser: Browser,
  category: "apartments" | "houses",
  url: string,
  timeoutMs: number,
  maxPages: number,
  now: () => Date,
): Promise<OlxBrowserCategoryExtract> {
  const started = Date.now();
  const rejections: OlxBrowserExtractRejection[] = [];
  const capturedPayloads: unknown[] = [];
  const networkJsonProbes: OlxNetworkJsonProbe[] = [];
  const pendingJson: Promise<void>[] = [];
  const context = await browser.newContext({ locale: "uk-UA" });
  try {
    const page = await context.newPage();
    page.on("response", (response: Response) => {
      const responseUrl = response.url();
      const contentType = response.headers()["content-type"] ?? "";
      const isJson = /json/i.test(contentType) || OFFERS_API_RE.test(responseUrl);
      if (!isJson) {
        return;
      }
      if (networkJsonProbes.length < MAX_NETWORK_PROBES) {
        networkJsonProbes.push({
          url: responseUrl.slice(0, 240),
          status: response.status(),
          contentType: contentType.slice(0, 80),
          matchedOffersApi: OFFERS_API_RE.test(responseUrl),
        });
      }
      if (!OFFERS_API_RE.test(responseUrl)) {
        return;
      }
      pendingJson.push(
        response
          .json()
          .then((json) => {
            capturedPayloads.push(json);
          })
          .catch(() => {
            rejections.push({
              reason: "api_json_parse_failed",
              detail: responseUrl.slice(0, 120),
            });
          }),
      );
    });

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(15_000, timeoutMs) }).catch(() => undefined);

    for (let p = 1; p < maxPages; p += 1) {
      const next = page.locator('a[data-cy="pagination-forward"], a[data-testid="pagination-forward"]').first();
      const visible = await next.isVisible().catch(() => false);
      if (!visible) {
        break;
      }
      await next.click({ timeout: Math.min(5_000, timeoutMs) }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: Math.min(10_000, timeoutMs) }).catch(() => undefined);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    await Promise.all(pendingJson);

    const finalUrl = page.url();
    const title = await page.title();
    const bodyText = await page.content();
    const httpStatus = response?.status();
    const contentType = response?.headers()["content-type"];
    const classified = classifyOlxBrowserProbe({
      requestedUrl: url,
      finalUrl,
      title,
      bodyText,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
    });

    const listings: Listing[] = [];
    let rawOfferCount = 0;
    let extractSource = "none";

    for (const payload of capturedPayloads) {
      const data = (payload as { data?: unknown })?.data;
      if (Array.isArray(data)) {
        rawOfferCount += data.length;
      }
      const parsed = parseOlxOffersPayload(payload, now());
      listings.push(...parsed);
      if (Array.isArray(data) && data.length > 0 && parsed.length === 0) {
        rejections.push({
          reason: "offers_failed_schema_validation",
          detail: `raw=${data.length}`,
        });
      }
    }
    if (listings.length > 0) {
      extractSource = "network_offers_api";
    }

    const htmlExtract = extractListingsFromOlxCatalogHtml(bodyText, now());
    if (listings.length === 0 && htmlExtract.listings.length > 0) {
      listings.push(...htmlExtract.listings);
      rawOfferCount = Math.max(rawOfferCount, htmlExtract.rawOfferCount);
      extractSource = htmlExtract.source;
    } else if (listings.length === 0) {
      rejections.push(...htmlExtract.rejections);
    }

    if (classified.success && capturedPayloads.length === 0) {
      rejections.push({
        reason: "no_offers_api_payload_captured",
        detail: "page accessible but no /api/v1/offers JSON intercepted (SSR may embed state instead)",
      });
    }

    const unique = dedupeListings(listings);
    return {
      category,
      requestedUrl: url,
      finalUrl,
      accessibility: classified.outcome,
      accessibilityOk: classified.success,
      apiResponsesCaptured: capturedPayloads.length,
      rawOfferCount,
      validatedListingCount: unique.length,
      listings: unique,
      rejections,
      elapsedMs: Date.now() - started,
      extractSource,
      htmlDiagnostics: htmlExtract.diagnostics,
      networkJsonProbes,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  } finally {
    await context.close();
  }
}

/**
 * One Chromium launch, apartments then houses (concurrency hard-capped at 1), always close.
 */
export async function extractOlxListingsViaBrowser(
  deps: OlxBrowserExtractDeps,
): Promise<OlxBrowserExtractResult> {
  const maxPages = Math.max(1, Math.min(deps.maxPagesPerCategory ?? 1, 2));
  const now = deps.now ?? (() => new Date());
  const launch = deps.launch ?? (() => chromium.launch({ headless: true }));
  const browser = await launch();
  const notes: string[] = [
    "transport=stock_playwright_chromium",
    "opt_in_only=true",
    "not_wired_to_telegram=true",
    `maxPagesPerCategory=${maxPages}`,
    "concurrency=1",
    "html_sources=prerendered_state|next_data|embedded_offers_api_shape",
  ];
  let apartments: OlxBrowserCategoryExtract | undefined;
  let houses: OlxBrowserCategoryExtract | undefined;
  try {
    apartments = await extractCategory(
      browser,
      "apartments",
      OLX_BROWSER_APARTMENTS_URL,
      deps.timeoutMs,
      maxPages,
      now,
    );
    houses = await extractCategory(
      browser,
      "houses",
      OLX_BROWSER_HOUSES_URL,
      deps.timeoutMs,
      maxPages,
      now,
    );
  } finally {
    await browser.close();
  }
  if (!apartments || !houses) {
    throw new Error("OLX browser extract incomplete before browser.close()");
  }
  const listings = dedupeListings([...apartments.listings, ...houses.listings]);
  const accessibilityOk = apartments.accessibilityOk && houses.accessibilityOk;
  const extractionOk = listings.length > 0;
  if (accessibilityOk && !extractionOk) {
    notes.push("accessibility_without_extraction=true");
  }
  notes.push(`apartments_extractSource=${apartments.extractSource ?? "none"}`);
  notes.push(`houses_extractSource=${houses.extractSource ?? "none"}`);
  return {
    apartments,
    houses,
    listings,
    accessibilityOk,
    extractionOk,
    browserClosed: true,
    notes,
  };
}
