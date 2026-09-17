/**
 * Bounded OLX catalog extraction via stock Playwright.
 * Opt-in only — not wired into Telegram delivery until a live Oracle check passes.
 *
 * Parser input priority:
 * 1. original navigation response body (main-document) — contains quoted __PRERENDERED_STATE__
 * 2. rendered DOM (`page.content()`) — Oracle captures showed this drops the assignment
 * 3. intercepted /api/v1/offers JSON when present
 *
 * timeoutMs = per-navigation (page.goto) deadline only.
 * categoryBudgetMs / totalBudgetMs cover goto + settle + parse + capture + cleanup.
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
  OLX_PARSER_MAX_HTML_BYTES,
  sanitizeUrlForLog,
  truncateUtf8Bytes,
  writeOlxCategoryCapture,
  type OlxCategoryCapturePaths,
  type OlxNetworkCaptureMeta,
} from "./olx-browser.capture.ts";
import {
  extractListingsFromOlxBrowserDocuments,
  extractListingAdsFromPrerenderedState,
  inspectPrerenderedState,
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

export type OlxHtmlInputKind = "main_document" | "rendered_dom" | "network_offers_api" | "none";

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
  htmlInputKind?: OlxHtmlInputKind;
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
  /** Wall-clock budget per category including settle/capture/cleanup. Defaults to timeoutMs. */
  categoryBudgetMs?: number;
  /** Wall-clock budget for apartments+houses. Defaults to 2*categoryBudgetMs + 5s. */
  totalBudgetMs?: number;
  maxPagesPerCategory?: number;
  concurrency?: number;
  launch?: () => Promise<Browser>;
  now?: () => Date;
  /** Monotonic-ish clock for deadlines (injectable in tests). */
  clockMs?: () => number;
  captureDir?: string;
  commit?: string;
};

const OFFERS_API_RE = /\/api\/v1\/offers\/?/i;
const MAX_NETWORK_PROBES = 40;
const MIN_CATEGORY_START_MS = 5_000;
const MAX_NETWORKIDLE_MS = 3_000;

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

