/**
 * Bounded OLX catalog extraction via stock Playwright.
 * Opt-in only — not wired into Telegram delivery until a live Oracle check passes.
 *
 * Separates:
 * - browser accessibility (page/card markers reachable)
 * - extraction success (validated Listing objects)
 *
 * timeoutMs = per-navigation (page.goto) deadline only.
 * categoryBudgetMs = wall-clock budget for one category (goto + settle + capture).
 * totalBudgetMs = wall-clock budget for apartments + houses.
 *
 * HTML used for parsing is the *rendered* DOM (`page.content()`), not the raw
 * navigation body — unless diagnostic capture also stores the main-document text.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Response } from "playwright";
import type { Listing } from "../../domain/listing.ts";
import {
  OLX_BROWSER_APARTMENTS_URL,
  OLX_BROWSER_HOUSES_URL,
  classifyOlxBrowserProbe,
  type OlxBrowserOutcome,
} from "../../probe/olx-browser-classify.ts";
import {
  DEFAULT_OLX_CAPTURE_LIMITS,
  extractCardFragmentsFromHtml,
  inventoryScriptsFromHtml,
  isAnalyticsUrl,
  sanitizeUrlForLog,
  writeOlxCategoryCapture,
  type OlxCategoryCapturePaths,
  type OlxNetworkCaptureMeta,
} from "./olx-browser.capture.ts";
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
  timedOut?: boolean;
  capturePaths?: OlxCategoryCapturePaths;
  htmlInputKind?: "rendered_dom";
};

export type OlxBrowserExtractResult = {
  apartments: OlxBrowserCategoryExtract;
  houses: OlxBrowserCategoryExtract;
  listings: Listing[];
  accessibilityOk: boolean;
  extractionOk: boolean;
  browserClosed: boolean;
  notes: string[];
  captureRootDir?: string;
  budgets: {
    navigationTimeoutMs: number;
    categoryBudgetMs: number;
    totalBudgetMs: number;
  };
};

export type OlxBrowserExtractDeps = {
  /** page.goto timeout only (not total run). */
  timeoutMs: number;
  /** Wall-clock budget per category including settle/capture. Defaults to timeoutMs. */
  categoryBudgetMs?: number;
  /** Wall-clock budget for apartments+houses. Defaults to 2*categoryBudgetMs + 5s. */
  totalBudgetMs?: number;
  /** Max catalog pages per category (bounded; capture runs use 1). */
  maxPagesPerCategory?: number;
  concurrency?: number;
  launch?: () => Promise<Browser>;
  now?: () => Date;
  /** When set, write diagnostic artifacts under this directory. */
  captureDir?: string;
  commit?: string;
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

function remainingMs(deadlineAt: number, nowMs: number): number {
  return Math.max(0, deadlineAt - nowMs);
}

