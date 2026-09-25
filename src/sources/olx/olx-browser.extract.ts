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
 *
 * Extraction success is independent of budgetExceeded. timedOut means extract did
 * not finish before cancellation. Cleanup is bounded and reported separately.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Response } from "playwright";
import { awaitWithTimeout } from "../../utils/deadline.ts";
import type { Listing } from "../../domain/listing.ts";
import {
  classifyOlxBrowserProbe,
  type OlxBrowserOutcome,
} from "../../probe/olx-browser-classify.ts";
import {
  assessOlxBrowserWalk,
  buildOlxBrowserCategoryUrl,
  crossedOlxPublicationBoundary,
  olxBrowserCoverageNotes,
  organicPublicationTimes,
  planOlxBrowserPages,
  type OlxBrowserCategoryName,
} from "./olx-browser.coverage.ts";
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
import { OLX_DISTANCE_KM } from "./olx.source.ts";
import type { IncrementalCoverage } from "../../domain/source.ts";

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

export const DEFAULT_OLX_CLEANUP_BUDGET_MS = 2_000;

export type OlxExtractPhaseTiming = {
  navigationMs: number;
  responseBodyMs: number;
  parseMs: number;
  captureMs: number;
  cleanupMs: number;
  extractMs: number;
  cleanupTimedOut: boolean;
};

export type OlxBrowserExtractTiming = {
  apartments: OlxExtractPhaseTiming;
  houses: OlxExtractPhaseTiming;
  browserCloseMs: number;
  browserCloseTimedOut: boolean;
};

export function emptyOlxExtractPhaseTiming(): OlxExtractPhaseTiming {
  return {
    navigationMs: 0,
    responseBodyMs: 0,
    parseMs: 0,
    captureMs: 0,
    cleanupMs: 0,
    extractMs: 0,
    cleanupTimedOut: false,
  };
}

export async function closeWithBudget(
  close: () => Promise<void>,
  budgetMs = DEFAULT_OLX_CLEANUP_BUDGET_MS,
): Promise<{ elapsedMs: number; timedOut: boolean }> {
  const started = Date.now();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      }, Math.max(1, budgetMs));
      void close()
        .then(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        })
        .catch(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        });
    });
    return { elapsedMs: Date.now() - started, timedOut };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

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
  budgetExceeded?: boolean;
  timing?: OlxExtractPhaseTiming;
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
  wallClockMs: number;
  budgetExceeded: boolean;
  timing: OlxBrowserExtractTiming;
  coverage?: IncrementalCoverage;
};