async function settleWithDeadline(
  tasks: Promise<unknown>[],
  deadlineAt: number,
  clock: () => number,
): Promise<void> {
  const left = remainingMs(deadlineAt, clock());
  if (left <= 0 || tasks.length === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function emptyCategory(
  category: "apartments" | "houses",
  url: string,
  reason: string,
  detail: string,
): OlxBrowserCategoryExtract {
  return {
    category,
    requestedUrl: url,
    finalUrl: url,
    accessibility: "parser_failure",
    accessibilityOk: false,
    apiResponsesCaptured: 0,
    rawOfferCount: 0,
    validatedListingCount: 0,
    listings: [],
    rejections: [{ reason, detail }],
    elapsedMs: 0,
    extractSource: "none",
    timedOut: true,
    htmlInputKind: "none",
  };
}

function expectedCategoryId(category: "apartments" | "houses"): number {
  return category === "apartments" ? 1760 : 330;
}

function relevantStateJsonFromHtml(html: string | undefined): string | undefined {
  if (!html) {
    return undefined;
  }
  const inspection = inspectPrerenderedState(html);
  if (!inspection.complete || inspection.decoded === undefined) {
    return undefined;
  }
  const ads = extractListingAdsFromPrerenderedState(inspection.decoded);
  return `${JSON.stringify(
    {
      path: "listing.listing.ads",
      complete: inspection.complete,
      truncated: inspection.truncated,
      ads,
    },
    null,
    2,
  )}\n`;
}

async function extractCategory(
  browser: Browser,
  category: "apartments" | "houses",
  url: string,
  deps: {
    navigationTimeoutMs: number;
    categoryBudgetMs: number;
    now: () => Date;
    clock: () => number;
    captureDir?: string;
    commit: string;
    runDeadlineAt: number;
  },
): Promise<OlxBrowserCategoryExtract> {
  const started = deps.clock();
  const categoryDeadlineAt = Math.min(started + deps.categoryBudgetMs, deps.runDeadlineAt);
  const rejections: OlxBrowserExtractRejection[] = [];
  const capturedPayloads: unknown[] = [];
  const networkJsonProbes: OlxNetworkJsonProbe[] = [];
  const networkMeta: OlxNetworkCaptureMeta[] = [];
  const pendingTasks: Promise<void>[] = [];
  let mainDocumentHtml: string | undefined;
  let timedOut = false;
  const markTimeout = () => {
    timedOut = true;
  };

  const context = await browser.newContext({ locale: "uk-UA" });
  try {
    if (remainingMs(categoryDeadlineAt, deps.clock()) <= 0) {
      markTimeout();
      return {
        ...emptyCategory(category, url, "category_budget_exhausted", "expired before navigation"),
        elapsedMs: deps.clock() - started,
      };
    }

    const page = await context.newPage();

    page.on("response", (response: Response) => {
      if (deps.clock() >= categoryDeadlineAt) {
        markTimeout();
        return;
      }
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
          networkMeta.push({
            url: sanitizeUrlForLog(responseUrl),
            status: response.status(),
            contentType: contentType.slice(0, 80),
            matchedOffersApi: OFFERS_API_RE.test(responseUrl),
          });
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
      remainingMs(categoryDeadlineAt, deps.clock()),
    );
    if (gotoBudget < 1_000) {
      markTimeout();
      return {
        ...emptyCategory(category, url, "category_budget_exhausted", "insufficient time for navigation"),
        elapsedMs: deps.clock() - started,
      };
    }

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: gotoBudget,
    });

    if (response) {
      pendingTasks.push(
        response
          .text()
          .then((text) => {
            const clipped = truncateUtf8Bytes(text, OLX_PARSER_MAX_HTML_BYTES);
            mainDocumentHtml = clipped.text;
            if (clipped.truncated) {
              rejections.push({
                reason: "main_document_parser_input_truncated",
                detail: `originalBytes=${clipped.bytes}+`,
              });
            }
          })
          .catch(() => {
            rejections.push({
              reason: "main_document_capture_failed",
              detail: "could not read navigation response body",
            });
          }),
      );
    }

    const settleBudget = remainingMs(categoryDeadlineAt, deps.clock());
    if (settleBudget > 200) {
      await page
        .waitForLoadState("networkidle", {
          timeout: Math.min(MAX_NETWORKIDLE_MS, settleBudget),
        })
        .catch(() => undefined);
    } else {
      markTimeout();
    }

    await settleWithDeadline(pendingTasks, categoryDeadlineAt, deps.clock);

    if (deps.clock() >= categoryDeadlineAt) {
      markTimeout();
    }

    let renderedHtml = "";
    const renderBudget = remainingMs(categoryDeadlineAt, deps.clock());
    if (renderBudget > 200) {
      renderedHtml = await page.content();
    } else {
      markTimeout();
    }

    const finalUrl = page.url();
    const title = await page.title();
    const httpStatus = response?.status();
    const contentType = response?.headers()["content-type"];
    const classified = classifyOlxBrowserProbe({
      requestedUrl: url,
      finalUrl,
      title,
      bodyText: renderedHtml || mainDocumentHtml || "",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
    });

    const listings: Listing[] = [];
    let rawOfferCount = 0;
    let extractSource = "none";
    let htmlInputKind: OlxHtmlInputKind = "none";

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
      htmlInputKind = "network_offers_api";
    }

    const htmlExtract = extractListingsFromOlxBrowserDocuments(
      {
        ...(mainDocumentHtml ? { mainDocumentHtml } : {}),
        ...(renderedHtml ? { renderedHtml } : {}),
      },
      deps.now(),
      { expectedCategoryId: expectedCategoryId(category) },
    );

    if (listings.length === 0 && htmlExtract.listings.length > 0) {
      listings.push(...htmlExtract.listings);
      rawOfferCount = Math.max(rawOfferCount, htmlExtract.rawOfferCount);
      extractSource = htmlExtract.source;
      htmlInputKind = htmlExtract.diagnostics.htmlSource ?? "main_document";
    } else if (listings.length === 0) {
      rejections.push(...htmlExtract.rejections);
      htmlInputKind = htmlExtract.diagnostics.htmlSource ?? (mainDocumentHtml ? "main_document" : "rendered_dom");
    }

    if (classified.success && capturedPayloads.length === 0) {
      rejections.push({
        reason: "no_offers_api_payload_captured",
        detail: "page accessible but no /api/v1/offers JSON intercepted",
      });
    }

    let capturePaths: OlxCategoryCapturePaths | undefined;
    if (deps.captureDir) {
      const captureBudget = remainingMs(categoryDeadlineAt, deps.clock());
      if (captureBudget <= 0) {
        markTimeout();
        capturePaths = writeOlxCategoryCapture({
          captureDir: deps.captureDir,
          category,
          commit: deps.commit,
          startedAt: new Date(started).toISOString(),
          requestedUrl: url,
          finalUrl,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          scripts: [],
          cards: [],
          networkMeta,
          skippedReason: "deadline_before_capture",
        });
      } else {
        const relevantStateJson = relevantStateJsonFromHtml(mainDocumentHtml);
        capturePaths = writeOlxCategoryCapture({
          captureDir: deps.captureDir,
          category,
          commit: deps.commit,
          startedAt: new Date(started).toISOString(),
          requestedUrl: url,
          finalUrl,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          ...(mainDocumentHtml !== undefined ? { mainDocumentHtml } : {}),
          ...(renderedHtml ? { renderedHtml } : {}),
          ...(relevantStateJson !== undefined ? { relevantStateJson } : {}),
          scripts: inventoryScriptsFromHtml(renderedHtml || mainDocumentHtml || ""),
          cards: extractCardFragmentsFromHtml(renderedHtml || mainDocumentHtml || ""),
          networkMeta,
        });
      }
    }

    if (deps.clock() >= categoryDeadlineAt) {
      markTimeout();
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
      elapsedMs: deps.clock() - started,
      extractSource,
      htmlDiagnostics: htmlExtract.diagnostics,
      networkJsonProbes,
      htmlInputKind,
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
  const clock = deps.clockMs ?? (() => Date.now());
  const commit = deps.commit ?? "unknown";
  const runStarted = clock();
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
    "html_parser_input=main_document_then_rendered_dom",
    `parserMaxHtmlBytes=${OLX_PARSER_MAX_HTML_BYTES}`,
    `diagnosticMaxHtmlBytes=${DEFAULT_OLX_CAPTURE_LIMITS.maxHtmlBytes}`,
  ];
  let apartments: OlxBrowserCategoryExtract | undefined;
  let houses: OlxBrowserCategoryExtract | undefined;
  try {
    apartments = await extractCategory(browser, "apartments", OLX_BROWSER_APARTMENTS_URL, {
      navigationTimeoutMs,
      categoryBudgetMs,
      now,
      clock,
      commit,
      runDeadlineAt,
      ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
    });
    const remainingForHouses = remainingMs(runDeadlineAt, clock());
    if (remainingForHouses < MIN_CATEGORY_START_MS) {
      notes.push("houses_skipped_total_budget");
      houses = emptyCategory(
        "houses",
        OLX_BROWSER_HOUSES_URL,
        "total_budget_exhausted",
        `remainingMs=${remainingForHouses}`,
      );
    } else {
      houses = await extractCategory(browser, "houses", OLX_BROWSER_HOUSES_URL, {
        navigationTimeoutMs: Math.min(navigationTimeoutMs, remainingForHouses),
        categoryBudgetMs: Math.min(categoryBudgetMs, remainingForHouses),
        now,
        clock,
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