async function extractCategory(
  browser: Browser,
  category: "apartments" | "houses",
  url: string,
  deps: {
    navigationTimeoutMs: number;
    categoryBudgetMs: number;
    maxPages: number;
    now: () => Date;
    captureDir?: string;
    commit: string;
    runDeadlineAt: number;
  },
): Promise<OlxBrowserCategoryExtract> {
  const started = Date.now();
  const categoryDeadlineAt = Math.min(started + deps.categoryBudgetMs, deps.runDeadlineAt);
  const rejections: OlxBrowserExtractRejection[] = [];
  const capturedPayloads: unknown[] = [];
  const networkJsonProbes: OlxNetworkJsonProbe[] = [];
  const networkMeta: OlxNetworkCaptureMeta[] = [];
  const pendingTasks: Promise<void>[] = [];
  let mainDocumentHtml: string | undefined;
  let timedOut = false;
  const context = await browser.newContext({ locale: "uk-UA" });
  try {
    const page = await context.newPage();

    // Listeners BEFORE navigation.
    page.on("response", (response: Response) => {
      const responseUrl = response.url();
      const contentType = response.headers()["content-type"] ?? "";
      const isJson = /json/i.test(contentType) || OFFERS_API_RE.test(responseUrl);
      const analytics = isAnalyticsUrl(responseUrl);

      if (isJson && networkJsonProbes.length < MAX_NETWORK_PROBES) {
        networkJsonProbes.push({
          url: sanitizeUrlForLog(responseUrl),
          status: response.status(),
          contentType: contentType.slice(0, 80),
          matchedOffersApi: OFFERS_API_RE.test(responseUrl),
        });
      }

      if (deps.captureDir && networkMeta.length < DEFAULT_OLX_CAPTURE_LIMITS.maxNetworkMeta) {
        if (analytics) {
          networkMeta.push({
            url: sanitizeUrlForLog(responseUrl),
            status: response.status(),
            contentType: contentType.slice(0, 80),
            matchedOffersApi: false,
            skippedReason: "analytics_host",
          });
        } else if (isJson || OFFERS_API_RE.test(responseUrl)) {
          const meta: OlxNetworkCaptureMeta = {
            url: sanitizeUrlForLog(responseUrl),
            status: response.status(),
            contentType: contentType.slice(0, 80),
            matchedOffersApi: OFFERS_API_RE.test(responseUrl),
          };
          networkMeta.push(meta);
          // Metadata only — do not persist analytics or arbitrary JSON bodies.
        }
      }

      if (!OFFERS_API_RE.test(responseUrl)) {
        return;
      }
      pendingTasks.push(
        response
          .json()
          .then((json) => {
            capturedPayloads.push(json);
          })
          .catch(() => {
            rejections.push({
              reason: "api_json_parse_failed",
              detail: sanitizeUrlForLog(responseUrl).slice(0, 120),
            });
          }),
      );
    });

    const gotoBudget = Math.min(
      deps.navigationTimeoutMs,
      remainingMs(categoryDeadlineAt, Date.now()) || deps.navigationTimeoutMs,
    );
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1_000, gotoBudget),
    });

    if (deps.captureDir && response) {
      pendingTasks.push(
        response
          .text()
          .then((text) => {
            mainDocumentHtml = text;
          })
          .catch(() => {
            rejections.push({
              reason: "main_document_capture_failed",
              detail: "could not read navigation response body",
            });
          }),
      );
    }

    const settleBudget = remainingMs(categoryDeadlineAt, Date.now());
    if (settleBudget > 200) {
      await page
        .waitForLoadState("networkidle", {
          timeout: Math.min(10_000, settleBudget),
        })
        .catch(() => undefined);
    } else {
      timedOut = true;
    }

    // Capture mode / bounded extract: maxPages forced to 1 by caller; keep loop for non-capture.
    for (let p = 1; p < deps.maxPages; p += 1) {
      if (remainingMs(categoryDeadlineAt, Date.now()) < 1_500) {
        timedOut = true;
        break;
      }
      const next = page
        .locator('a[data-cy="pagination-forward"], a[data-testid="pagination-forward"]')
        .first();
      const visible = await next.isVisible().catch(() => false);
      if (!visible) {
        break;
      }
      await next.click({ timeout: Math.min(3_000, remainingMs(categoryDeadlineAt, Date.now())) }).catch(() => undefined);
      await page
        .waitForLoadState("networkidle", {
          timeout: Math.min(5_000, remainingMs(categoryDeadlineAt, Date.now())),
        })
        .catch(() => undefined);
    }

    const settlePad = Math.min(400, remainingMs(categoryDeadlineAt, Date.now()));
    if (settlePad > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, settlePad);
      });
    }
    await Promise.all(pendingTasks);

    if (Date.now() >= categoryDeadlineAt) {
      timedOut = true;
    }

    const finalUrl = page.url();
    const title = await page.title();
    // Parser input = rendered DOM after readiness (not the raw main-document alone).
    const renderedHtml = await page.content();
    const httpStatus = response?.status();
    const contentType = response?.headers()["content-type"];
    const classified = classifyOlxBrowserProbe({
      requestedUrl: url,
      finalUrl,
      title,
      bodyText: renderedHtml,
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
      const parsed = parseOlxOffersPayload(payload, deps.now());
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

    const htmlExtract = extractListingsFromOlxCatalogHtml(renderedHtml, deps.now());
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
        detail: "page accessible but no /api/v1/offers JSON intercepted",
      });
    }

    let capturePaths: OlxCategoryCapturePaths | undefined;
    if (deps.captureDir) {
      capturePaths = writeOlxCategoryCapture({
        captureDir: deps.captureDir,
        category,
        commit: deps.commit,
        startedAt: new Date(started).toISOString(),
        requestedUrl: url,
        finalUrl,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(mainDocumentHtml !== undefined ? { mainDocumentHtml } : {}),
        renderedHtml,
        scripts: inventoryScriptsFromHtml(renderedHtml),
        cards: extractCardFragmentsFromHtml(renderedHtml),
        networkMeta,
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
      htmlInputKind: "rendered_dom",
      timedOut,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(capturePaths ? { capturePaths } : {}),
    };
  } finally {
    await context.close();
  }
}

/**
 * One Chromium launch, apartments then houses (concurrency=1), always close.
 */