export type OlxBrowserExtractDeps = {
  /** page.goto timeout only (not total run). */
  timeoutMs: number;
  /** Wall-clock budget per category including settle/capture/cleanup. Defaults to timeoutMs. */
  categoryBudgetMs?: number;
  /** Wall-clock budget for apartments+houses. Defaults to 2*categoryBudgetMs + 5s. */
  totalBudgetMs?: number;
  /** chromium.launch / newPage deadline. Defaults to 15s and never exceeds the run budget. */
  launchTimeoutMs?: number;
  maxPagesPerCategory?: number;
  /** Publication watermark for newest-first walk stop (organic cards only). */
  publicationWatermark?: Date;
  concurrency?: number;
  launch?: () => Promise<Browser>;
  now?: () => Date;
  /** Monotonic-ish clock for deadlines (injectable in tests). */
  clockMs?: () => number;
  captureDir?: string;
  commit?: string;
  /** Wall-clock bound for page/context/browser close. Defaults to 2s. */
  cleanupBudgetMs?: number;
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
        reject(new OlxDeadlineExceededError());
        void cancel().catch(() => undefined);
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
    budgetExceeded: true,
    timing: emptyOlxExtractPhaseTiming(),
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
    cleanupBudgetMs: number;
  },
): Promise<OlxBrowserCategoryExtract> {
  const started = deps.clock();
  const categoryDeadlineAt = Math.min(started + deps.categoryBudgetMs, deps.runDeadlineAt);
  const rejections: OlxBrowserExtractRejection[] = [];
  const capturedPayloads: unknown[] = [];
  const networkJsonProbes: OlxNetworkJsonProbe[] = [];
  const networkMeta: OlxNetworkCaptureMeta[] = [];
  const timing = emptyOlxExtractPhaseTiming();
  let mainDocumentHtml: string | undefined;
  let renderedHtml = "";
  let timedOut = false;
  let extractCompleted = false;
  let acceptNetwork = true;
  const listings: Listing[] = [];
  let rawOfferCount = 0;
  let extractSource = "none";
  let htmlInputKind: OlxHtmlInputKind = "none";
  let htmlExtract = extractListingsFromOlxBrowserDocuments({}, deps.now(), {
    expectedCategoryId: expectedCategoryId(category),
  });
  const markTimeout = () => {
    if (!extractCompleted) {
      timedOut = true;
    }
  };
  const markExtractCompleted = () => {
    if (!extractCompleted) {
      extractCompleted = true;
      timing.extractMs = deps.clock() - started;
    }
  };

  const context = await awaitWithTimeout(
    browser.newContext({ locale: "uk-UA" }),
    Math.max(1, remainingMs(categoryDeadlineAt, deps.clock())),
    "chromium.newContext",
  );
  let pageClosed = false;
  const page = await awaitWithTimeout(
    context.newPage(),
    Math.max(1, remainingMs(categoryDeadlineAt, deps.clock())),
    "chromium.newPage",
  );
  const closePageBounded = async () => {
    if (pageClosed) {
      return;
    }
    pageClosed = true;
    const closed = await closeWithBudget(() => page.close(), deps.cleanupBudgetMs);
    timing.cleanupMs += closed.elapsedMs;
    timing.cleanupTimedOut = timing.cleanupTimedOut || closed.timedOut;
  };
  const cancelOwnedWork = async () => {
    markTimeout();
    acceptNetwork = false;
    await closePageBounded();
  };

  let result: OlxBrowserCategoryExtract | undefined;
  try {
    if (remainingMs(categoryDeadlineAt, deps.clock()) <= 0) {
      await cancelOwnedWork();
      result = {
        ...emptyCategory(category, url, "category_budget_exhausted", "expired before navigation"),
        elapsedMs: deps.clock() - started,
        timing,
      };
      return result;
    }

    page.on("response", (response: Response) => {
      if (!acceptNetwork || deps.clock() >= categoryDeadlineAt) {
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
      result = {
        ...emptyCategory(category, url, "category_budget_exhausted", "insufficient time for navigation"),
        elapsedMs: deps.clock() - started,
        timing,
      };
      return result;
    }

    const navigationStarted = deps.clock();
    const response = await raceDeadline(
      page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: gotoBudget,
      }),
      categoryDeadlineAt,
      deps.clock,
      cancelOwnedWork,
    );
    timing.navigationMs = deps.clock() - navigationStarted;

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
        const bodyStarted = deps.clock();
        const body = await raceDeadline(
          readGotoHtmlBody(response, OLX_PARSER_MAX_HTML_BYTES),
          categoryDeadlineAt,
          deps.clock,
          cancelOwnedWork,
        );
        timing.responseBodyMs = deps.clock() - bodyStarted;
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

    const parseStarted = deps.clock();
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
    timing.parseMs += deps.clock() - parseStarted;

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
      const networkParseStarted = deps.clock();
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
      timing.parseMs += deps.clock() - networkParseStarted;
      if (listings.length > 0) {
        extractSource = "network_offers_api";
        htmlInputKind = "network_offers_api";
      }
    }

    const stillNeedDomFallback =
      listings.length === 0 && !htmlExtract.diagnostics.hasPrerenderedState;
    // Do not start rendered capture after the category deadline.
    if (stillNeedDomFallback && remainingMs(categoryDeadlineAt, deps.clock()) > 200) {
      renderedHtml = await raceDeadline(page.content(), categoryDeadlineAt, deps.clock, cancelOwnedWork);
      const renderedParseStarted = deps.clock();
      const fromRendered = extractListingsFromOlxBrowserDocuments(
        { renderedHtml },
        deps.now(),
        { expectedCategoryId: expectedCategoryId(category) },
      );
      timing.parseMs += deps.clock() - renderedParseStarted;
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
    }

    acceptNetwork = false;
    markExtractCompleted();

    let finalUrl = url;
    let title = "";
    if (!pageClosed && remainingMs(categoryDeadlineAt, deps.clock()) > 0) {
      try {
        finalUrl = page.url();
        title = await raceDeadline(
          page.title().catch(() => ""),
          categoryDeadlineAt,
          deps.clock,
          cancelOwnedWork,
        );
      } catch (error) {
        if (!(error instanceof OlxDeadlineExceededError)) {
          throw error;
        }
      }
    } else if (!pageClosed) {
      try {
        finalUrl = page.url();
      } catch {
        // page already closing
      }
    }
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

    await closePageBounded();

    let capturePaths: OlxCategoryCapturePaths | undefined;
    const captureStarted = deps.clock();
    if (deps.captureDir) {
      if (remainingMs(categoryDeadlineAt, deps.clock()) <= 0) {
        if (listings.length > 0) {
          rejections.push({
            reason: "post_extract_deadline",
            detail: "category budget hit after listings were parsed; diagnostic capture skipped",
          });
        }
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
          ...(relevantStateJson !== undefined ? { relevantStateJson } : {}),
          scripts: inventoryScriptsFromHtml(mainDocumentHtml || ""),
          cards: extractCardFragmentsFromHtml(mainDocumentHtml || ""),
          networkMeta,
        });
      }
    }
    timing.captureMs = deps.clock() - captureStarted;

    const unique = dedupeListings(listings);
    const extractedOk = unique.length > 0;
    result = {
      category,
      requestedUrl: url,
      finalUrl,
      accessibility: extractedOk ? "browser_accessible" : classified.outcome,
      accessibilityOk: extractedOk || classified.success,
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
      budgetExceeded: deps.clock() - started > deps.categoryBudgetMs,
      timing,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(capturePaths ? { capturePaths } : {}),
    };
    return result;
  } catch (error) {
    if (error instanceof OlxDeadlineExceededError) {
      markTimeout();
      const unique = dedupeListings(listings);
      const extractedOk = unique.length > 0;
      if (!timing.extractMs && extractedOk) {
        timing.extractMs = deps.clock() - started;
      }
      let capturePaths: OlxCategoryCapturePaths | undefined;
      const captureStarted = deps.clock();
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
      timing.captureMs += deps.clock() - captureStarted;
      result = {
        category,
        requestedUrl: url,
        finalUrl: url,
        accessibility: extractedOk ? "browser_accessible" : "parser_failure",
        accessibilityOk: extractedOk,
        apiResponsesCaptured: capturedPayloads.length,
        rawOfferCount,
        validatedListingCount: unique.length,
        listings: unique,
        rejections: [
          ...rejections,
          extractedOk
            ? {
                reason: "post_extract_deadline",
                detail: "category budget hit after listings were parsed",
              }
            : { reason: "category_budget_exhausted", detail: "deadline cancelled in-flight work" },
        ],
        elapsedMs: deps.clock() - started,
        extractSource,
        htmlDiagnostics: htmlExtract.diagnostics,
        networkJsonProbes,
        htmlInputKind: mainDocumentHtml ? "main_document" : htmlInputKind,
        timedOut,
        budgetExceeded: true,
        timing,
        ...(capturePaths ? { capturePaths } : {}),
      };
      return result;
    }
    throw error;
  } finally {
    const closed = await closeWithBudget(() => context.close(), deps.cleanupBudgetMs);
    timing.cleanupMs += closed.elapsedMs;
    timing.cleanupTimedOut = timing.cleanupTimedOut || closed.timedOut;
    if (result) {
      result.timing = timing;
      result.elapsedMs = deps.clock() - started;
      result.budgetExceeded = result.budgetExceeded || result.elapsedMs > deps.categoryBudgetMs;
    }
  }
}

