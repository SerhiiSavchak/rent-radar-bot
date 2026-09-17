/**
 * Bounded OLX catalog extraction via stock Playwright.
 * Opt-in only — not wired into Telegram delivery until a live Oracle check passes.
 *
 * Parser input priority:
 * 1. original page.goto() response body (`response.body()`), read before page.content()
 * 2. rendered DOM (`page.content()`) — diagnostic / fallback only when the original body
 *    has no `__PRERENDERED_STATE__`
 * 3. intercepted /api/v1/offers JSON when present
 *
 * timeoutMs = per-navigation (page.goto) deadline only.
 * categoryBudgetMs / totalBudgetMs abort in-flight navigation/capture, skip the next
 * category, and close the owned browser.
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
const MIN_GOTO_BUDGET_MS = 20;

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

class OlxDeadlineExceededError extends Error {
  constructor() {
    super("olx_browser_deadline_exceeded");
    this.name = "OlxDeadlineExceededError";
  }
}

export function isOlxCategoryHtmlResponse(input: {
  requestedUrl: string;
  responseUrl: string;
  contentType: string;
}): boolean {
  const contentType = input.contentType.toLowerCase();
  if (contentType && !contentType.includes("html") && !contentType.startsWith("text/plain")) {
    return false;
  }
  try {
    const requested = new URL(input.requestedUrl);
    const actual = new URL(input.responseUrl);
    if (actual.hostname.replace(/^www\./, "") !== requested.hostname.replace(/^www\./, "")) {
      return false;
    }
    const requestedPath = requested.pathname.replace(/\/+$/, "");
    const actualPath = actual.pathname.replace(/\/+$/, "");
    return actualPath === requestedPath || actualPath.startsWith(`${requestedPath}/`);
  } catch {
    return false;
  }
}

async function readGotoHtmlBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; originalBytes: number }> {
  const buf = await response.body();
  const originalBytes = buf.byteLength;
  const clipped = truncateUtf8Bytes(buf.toString("utf8"), maxBytes);
  return { text: clipped.text, truncated: clipped.truncated, originalBytes };
}

async function raceDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
  clock: () => number,
  cancel: () => Promise<void>,
): Promise<T> {
  const left = remainingMs(deadlineAt, clock());
  if (left <= 0) {
    await cancel().catch(() => undefined);
    throw new OlxDeadlineExceededError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        void cancel()
          .catch(() => undefined)
          .finally(() => {
            reject(new OlxDeadlineExceededError());
          });
      }, left);
      work.then(
        (value) => {
          if (!expired) {
            resolve(value);
          }
        },
        (error: unknown) => {
          if (!expired) {
            reject(error);
          }
        },
      );
    });
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
  // Diagnostic artifact only — never a production parser input.
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
  let mainDocumentHtml: string | undefined;
  let renderedHtml = "";
  let timedOut = false;
  const listings: Listing[] = [];
  let rawOfferCount = 0;
  let extractSource = "none";
  let htmlInputKind: OlxHtmlInputKind = "none";
  let htmlExtract = extractListingsFromOlxBrowserDocuments({}, deps.now(), {
    expectedCategoryId: expectedCategoryId(category),
  });
  const markTimeout = () => {
    timedOut = true;
  };

  const context = await browser.newContext({ locale: "uk-UA" });
  let pageClosed = false;
  const page = await context.newPage();
  const cancelOwnedWork = async () => {
    markTimeout();
    if (!pageClosed) {
      pageClosed = true;
      await page.close().catch(() => undefined);
    }
  };

  try {
    if (remainingMs(categoryDeadlineAt, deps.clock()) <= 0) {
      await cancelOwnedWork();
      return {
        ...emptyCategory(category, url, "category_budget_exhausted", "expired before navigation"),
        elapsedMs: deps.clock() - started,
      };
    }

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
      void response.json().then(
        (json) => {
          capturedPayloads.push(json);
        },
        () => {
          rejections.push({
            reason: "api_json_parse_failed",
            detail: sanitizeUrlForLog(responseUrl).slice(0, 120),
          });
        },
      );
    });

    const gotoBudget = Math.min(
      deps.navigationTimeoutMs,
      remainingMs(categoryDeadlineAt, deps.clock()),
    );
    if (gotoBudget < MIN_GOTO_BUDGET_MS) {
      await cancelOwnedWork();
      return {
        ...emptyCategory(category, url, "category_budget_exhausted", "insufficient time for navigation"),
        elapsedMs: deps.clock() - started,
      };
    }

    const response = await raceDeadline(
      page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: gotoBudget,
      }),
      categoryDeadlineAt,
      deps.clock,
      cancelOwnedWork,
    );

    if (!response) {
      rejections.push({ reason: "navigation_response_missing", detail: url });
    } else {
      const responseUrl = response.url();
      const contentType = response.headers()["content-type"] ?? "";
      if (
        !isOlxCategoryHtmlResponse({
          requestedUrl: url,
          responseUrl,
          contentType,
        })
      ) {
        rejections.push({
          reason: "navigation_response_not_category_html",
          detail: sanitizeUrlForLog(responseUrl),
        });
      } else {
        const body = await raceDeadline(
          readGotoHtmlBody(response, OLX_PARSER_MAX_HTML_BYTES),
          categoryDeadlineAt,
          deps.clock,
          cancelOwnedWork,
        );
        mainDocumentHtml = body.text;
        if (body.truncated) {
          rejections.push({
            reason: "main_document_parser_input_truncated",
            detail: `originalBytes=${body.originalBytes}`,
          });
        }
      }
    }

    const listingsFromMain: Listing[] = [];
    htmlInputKind = mainDocumentHtml ? "main_document" : "none";

    htmlExtract = extractListingsFromOlxBrowserDocuments(
      {
        ...(mainDocumentHtml ? { mainDocumentHtml } : {}),
      },
      deps.now(),
      { expectedCategoryId: expectedCategoryId(category) },
    );

    if (htmlExtract.listings.length > 0) {
      listingsFromMain.push(...htmlExtract.listings);
      listings.push(...htmlExtract.listings);
      rawOfferCount = Math.max(rawOfferCount, htmlExtract.rawOfferCount);
      extractSource = htmlExtract.source;
      htmlInputKind = "main_document";
    } else {
      rejections.push(...htmlExtract.rejections);
    }

    if (listingsFromMain.length === 0 && remainingMs(categoryDeadlineAt, deps.clock()) > 200) {
      await raceDeadline(
        page
          .waitForLoadState("networkidle", {
            timeout: Math.min(MAX_NETWORKIDLE_MS, remainingMs(categoryDeadlineAt, deps.clock())),
          })
          .catch(() => undefined),
        categoryDeadlineAt,
        deps.clock,
        cancelOwnedWork,
      );
    }

    if (listingsFromMain.length === 0) {
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
    }

    const stillNeedDomFallback =
      listings.length === 0 && !htmlExtract.diagnostics.hasPrerenderedState;
    if (stillNeedDomFallback && remainingMs(categoryDeadlineAt, deps.clock()) > 200) {
      renderedHtml = await raceDeadline(page.content(), categoryDeadlineAt, deps.clock, cancelOwnedWork);
      const fromRendered = extractListingsFromOlxBrowserDocuments(
        { renderedHtml },
        deps.now(),
        { expectedCategoryId: expectedCategoryId(category) },
      );
      htmlExtract = fromRendered;
      if (fromRendered.listings.length > 0) {
        listings.push(...fromRendered.listings);
        rawOfferCount = Math.max(rawOfferCount, fromRendered.rawOfferCount);
        extractSource = fromRendered.source;
        htmlInputKind = "rendered_dom";
      } else {
        rejections.push(...fromRendered.rejections);
        htmlInputKind = "rendered_dom";
      }
    } else if (deps.captureDir && remainingMs(categoryDeadlineAt, deps.clock()) > 200) {
      renderedHtml = await raceDeadline(page.content(), categoryDeadlineAt, deps.clock, cancelOwnedWork);
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const httpStatus = response?.status();
    const contentType = response?.headers()["content-type"];
    const classified = classifyOlxBrowserProbe({
      requestedUrl: url,
      finalUrl,
      title,
      bodyText: mainDocumentHtml || renderedHtml || "",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
    });

    if (classified.success && capturedPayloads.length === 0) {
      rejections.push({
        reason: "no_offers_api_payload_captured",
        detail: "page accessible but no /api/v1/offers JSON intercepted",
      });
    }

    let capturePaths: OlxCategoryCapturePaths | undefined;
    if (deps.captureDir) {
      if (remainingMs(categoryDeadlineAt, deps.clock()) <= 0) {
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
  } catch (error) {
    if (error instanceof OlxDeadlineExceededError) {
      markTimeout();
      let capturePaths: OlxCategoryCapturePaths | undefined;
      if (deps.captureDir) {
        capturePaths = writeOlxCategoryCapture({
          captureDir: deps.captureDir,
          category,
          commit: deps.commit,
          startedAt: new Date(started).toISOString(),
          requestedUrl: url,
          finalUrl: url,
          scripts: [],
          cards: [],
          networkMeta,
          skippedReason: "deadline_before_capture",
        });
      }
      const unique = dedupeListings(listings);
      return {
        category,
        requestedUrl: url,
        finalUrl: url,
        accessibility: unique.length > 0 ? "browser_accessible" : "parser_failure",
        accessibilityOk: unique.length > 0,
        apiResponsesCaptured: capturedPayloads.length,
        rawOfferCount,
        validatedListingCount: unique.length,
        listings: unique,
        rejections: [
          ...rejections,
          { reason: "category_budget_exhausted", detail: "deadline cancelled in-flight work" },
        ],
        elapsedMs: deps.clock() - started,
        extractSource,
        htmlDiagnostics: htmlExtract.diagnostics,
        networkJsonProbes,
        htmlInputKind: mainDocumentHtml ? "main_document" : htmlInputKind,
        timedOut: true,
        ...(capturePaths ? { capturePaths } : {}),
      };
    }
    throw error;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * One Chromium launch, apartments then houses (concurrency=1), always close.
 */
export async function extractOlxListingsViaBrowser(
  deps: OlxBrowserExtractDeps,
): Promise<OlxBrowserExtractResult> {
  const navigationTimeoutMs = Math.max(1, deps.timeoutMs);
  const categoryBudgetMs = Math.max(1, deps.categoryBudgetMs ?? navigationTimeoutMs);
  const totalBudgetMs = Math.max(
    categoryBudgetMs,
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
    if (remainingForHouses < MIN_CATEGORY_START_MS || clock() >= runDeadlineAt) {
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