export async function extractOlxListingsViaBrowser(
  deps: OlxBrowserExtractDeps,
): Promise<OlxBrowserExtractResult> {
  const navigationTimeoutMs = Math.max(5_000, deps.timeoutMs);
  const categoryBudgetMs = Math.max(5_000, deps.categoryBudgetMs ?? navigationTimeoutMs);
  const totalBudgetMs = Math.max(
    categoryBudgetMs + 5_000,
    deps.totalBudgetMs ?? categoryBudgetMs * 2 + 5_000,
  );
  const maxPages = Math.max(1, Math.min(deps.maxPagesPerCategory ?? 1, 2));
  const now = deps.now ?? (() => new Date());
  const commit = deps.commit ?? "unknown";
  const runStarted = Date.now();
  const runDeadlineAt = runStarted + totalBudgetMs;

  if (deps.captureDir) {
    mkdirSync(deps.captureDir, { recursive: true, mode: 0o700 });
  }

  const launch = deps.launch ?? (() => chromium.launch({ headless: true }));
  const browser = await launch();
  const notes: string[] = [
    "transport=stock_playwright_chromium",
    "opt_in_only=true",
    "not_wired_to_telegram=true",
    `maxPagesPerCategory=${maxPages}`,
    "concurrency=1",
    `navigationTimeoutMs=${navigationTimeoutMs}`,
    `categoryBudgetMs=${categoryBudgetMs}`,
    `totalBudgetMs=${totalBudgetMs}`,
    "html_parser_input=rendered_dom_page.content",
    "main_document_body=diagnostic_capture_only",
  ];
  let apartments: OlxBrowserCategoryExtract | undefined;
  let houses: OlxBrowserCategoryExtract | undefined;
  try {
    apartments = await extractCategory(browser, "apartments", OLX_BROWSER_APARTMENTS_URL, {
      navigationTimeoutMs,
      categoryBudgetMs,
      maxPages,
      now,
      commit,
      runDeadlineAt,
      ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
    });
    const remainingForHouses = remainingMs(runDeadlineAt, Date.now());
    if (remainingForHouses < 3_000) {
      notes.push("houses_skipped_total_budget");
      houses = {
        category: "houses",
        requestedUrl: OLX_BROWSER_HOUSES_URL,
        finalUrl: OLX_BROWSER_HOUSES_URL,
        accessibility: "parser_failure",
        accessibilityOk: false,
        apiResponsesCaptured: 0,
        rawOfferCount: 0,
        validatedListingCount: 0,
        listings: [],
        rejections: [
          {
            reason: "total_budget_exhausted",
            detail: `remainingMs=${remainingForHouses}`,
          },
        ],
        elapsedMs: 0,
        extractSource: "none",
        timedOut: true,
        htmlInputKind: "rendered_dom",
      };
    } else {
      houses = await extractCategory(browser, "houses", OLX_BROWSER_HOUSES_URL, {
        navigationTimeoutMs: Math.min(navigationTimeoutMs, remainingForHouses),
        categoryBudgetMs: Math.min(categoryBudgetMs, remainingForHouses),
        maxPages,
        now,
        commit,
        runDeadlineAt,
        ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
      });
    }
  } finally {
    await browser.close();
  }
  if (!apartments || !houses) {
    throw new Error("OLX browser extract incomplete before browser.close()");
  }

  if (deps.captureDir) {
    writeFileSync(
      join(deps.captureDir, "run-summary.json"),
      `${JSON.stringify(
        {
          commit,
          startedAt: new Date(runStarted).toISOString(),
          finishedAt: new Date().toISOString(),
          budgets: { navigationTimeoutMs, categoryBudgetMs, totalBudgetMs },
          apartments: {
            requestedUrl: apartments.requestedUrl,
            finalUrl: apartments.finalUrl,
            elapsedMs: apartments.elapsedMs,
            timedOut: apartments.timedOut ?? false,
            capturePaths: apartments.capturePaths ?? null,
          },
          houses: {
            requestedUrl: houses.requestedUrl,
            finalUrl: houses.finalUrl,
            elapsedMs: houses.elapsedMs,
            timedOut: houses.timedOut ?? false,
            capturePaths: houses.capturePaths ?? null,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  const listings = dedupeListings([...apartments.listings, ...houses.listings]);
  const accessibilityOk = apartments.accessibilityOk && houses.accessibilityOk;
  const extractionOk = listings.length > 0;
  if (accessibilityOk && !extractionOk) {
    notes.push("accessibility_without_extraction=true");
  }
  notes.push(`apartments_extractSource=${apartments.extractSource ?? "none"}`);
  notes.push(`houses_extractSource=${houses.extractSource ?? "none"}`);
  if (apartments.timedOut || houses.timedOut) {
    notes.push("category_or_total_budget_hit=true");
  }
  return {
    apartments,
    houses,
    listings,
    accessibilityOk,
    extractionOk,
    browserClosed: true,
    notes,
    budgets: { navigationTimeoutMs, categoryBudgetMs, totalBudgetMs },
    ...(deps.captureDir ? { captureRootDir: deps.captureDir } : {}),
  };
}