/**
 * One Chromium launch, apartments then houses (concurrency=1), always close.
 * Each category walks up to `maxPagesPerCategory` newest-first pages with
 * distance/sort query params. Stopping uses organic publication times only —
 * a known or promoted card never ends the walk by itself.
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
  const cleanupBudgetMs = Math.max(1, deps.cleanupBudgetMs ?? DEFAULT_OLX_CLEANUP_BUDGET_MS);
  const maxPages = Math.max(
    1,
    Math.min(deps.maxPagesPerCategory ?? 1, 3),
  );
  const plannedPages = planOlxBrowserPages({ pageBudget: maxPages, mode: "steady" });
  const now = deps.now ?? (() => new Date());
  const clock = deps.clockMs ?? (() => Date.now());
  const commit = deps.commit ?? "unknown";
  const runStarted = clock();
  const runDeadlineAt = runStarted + totalBudgetMs;

  if (deps.captureDir) {
    mkdirSync(deps.captureDir, { recursive: true, mode: 0o700 });
  }

  const launch = deps.launch ?? (() => chromium.launch({ headless: true }));
  const launchTimeoutMs = Math.max(1, Math.min(deps.launchTimeoutMs ?? 15_000, totalBudgetMs));
  const pendingLaunch = launch();
  let browser: Browser;
  try {
    browser = await awaitWithTimeout(pendingLaunch, launchTimeoutMs, "chromium.launch");
  } catch (error) {
    void pendingLaunch.then((opened) => opened.close()).catch(() => undefined);
    throw error;
  }
  const notes: string[] = [
    "transport=stock_playwright_chromium",
    "opt_in_only=true",
    `maxPagesPerCategory=${maxPages}`,
    "concurrency=1",
    `navigationTimeoutMs=${navigationTimeoutMs}`,
    `categoryBudgetMs=${categoryBudgetMs}`,
    `totalBudgetMs=${totalBudgetMs}`,
    `cleanupBudgetMs=${cleanupBudgetMs}`,
    "html_parser_input=main_document_then_rendered_dom",
    `parserMaxHtmlBytes=${OLX_PARSER_MAX_HTML_BYTES}`,
    `diagnosticMaxHtmlBytes=${DEFAULT_OLX_CAPTURE_LIMITS.maxHtmlBytes}`,
    `olx_browser_query=${buildOlxBrowserCategoryUrl("apartments")}`,
  ];
  let apartments: OlxBrowserCategoryExtract | undefined;
  let houses: OlxBrowserCategoryExtract | undefined;
  let pagesFetchedTotal = 0;
  let coverageTruncated = false;
  let boundaryReached = true;
  let browserCloseMs: number;
  let browserCloseTimedOut: boolean;
  try {
    const apt = await extractCategoryPages(browser, "apartments", {
      plannedPages,
      navigationTimeoutMs,
      categoryBudgetMs,
      now,
      clock,
      commit,
      runDeadlineAt,
      cleanupBudgetMs,
      ...(deps.publicationWatermark ? { publicationWatermark: deps.publicationWatermark } : {}),
      ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
    });
    apartments = apt.merged;
    pagesFetchedTotal += apt.fetchedPages.length;
    coverageTruncated = coverageTruncated || apt.coverageTruncated;
    boundaryReached = boundaryReached && apt.boundaryReached;
    notes.push(...apt.notes);

    const remainingForHouses = remainingMs(runDeadlineAt, clock());
    if (remainingForHouses < MIN_CATEGORY_START_MS || clock() >= runDeadlineAt) {
      notes.push("houses_skipped_total_budget");
      coverageTruncated = true;
      boundaryReached = false;
      houses = emptyCategory(
        "houses",
        buildOlxBrowserCategoryUrl("houses"),
        "total_budget_exhausted",
        `remainingMs=${remainingForHouses}`,
      );
    } else {
      const hou = await extractCategoryPages(browser, "houses", {
        plannedPages,
        navigationTimeoutMs: Math.min(navigationTimeoutMs, remainingForHouses),
        categoryBudgetMs: Math.min(categoryBudgetMs, remainingForHouses),
        now,
        clock,
        commit,
        runDeadlineAt,
        cleanupBudgetMs,
        ...(deps.publicationWatermark ? { publicationWatermark: deps.publicationWatermark } : {}),
        ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
      });
      houses = hou.merged;
      pagesFetchedTotal += hou.fetchedPages.length;
      coverageTruncated = coverageTruncated || hou.coverageTruncated;
      boundaryReached = boundaryReached && hou.boundaryReached;
      notes.push(...hou.notes);
    }
  } finally {
    const closed = await closeWithBudget(() => browser.close(), cleanupBudgetMs);
    browserCloseMs = closed.elapsedMs;
    browserCloseTimedOut = closed.timedOut;
  }
  const wallClockMs = clock() - runStarted;
  if (!apartments || !houses) {
    throw new Error("OLX browser extract incomplete before browser.close()");
  }

  notes.push(
    ...olxBrowserCoverageNotes({
      distanceKm: OLX_DISTANCE_KM,
      pageBudget: maxPages,
      pagesFetched: pagesFetchedTotal,
      boundaryReached,
      coverageTruncated,
    }),
  );

  if (deps.captureDir) {
    writeFileSync(
      join(deps.captureDir, "run-summary.json"),
      `${JSON.stringify(
        {
          commit,
          startedAt: new Date(runStarted).toISOString(),
          finishedAt: new Date().toISOString(),
          budgets: { navigationTimeoutMs, categoryBudgetMs, totalBudgetMs, cleanupBudgetMs },
          apartments: {
            requestedUrl: apartments.requestedUrl,
            finalUrl: apartments.finalUrl,
            elapsedMs: apartments.elapsedMs,
            timedOut: apartments.timedOut ?? false,
            budgetExceeded: apartments.budgetExceeded ?? false,
            timing: apartments.timing ?? emptyOlxExtractPhaseTiming(),
            capturePaths: apartments.capturePaths ?? null,
          },
          houses: {
            requestedUrl: houses.requestedUrl,
            finalUrl: houses.finalUrl,
            elapsedMs: houses.elapsedMs,
            timedOut: houses.timedOut ?? false,
            budgetExceeded: houses.budgetExceeded ?? false,
            timing: houses.timing ?? emptyOlxExtractPhaseTiming(),
            capturePaths: houses.capturePaths ?? null,
          },
          browserCloseMs,
          browserCloseTimedOut,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  const listings = dedupeListings([...apartments.listings, ...houses.listings]);
  const housesSkippedBudget = houses.rejections.some((item) => item.reason === "total_budget_exhausted");
  const accessibilityOk =
    apartments.accessibilityOk && (houses.accessibilityOk || housesSkippedBudget);
  const extractionOk = listings.length > 0;
  if (accessibilityOk && !extractionOk) {
    notes.push("accessibility_without_extraction=true");
  }
  notes.push(`apartments_extractSource=${apartments.extractSource ?? "none"}`);
  notes.push(`houses_extractSource=${houses.extractSource ?? "none"}`);
  if (apartments.timedOut || houses.timedOut) {
    notes.push("category_or_total_budget_hit=true");
  }
  const budgetExceeded = wallClockMs > totalBudgetMs;
  notes.push(`wallClockMs=${wallClockMs}`);
  if (budgetExceeded) {
    notes.push("total_budget_exceeded_including_cleanup=true");
  }
  if (extractionOk && budgetExceeded) {
    notes.push("extraction_ok_but_budget_exceeded=true");
  }
  const cleanupTimedOut =
    Boolean(apartments.timing?.cleanupTimedOut) ||
    Boolean(houses.timing?.cleanupTimedOut) ||
    browserCloseTimedOut;
  if (cleanupTimedOut) {
    notes.push("cleanup_budget_hit=true");
  }
  const organic = organicPublicationTimes(listings);
  const coverage: IncrementalCoverage = {
    pagesFetched: pagesFetchedTotal,
    cardsFetched: listings.length,
    boundaryReached,
    coverageTruncated,
    ...(organic.length > 0
      ? {
          oldestObservedPublication: new Date(
            Math.min(...organic.map((d) => d.getTime())),
          ).toISOString(),
          newestObservedPublication: new Date(
            Math.max(...organic.map((d) => d.getTime())),
          ).toISOString(),
        }
      : {}),
  };
  return {
    apartments,
    houses,
    listings,
    accessibilityOk,
    extractionOk,
    browserClosed: !browserCloseTimedOut,
    notes,
    budgets: { navigationTimeoutMs, categoryBudgetMs, totalBudgetMs },
    wallClockMs,
    budgetExceeded,
    timing: {
      apartments: apartments.timing ?? emptyOlxExtractPhaseTiming(),
      houses: houses.timing ?? emptyOlxExtractPhaseTiming(),
      browserCloseMs,
      browserCloseTimedOut,
    },
    coverage,
    ...(deps.captureDir ? { captureRootDir: deps.captureDir } : {}),
  };
}

async function extractCategoryPages(
  browser: Browser,
  category: OlxBrowserCategoryName,
  deps: {
    plannedPages: number[];
    navigationTimeoutMs: number;
    categoryBudgetMs: number;
    now: () => Date;
    clock: () => number;
    commit: string;
    runDeadlineAt: number;
    cleanupBudgetMs: number;
    captureDir?: string;
    publicationWatermark?: Date;
  },
): Promise<{
  merged: OlxBrowserCategoryExtract;
  fetchedPages: number[];
  boundaryReached: boolean;
  coverageTruncated: boolean;
  notes: string[];
}> {
  const notes: string[] = [];
  const fetchedPages: number[] = [];
  const pageExtracts: OlxBrowserCategoryExtract[] = [];
  let crossed = false;
  let failed = false;
  let lastPageCardCount = 0;

  for (const page of deps.plannedPages) {
    if (remainingMs(deps.runDeadlineAt, deps.clock()) <= 0) {
      notes.push(`${category}_page_${page}_skipped_budget`);
      failed = fetchedPages.length === 0;
      break;
    }
    const url = buildOlxBrowserCategoryUrl(category, { page });
    const pagesLeft = Math.max(1, deps.plannedPages.length - fetchedPages.length);
    const pageBudget = Math.min(
      deps.categoryBudgetMs,
      Math.max(MIN_GOTO_BUDGET_MS, Math.floor(remainingMs(deps.runDeadlineAt, deps.clock()) / pagesLeft)),
    );
    const extracted = await extractCategory(browser, category, url, {
      navigationTimeoutMs: Math.min(deps.navigationTimeoutMs, pageBudget),
      categoryBudgetMs: pageBudget,
      now: deps.now,
      clock: deps.clock,
      commit: deps.commit,
      runDeadlineAt: deps.runDeadlineAt,
      cleanupBudgetMs: deps.cleanupBudgetMs,
      ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
    });
    pageExtracts.push(extracted);
    fetchedPages.push(page);
    lastPageCardCount = extracted.listings.length;
    if (!extracted.accessibilityOk && extracted.listings.length === 0) {
      failed = true;
      notes.push(`${category}_page_${page}_failed`);
      break;
    }
    const organic = organicPublicationTimes(extracted.listings);
    if (crossedOlxPublicationBoundary(organic, deps.publicationWatermark)) {
      crossed = true;
      notes.push(`${category}_page_${page}_crossed_publication_boundary`);
      // Keep this page's cards; do not fetch deeper pages.
      break;
    }
    if (extracted.listings.length === 0) {
      notes.push(`${category}_page_${page}_empty`);
      break;
    }
  }

  const mergedListings = dedupeListings(pageExtracts.flatMap((item) => item.listings));
  const first = pageExtracts[0];
  const assessed = assessOlxBrowserWalk({
    plannedPages: deps.plannedPages,
    fetchedPages,
    lastPageCardCount,
    crossedBoundary: crossed,
    failed,
    ...(organicPublicationTimes(mergedListings).length > 0
      ? {
          newestOrganic: new Date(
            Math.max(...organicPublicationTimes(mergedListings).map((d) => d.getTime())),
          ).toISOString(),
        }
      : {}),
  });
  notes.push(
    `${category}_pages=${fetchedPages.join(",") || "none"}`,
    `${category}_boundary=${assessed.boundaryReached}`,
    `${category}_truncated=${assessed.coverageTruncated}`,
  );

  const merged: OlxBrowserCategoryExtract = first
    ? {
        ...first,
        listings: mergedListings,
        validatedListingCount: mergedListings.length,
        requestedUrl: buildOlxBrowserCategoryUrl(category),
        rejections: pageExtracts.flatMap((item) => item.rejections),
        elapsedMs: pageExtracts.reduce((sum, item) => sum + (item.elapsedMs ?? 0), 0),
        accessibilityOk: pageExtracts.some((item) => item.accessibilityOk),
        timedOut: pageExtracts.some((item) => item.timedOut),
        budgetExceeded: pageExtracts.some((item) => item.budgetExceeded),
      }
    : emptyCategory(
        category,
        buildOlxBrowserCategoryUrl(category),
        "category_budget_exhausted",
        "no pages fetched",
      );

  return {
    merged,
    fetchedPages,
    boundaryReached: assessed.boundaryReached,
    coverageTruncated: assessed.coverageTruncated,
    notes,
  };
}
