/**
 * Shared stock Playwright Chromium probe for OLX catalogs.
 * Not part of production OlxSource. No stealth/proxies/bypass.
 */

import { chromium, type Browser, type Response } from "playwright";
import {
  classifyOlxBrowserProbe,
  OLX_BROWSER_APARTMENTS_URL,
  OLX_BROWSER_HOUSES_URL,
  type OlxBrowserClassification,
  type OlxBrowserOutcome,
} from "./olx-browser-classify.ts";

export type OlxBrowserCategoryReport = {
  category: "apartments" | "houses";
  requestedUrl: string;
  finalUrl: string;
  httpStatus?: number;
  contentType?: string;
  title: string;
  bodyChars: number;
  bodySample: string;
  outcome: OlxBrowserOutcome;
  success: boolean;
  challengeIndicators: string[];
  listingSignals: string[];
  notes: string[];
  elapsedMs: number;
};

export type OlxBrowserProbeResult = {
  apartments: OlxBrowserCategoryReport;
  houses: OlxBrowserCategoryReport;
  overallSuccess: boolean;
  browserClosed: boolean;
};

export type OlxBrowserProbeDeps = {
  timeoutMs: number;
  launch?: () => Promise<Browser>;
};

function sampleBody(html: string, max = 800): string {
  return html.replace(/\s+/g, " ").trim().slice(0, max);
}

async function probeOne(
  browser: Browser,
  category: "apartments" | "houses",
  url: string,
  timeoutMs: number,
): Promise<OlxBrowserCategoryReport> {
  const started = Date.now();
  const context = await browser.newContext({ locale: "uk-UA" });
  try {
    const page = await context.newPage();
    const response: Response | null = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(15_000, timeoutMs) }).catch(() => undefined);

    const finalUrl = page.url();
    const title = await page.title();
    const bodyText = await page.content();
    const httpStatus = response?.status();
    const contentType = response?.headers()["content-type"];

    const classified: OlxBrowserClassification = classifyOlxBrowserProbe({
      requestedUrl: url,
      finalUrl,
      title,
      bodyText,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
    });

    return {
      category,
      requestedUrl: url,
      finalUrl,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      title,
      bodyChars: bodyText.length,
      bodySample: sampleBody(bodyText),
      outcome: classified.outcome,
      success: classified.success,
      challengeIndicators: classified.challengeIndicators,
      listingSignals: classified.listingSignals,
      notes: classified.notes,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await context.close();
  }
}

/**
 * One fresh Chromium launch for apartments + houses, then always close.
 */
export async function probeOlxBrowserOnce(deps: OlxBrowserProbeDeps): Promise<OlxBrowserProbeResult> {
  const launch = deps.launch ?? (() => chromium.launch({ headless: true }));
  const browser = await launch();
  let apartments: OlxBrowserCategoryReport | undefined;
  let houses: OlxBrowserCategoryReport | undefined;
  try {
    apartments = await probeOne(browser, "apartments", OLX_BROWSER_APARTMENTS_URL, deps.timeoutMs);
    houses = await probeOne(browser, "houses", OLX_BROWSER_HOUSES_URL, deps.timeoutMs);
  } finally {
    await browser.close();
  }
  if (!apartments || !houses) {
    throw new Error("OLX browser probe incomplete before browser.close()");
  }
  return {
    apartments,
    houses,
    overallSuccess: apartments.success && houses.success,
    browserClosed: true,
  };
}
