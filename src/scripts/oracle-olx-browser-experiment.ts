/**
 * Isolated OLX browser probe for Oracle Always Free (or any Node 22 host).
 *
 * - Uses stock Playwright Chromium only (no stealth, proxies, CAPTCHA solvers,
 *   fingerprint spoofing, or WAF bypass).
 * - Does not call or modify the production OlxSource HTTP adapter.
 * - One bounded cycle: apartments + houses catalog pages.
 * - No Telegram, database, scheduler, or polling loop.
 *
 * Env:
 *   OLX_BROWSER_OUT_DIR   default evidence/phase-1/oracle-olx-browser
 *   OLX_BROWSER_TIMEOUT_MS default 45000
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Response } from "playwright";
import {
  classifyOlxBrowserProbe,
  OLX_BROWSER_APARTMENTS_URL,
  OLX_BROWSER_HOUSES_URL,
  type OlxBrowserClassification,
} from "../probe/olx-browser-classify.ts";

const outDir = process.env.OLX_BROWSER_OUT_DIR ?? "evidence/phase-1/oracle-olx-browser";
const timeoutMs = Math.max(5_000, Number(process.env.OLX_BROWSER_TIMEOUT_MS ?? "45000"));

type Category = "apartments" | "houses";

type CategoryReport = {
  category: Category;
  requestedUrl: string;
  finalUrl: string;
  httpStatus?: number;
  contentType?: string;
  title: string;
  bodyChars: number;
  bodySample: string;
  outcome: OlxBrowserClassification["outcome"];
  success: boolean;
  challengeIndicators: string[];
  listingSignals: string[];
  notes: string[];
  elapsedMs: number;
};

function sampleBody(html: string, max = 1200): string {
  return html.replace(/\s+/g, " ").trim().slice(0, max);
}

async function probeCategory(category: Category, url: string): Promise<CategoryReport> {
  const started = Date.now();
  // Default Chromium launch — no stealth plugins, no custom fingerprint flags.
  const browser = await chromium.launch({
    headless: true,
  });
  try {
    const context = await browser.newContext({
      // Stock Playwright Chromium UA; do not spoof a different browser brand.
      locale: "uk-UA",
    });
    const page = await context.newPage();
    let documentResponse: Response | null = null;

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    documentResponse = response;
    // Best-effort settle; do not fail the probe if the page keeps background requests.
    await page.waitForLoadState("networkidle", { timeout: Math.min(15_000, timeoutMs) }).catch(() => undefined);

    const finalUrl = page.url();
    const title = await page.title();
    const bodyText = await page.content();
    const httpStatus = documentResponse?.status();
    const contentType = documentResponse?.headers()["content-type"];

    const classified = classifyOlxBrowserProbe({
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
    await browser.close();
  }
}

mkdirSync(outDir, { recursive: true });

console.log(
  JSON.stringify({
    message: "oracle-olx-browser-experiment.start",
    outDir,
    timeoutMs,
    node: process.version,
    note: "Stock Playwright Chromium only; no bypass techniques.",
    startedAt: new Date().toISOString(),
  }),
);

const apartments = await probeCategory("apartments", OLX_BROWSER_APARTMENTS_URL);
const houses = await probeCategory("houses", OLX_BROWSER_HOUSES_URL);

const report = {
  experiment: "oracle-olx-browser",
  cycle: 1,
  capturedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  constraints: {
    proxies: false,
    stealthPlugins: false,
    captchaSolving: false,
    ipRotation: false,
    fingerprintSpoofing: false,
    wafBypass: false,
    productionAdapterTouched: false,
  },
  apartments,
  houses,
  overallSuccess: apartments.success && houses.success,
  overallOutcomes: {
    apartments: apartments.outcome,
    houses: houses.outcome,
  },
};

const path = join(outDir, "cycle-1.json");
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  JSON.stringify({
    message: "oracle-olx-browser-experiment.done",
    path,
    overallSuccess: report.overallSuccess,
    overallOutcomes: report.overallOutcomes,
    finishedAt: new Date().toISOString(),
  }),
);

process.exitCode = report.overallSuccess ? 0 : 1;
