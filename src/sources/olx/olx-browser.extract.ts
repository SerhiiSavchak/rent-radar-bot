/**
 * Bounded OLX catalog extraction via stock Playwright.
 * Opt-in only — not wired into Telegram delivery until a live Oracle check passes.
 *
 * Parser input priority:
 * 1. main-document `response.body()` after `waitUntil: "commit"`.
 *    Routing allows only resourceType "document" and aborts every other subresource.
 *    A parsed structured catalog does not wait for hydration, networkidle, or /api/v1/offers.
 * 2. rendered DOM (`page.content()`) — fallback only when the main document
 *    has no structured catalog
 * 3. intercepted /api/v1/offers JSON — same fallback only, never a requirement
 *
 * timeoutMs = per-navigation (page.goto) deadline only.
 * categoryBudgetMs / totalBudgetMs abort in-flight navigation/capture, skip the next
 * category, and close the owned browser.
 *
 * Production walk: Private catalog in full, then Business.
 * Concurrency=1, one Chromium. Private still walks every structured page.
 * Business apartments fetch page 1 every cycle. About every 30 minutes they
 * also fetch every declared page in this same session. That snapshot is the
 * only complete Business apartment coverage. A page cursor across cycles is not.
 * createdTime order and publication boundaries do not decide coverage.
 * Private is not ownership. Business account type is not a seller role.
 *
 * Extraction success is independent of budgetExceeded. timedOut means extract did
 * not finish before cancellation. Cleanup is bounded and reported separately.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Response, type Route } from "playwright";
import { awaitWithTimeout } from "../../utils/deadline.ts";
import type { Listing } from "../../domain/listing.ts";
import {
  classifyOlxBrowserProbe,
  type OlxBrowserOutcome,
} from "../../probe/olx-browser-classify.ts";
import {
  assessOlxBusinessFullScanAge,
  buildOlxBrowserCategoryUrl,
  isOlxBusinessFullScanDue,
  OLX_BUSINESS_APARTMENT_PAGE_CEILING,
  OLX_BUSINESS_HOUSE_PAGE_CEILING,
  OLX_BUSINESS_HOUSE_ROUTINE_MAX_PAGES,
  OLX_PRIVATE_CATALOG_PAGE_CAP,
  OLX_PRIVATE_HOUSE_RESERVE_MS,
  olxCategoryToCoverageKey,
  olxPrivateCatalogNotes,
  parseOlxBusinessLastFullScanAt,
  type OlxBrowserCategoryName,
  type OlxCatchupState,
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
  readOlxStructuredCatalogPage,
  trustedOlxBusinessAdIds,
  type OlxHtmlExtractDiagnostics,
  type OlxStructuredCatalogPage,
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
  /** Present when prerendered listing.listing exposed integer pagination. */
  structuredCatalog?: OlxStructuredCatalogPage;
  trustedBusinessIds?: string[];
  structuredAdsCount?: number;
};

export type OlxPrivateScanStatus =
  | "complete"
  | "navigation_failed"
  | "parser_failure"
  | "page_mismatch"
  | "pagination_unstable"
  | "incomplete";

export type OlxPrivateCatalogFailureDetail = {
  page: number;
  reason: string;
  detail: string;
};

export type OlxPrivateCategoryScan = {
  status: OlxPrivateScanStatus;
  expectedPages: number | null;
  fetchedPages: number[];
  totalElements: number | null;
  uniqueListingIds: number;
  businessLeakCount: number;
  privateFilterContractLeak: boolean;
  failureDetails: OlxPrivateCatalogFailureDetail[];
  /** Elapsed time of each catalog page attempt, including a failed page. */
  pageElapsedMs: number[];
};

export type OlxBusinessScanStatus =
  | "complete"
  | "navigation_failed"
  | "parser_failure"
  | "page_mismatch"
  | "pagination_unstable"
  | "incomplete"
  | "skipped_budget";

export type OlxBusinessCategoryScan = {
  status: OlxBusinessScanStatus;
  /** hot = apartments page 1 only. full = every declared page this session. */
  mode: "hot" | "full" | "not_run";
  /** True only when this session fetched every declared page. Hot is never full. */
  fullCoverage: boolean;
  ceilingExceeded: boolean;
  expectedPages: number | null;
  fetchedPages: number[];
  totalElements: number | null;
  uniqueListingIds: number;
  failureDetails: OlxPrivateCatalogFailureDetail[];
};

export type OlxBusinessFullScanReport = {
  lastFullScanAt: string | null;
  ageMinutes: number | null;
  due: boolean;
  succeeded: boolean;
  pagesExpected: number | null;
  pagesFetched: number;
  apartmentMode: OlxBusinessCategoryScan["mode"];
  apartmentFullCoverage: boolean;
  /** healthy <= 30 min, coverage_degraded above 30, unsafe at 60 or with no success. */
  ageStatus: "healthy" | "coverage_degraded" | "unsafe";
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
  /** Structured private-catalog evidence. Absent only on synthetic empty results. */
  privateScan?: {
    apartments: OlxPrivateCategoryScan;
    houses: OlxPrivateCategoryScan;
  };
  businessScan?: {
    apartments: OlxBusinessCategoryScan;
    houses: OlxBusinessCategoryScan;
  };
  /** Age of the last successful Business apartment snapshot, after this cycle. */
  businessFullScan?: OlxBusinessFullScanReport;
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
  /** Ignored. Structured totalPages is the end condition, capped for safety. */
  maxPagesPerCategory?: number;
  /**
   * Ignored. Publication time does not choose OLX pages or prove coverage.
   */
  publicationWatermarks?: Partial<Record<OlxBrowserCategoryName, Date>>;
  /** Ignored. A page cursor is not the private-catalog collector. */
  catchup?: Partial<Record<OlxBrowserCategoryName, OlxCatchupState>>;
  /**
   * ISO time of the last successful Business apartment snapshot.
   * Absent means a full snapshot is due.
   */
  businessLastFullScanAt?: string;
  /** Ignored. Bootstrap targets do not choose OLX pages. */
  bootstrapTarget?: Date;
  /** @deprecated Prefer publicationWatermarks. Ignored when publicationWatermarks is set. */
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

/**
 * Playwright/navigation failures that must stay isolated to one category/page.
 * Unexpected programmer errors still propagate.
 */
export function isRecoverableOlxCategoryExtractionError(error: unknown): boolean {
  if (error instanceof OlxDeadlineExceededError) {
    return true;
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError") {
    return true;
  }
  return (
    /Timeout \d+ms exceeded/i.test(message) ||
    /page\.goto/i.test(message) ||
    /Navigation failed/i.test(message) ||
    /net::ERR_/i.test(message) ||
    /Target (page|closed|crashed)/i.test(message) ||
    /Browser (has been )?closed/i.test(message) ||
    /Execution context was destroyed/i.test(message)
  );
}

function safeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 180);
}

/** Catalog HTML is in the main document. Subresources are not parser input. */
async function continueCatalogDocumentOnly(route: Route): Promise<void> {
  if (route.request().resourceType() === "document") {
    await route.continue();
    return;
  }
  await route.abort();
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
  let structuredCatalog: OlxStructuredCatalogPage | undefined;
  let trustedBusinessIds: string[] = [];
  let structuredAdsCount = 0;
  const refreshStructured = (html: string | undefined) => {
    if (!html) {
      return;
    }
    const inspection = inspectPrerenderedState(html);
    if (inspection.decoded === undefined) {
      return;
    }
    const page = readOlxStructuredCatalogPage(inspection.decoded);
    if (page) {
      structuredCatalog = page;
    }
    trustedBusinessIds = trustedOlxBusinessAdIds(inspection.decoded);
    structuredAdsCount = extractListingAdsFromPrerenderedState(inspection.decoded).length;
  };
  const structuredExtras = (): Pick<
    OlxBrowserCategoryExtract,
    "structuredCatalog" | "trustedBusinessIds" | "structuredAdsCount"
  > => ({
    ...(structuredCatalog ? { structuredCatalog } : {}),
    trustedBusinessIds,
    structuredAdsCount,
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

    await page.route("**/*", (route) => continueCatalogDocumentOnly(route));

    const navigationStarted = deps.clock();
    const response = await raceDeadline(
      page.goto(url, {
        waitUntil: "commit",
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
    refreshStructured(mainDocumentHtml);
    const mainDocumentStructured = listingsFromMain.length > 0 || structuredCatalog !== undefined;

    if (!mainDocumentStructured && remainingMs(categoryDeadlineAt, deps.clock()) > 200) {
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

    if (!mainDocumentStructured && classified.success && capturedPayloads.length === 0) {
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

    refreshStructured(mainDocumentHtml || renderedHtml);
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
      ...structuredExtras(),
    };
    return result;
  } catch (error) {
    if (error instanceof OlxDeadlineExceededError) {
      markTimeout();
      refreshStructured(mainDocumentHtml || renderedHtml);
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
        ...structuredExtras(),
      };
      return result;
    }
    if (isRecoverableOlxCategoryExtractionError(error)) {
      markTimeout();
      refreshStructured(mainDocumentHtml || renderedHtml);
      const unique = dedupeListings(listings);
      const extractedOk = unique.length > 0;
      if (!timing.extractMs && extractedOk) {
        timing.extractMs = deps.clock() - started;
      }
      try {
        await closePageBounded();
      } catch {
        // page/context cleanup continues in finally
      }
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
          {
            reason: "category_page_navigation_failed",
            detail: safeErrorDetail(error),
          },
        ],
        elapsedMs: deps.clock() - started,
        extractSource,
        htmlDiagnostics: htmlExtract.diagnostics,
        networkJsonProbes,
        htmlInputKind: mainDocumentHtml ? "main_document" : htmlInputKind,
        timedOut: true,
        budgetExceeded: true,
        timing,
        ...structuredExtras(),
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

function stampAccountCatalog(listing: Listing, catalog: "private" | "business"): Listing {
  const metadata: Record<string, unknown> = {
    ...(listing.metadata ?? {}),
    olxAccountType: catalog,
    olxAccountCatalog: catalog,
  };
  const level = metadata.ownerEvidenceLevel;
  const positive =
    level === "self_declared" ||
    level === "platform_confirmed" ||
    listing.sellerType === "owner";
  const alreadyRejected =
    level === "intermediary" || level === "conflict" || listing.sellerType === "agent" || listing.sellerType === "business";
  if (catalog === "business" && !positive && !alreadyRejected) {
    metadata.ownerEvidenceLevel = "business_ambiguous";
    metadata.filterConsidersSelfDeclaredOwner = false;
    const assessment = metadata.sellerAssessment;
    if (assessment && typeof assessment === "object") {
      metadata.sellerAssessment = {
        ...(assessment as Record<string, unknown>),
        state: "unknown",
        send: false,
      };
    }
  }
  return { ...listing, metadata };
}

function emptyBusinessScan(status: OlxBusinessScanStatus): OlxBusinessCategoryScan {
  return {
    status,
    mode: "not_run",
    fullCoverage: false,
    ceilingExceeded: false,
    expectedPages: null,
    fetchedPages: [],
    totalElements: null,
    uniqueListingIds: 0,
    failureDetails: [],
  };
}

function businessPagesComplete(expectedPages: number, fetchedPages: number[]): boolean {
  if (expectedPages < 1 || fetchedPages.length !== expectedPages) {
    return false;
  }
  return fetchedPages.every((page, index) => page === index + 1);
}

/**
 * Business apartments: page 1 every call. A full snapshot, when due, fetches
 * every declared page in this same session. There is no cross-cycle cursor.
 * Business houses: every declared page while the catalog stays within the ceiling.
 * A failed or ceiling-stopped page is incomplete coverage.
 */
async function scanOlxBusinessCategory(
  browser: Browser,
  category: OlxBrowserCategoryName,
  apartmentMode: "hot" | "full",
  deps: {
    navigationTimeoutMs: number;
    categoryBudgetMs: number;
    now: () => Date;
    clock: () => number;
    commit: string;
    runDeadlineAt: number;
    cleanupBudgetMs: number;
    captureDir?: string;
  },
): Promise<{ scan: OlxBusinessCategoryScan; listings: Listing[]; notes: string[] }> {
  const notes: string[] = [];
  const listings: Listing[] = [];
  const fetchedPages: number[] = [];
  const failureDetails: OlxPrivateCatalogFailureDetail[] = [];
  let expectedPages: number | null = null;
  let totalElements: number | null = null;
  let status: OlxBusinessScanStatus = "complete";
  let mode: OlxBusinessCategoryScan["mode"];

  const remember = (page: number, reason: string, detail: string) => {
    failureDetails.push({ page, reason, detail });
    notes.push(detail);
  };

  const fetchPage = async (page: number): Promise<OlxBrowserCategoryExtract | "stop"> => {
    if (remainingMs(deps.runDeadlineAt, deps.clock()) < MIN_GOTO_BUDGET_MS) {
      remember(page, "category_budget_exhausted", `${category}_business_page_${page}_skipped_budget`);
      status = fetchedPages.length === 0 ? "skipped_budget" : "incomplete";
      return "stop";
    }
    const url = buildOlxBrowserCategoryUrl(category, { page, accountCatalog: "business" });
    const left = remainingMs(deps.runDeadlineAt, deps.clock());
    try {
      const extracted = await extractCategory(browser, category, url, {
        navigationTimeoutMs: Math.min(deps.navigationTimeoutMs, left),
        categoryBudgetMs: Math.min(deps.categoryBudgetMs, left),
        now: deps.now,
        clock: deps.clock,
        commit: deps.commit,
        runDeadlineAt: deps.runDeadlineAt,
        cleanupBudgetMs: deps.cleanupBudgetMs,
        ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
      });
      if (navigationFailed(extracted)) {
        const nav = extracted.rejections.find((item) =>
          item.reason === "category_page_navigation_failed" ||
          item.reason === "category_budget_exhausted" ||
          item.reason === "navigation_response_missing",
        );
        remember(page, nav?.reason ?? "category_page_navigation_failed", nav?.detail ?? `${category}_business_page_${page}_navigation_failed`);
        status = "navigation_failed";
        return "stop";
      }
      const structured = extracted.structuredCatalog;
      if (!structured) {
        const statePresent = extracted.htmlDiagnostics?.hasPrerenderedState === true;
        const reason = statePresent ? "olx_pagination_invalid" : "olx_structured_state_missing";
        remember(page, reason, `${category}_business_page_${page}_${reason}`);
        status = "parser_failure";
        return "stop";
      }
      if (structured.pageNumber !== page) {
        remember(page, "olx_page_mismatch", `${category}_business_page_${page}_mismatch structured=${structured.pageNumber}`);
        status = "page_mismatch";
        return "stop";
      }
      if (expectedPages === null) {
        expectedPages = structured.totalPages;
        totalElements = structured.totalElements;
      } else if (structured.totalPages !== expectedPages) {
        remember(
          page,
          "olx_pagination_unstable",
          `${category}_business_page_${page}_totalPages_changed expected=${expectedPages} actual=${structured.totalPages}`,
        );
        status = "pagination_unstable";
        return "stop";
      }
      const adsCount = extracted.structuredAdsCount ?? 0;
      if (structured.totalElements > 0 && adsCount === 0 && extracted.listings.length === 0) {
        remember(page, "olx_structured_state_missing", `${category}_business_page_${page}_elements_without_ads`);
        status = "parser_failure";
        return "stop";
      }
      fetchedPages.push(page);
      listings.push(...extracted.listings.map((listing) => stampAccountCatalog(listing, "business")));
      return extracted;
    } catch (error) {
      if (!isRecoverableOlxCategoryExtractionError(error)) {
        throw error;
      }
      remember(page, "category_page_navigation_failed", `${category}_business_page_${page}_extraction_error=${safeErrorDetail(error)}`);
      status = "navigation_failed";
      return "stop";
    }
  };

  const intendedMode: OlxBusinessCategoryScan["mode"] = category === "houses" ? "full" : apartmentMode;
  const first = await fetchPage(1);
  if (first === "stop" || expectedPages === null) {
    if (status === "complete") {
      status = "parser_failure";
    }
    const scan: OlxBusinessCategoryScan = {
      ...emptyBusinessScan(status),
      mode: intendedMode,
      failureDetails,
      fetchedPages,
      expectedPages,
      totalElements,
    };
    return { scan, listings: [], notes };
  }

  const ceiling =
    category === "apartments" ? OLX_BUSINESS_APARTMENT_PAGE_CEILING : OLX_BUSINESS_HOUSE_PAGE_CEILING;
  let ceilingExceeded = false;
  const plannedPages: number[] = [];
  if (category === "apartments" && apartmentMode === "hot") {
    mode = "hot";
  } else if (expectedPages > ceiling) {
    mode = "full";
    ceilingExceeded = true;
    status = "incomplete";
    remember(
      1,
      "olx_business_page_ceiling",
      `${category}_business_total_pages_${expectedPages}_exceeds_ceiling_${ceiling}`,
    );
  } else {
    mode = "full";
    for (let page = 2; page <= expectedPages; page += 1) {
      plannedPages.push(page);
    }
  }

  for (const page of plannedPages) {
    if (status !== "complete") {
      break;
    }
    const extracted = await fetchPage(page);
    if (extracted === "stop") {
      break;
    }
  }

  const fullCoverage =
    mode === "full" &&
    !ceilingExceeded &&
    status === "complete" &&
    businessPagesComplete(expectedPages, fetchedPages);
  const scan: OlxBusinessCategoryScan = {
    status,
    mode,
    fullCoverage,
    ceilingExceeded,
    expectedPages,
    fetchedPages,
    totalElements,
    uniqueListingIds: dedupeListings(listings).length,
    failureDetails,
  };
  notes.push(
    `${category}_business_mode=${mode}`,
    `${category}_business_full_coverage=${fullCoverage}`,
    `${category}_business_ceiling_exceeded=${ceilingExceeded}`,
    `${category}_business_status=${status}`,
    `${category}_business_total_pages=${expectedPages}`,
    `${category}_business_pages_fetched=${fetchedPages.join(",") || "none"}`,
    ...(category === "houses"
      ? [`${category}_business_routine_max_pages=${OLX_BUSINESS_HOUSE_ROUTINE_MAX_PAGES}`]
      : []),
  );
  return { scan, listings: dedupeListings(listings), notes };
}

/**
 * One Chromium launch, apartments then houses (concurrency=1), always close.
 * Each category walks structured pages 1..totalPages on the Private catalog.
 * A fixed house reserve keeps apartment pagination from consuming the whole budget.
 * Publication time and page cursors are not read.
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
  const now = deps.now ?? (() => new Date());
  const clock = deps.clockMs ?? (() => Date.now());
  const commit = deps.commit ?? "unknown";
  const runStarted = clock();
  const runDeadlineAt = runStarted + totalBudgetMs;
  const houseReserveMs = Math.min(
    OLX_PRIVATE_HOUSE_RESERVE_MS,
    Math.max(0, totalBudgetMs - MIN_CATEGORY_START_MS),
  );
  const apartmentsDeadlineAt = Math.min(runDeadlineAt, runStarted + totalBudgetMs - houseReserveMs);

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
    "catalog_transport=document_only",
    "catalog_wait_until=commit",
    "opt_in_only=true",
    `privateCatalogPageCap=${OLX_PRIVATE_CATALOG_PAGE_CAP}`,
    "concurrency=1",
    `navigationTimeoutMs=${navigationTimeoutMs}`,
    `categoryBudgetMs=${categoryBudgetMs}`,
    `totalBudgetMs=${totalBudgetMs}`,
    `houseBudgetReserveMs=${houseReserveMs}`,
    `cleanupBudgetMs=${cleanupBudgetMs}`,
    "html_parser_input=main_document_then_rendered_dom",
    `parserMaxHtmlBytes=${OLX_PARSER_MAX_HTML_BYTES}`,
    `diagnosticMaxHtmlBytes=${DEFAULT_OLX_CAPTURE_LIMITS.maxHtmlBytes}`,
    `olx_browser_query=${buildOlxBrowserCategoryUrl("apartments")}`,
  ];
  let apartments: OlxBrowserCategoryExtract | undefined;
  let houses: OlxBrowserCategoryExtract | undefined;
  let apartmentsScan: OlxPrivateCategoryScan | undefined;
  let housesScan: OlxPrivateCategoryScan | undefined;
  const previousFullScanAt = parseOlxBusinessLastFullScanAt(deps.businessLastFullScanAt);
  const apartmentMode = isOlxBusinessFullScanDue(previousFullScanAt, now()) ? "full" : "hot";
  let businessApartmentsScan: OlxBusinessCategoryScan;
  let businessHousesScan: OlxBusinessCategoryScan;
  let businessApartmentListings: Listing[] = [];
  let businessHouseListings: Listing[] = [];
  let browserCloseMs: number;
  let browserCloseTimedOut: boolean;
  try {
    const apt = await scanOlxPrivateCategory(browser, "apartments", {
      navigationTimeoutMs,
      categoryBudgetMs: Math.min(categoryBudgetMs, Math.max(1, apartmentsDeadlineAt - clock())),
      now,
      clock,
      commit,
      runDeadlineAt: apartmentsDeadlineAt,
      cleanupBudgetMs,
      ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
    });
    apartments = apt.merged;
    apartmentsScan = apt.privateScan;
    notes.push(...apt.notes);

    const remainingForHouses = remainingMs(runDeadlineAt, clock());
    if (remainingForHouses < MIN_CATEGORY_START_MS || clock() >= runDeadlineAt) {
      notes.push("houses_skipped_total_budget");
      houses = emptyCategory(
        "houses",
        buildOlxBrowserCategoryUrl("houses"),
        "total_budget_exhausted",
        `remainingMs=${remainingForHouses}`,
      );
      housesScan = emptyPrivateScan("incomplete");
    } else {
      try {
        const hou = await scanOlxPrivateCategory(browser, "houses", {
          navigationTimeoutMs: Math.min(navigationTimeoutMs, remainingForHouses),
          categoryBudgetMs: Math.min(categoryBudgetMs, remainingForHouses),
          now,
          clock,
          commit,
          runDeadlineAt,
          cleanupBudgetMs,
          ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
        });
        houses = hou.merged;
        housesScan = hou.privateScan;
        notes.push(...hou.notes);
      } catch (error) {
        // Category isolation: apartments already succeeded — never reject the whole extract.
        if (!isRecoverableOlxCategoryExtractionError(error)) {
          throw error;
        }
        const detail = safeErrorDetail(error);
        houses = emptyCategory(
          "houses",
          buildOlxBrowserCategoryUrl("houses"),
          "category_page_navigation_failed",
          detail,
        );
        housesScan = {
          ...emptyPrivateScan("navigation_failed"),
          failureDetails: [
            {
              page: 1,
              reason: "category_page_navigation_failed",
              detail,
            },
          ],
        };
        notes.push(`houses_category_extraction_error=${detail}`);
      }
    }

    const businessDeps = {
      navigationTimeoutMs,
      categoryBudgetMs,
      now,
      clock,
      commit,
      runDeadlineAt,
      cleanupBudgetMs,
      ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
    };
    try {
      const businessApartments = await scanOlxBusinessCategory(
        browser,
        "apartments",
        apartmentMode,
        businessDeps,
      );
      businessApartmentsScan = businessApartments.scan;
      businessApartmentListings = businessApartments.listings;
      notes.push(...businessApartments.notes);
    } catch (error) {
      if (!isRecoverableOlxCategoryExtractionError(error)) {
        throw error;
      }
      const detail = safeErrorDetail(error);
      businessApartmentsScan = {
        ...emptyBusinessScan("navigation_failed"),
        mode: apartmentMode,
        failureDetails: [{ page: 1, reason: "category_page_navigation_failed", detail }],
      };
      notes.push(`business_apartments_extraction_error=${detail}`);
    }
    try {
      const businessHouses = await scanOlxBusinessCategory(
        browser,
        "houses",
        apartmentMode,
        businessDeps,
      );
      businessHousesScan = businessHouses.scan;
      businessHouseListings = businessHouses.listings;
      notes.push(...businessHouses.notes);
    } catch (error) {
      if (!isRecoverableOlxCategoryExtractionError(error)) {
        throw error;
      }
      const detail = safeErrorDetail(error);
      businessHousesScan = {
        ...emptyBusinessScan("navigation_failed"),
        mode: "full",
        failureDetails: [{ page: 1, reason: "category_page_navigation_failed", detail }],
      };
      notes.push(`business_houses_extraction_error=${detail}`);
    }
  } finally {
    const closed = await closeWithBudget(() => browser.close(), cleanupBudgetMs);
    browserCloseMs = closed.elapsedMs;
    browserCloseTimedOut = closed.timedOut;
  }
  const wallClockMs = clock() - runStarted;
  if (!apartments || !houses || !apartmentsScan || !housesScan) {
    throw new Error("OLX browser extract incomplete before browser.close()");
  }
  const privateScan = { apartments: apartmentsScan, houses: housesScan };
  const businessScan = { apartments: businessApartmentsScan, houses: businessHousesScan };
  const apartmentCoverageProblem =
    businessApartmentsScan.mode === "not_run" ||
    businessApartmentsScan.status !== "complete" ||
    businessApartmentsScan.ceilingExceeded ||
    (businessApartmentsScan.mode === "full" && !businessApartmentsScan.fullCoverage);
  const houseCoverageProblem =
    businessHousesScan.mode === "not_run" ||
    businessHousesScan.status !== "complete" ||
    businessHousesScan.ceilingExceeded ||
    !businessHousesScan.fullCoverage;
  const privateIncomplete =
    apartmentsScan.status !== "complete" || housesScan.status !== "complete";
  const snapshotCommitAllowed =
    businessApartmentsScan.fullCoverage === true &&
    !apartmentCoverageProblem &&
    !houseCoverageProblem &&
    !privateIncomplete;
  const snapshotCompletedAt = snapshotCommitAllowed ? now() : undefined;
  const effectiveFullScanAt = snapshotCompletedAt ?? previousFullScanAt;
  const fullScanAge = assessOlxBusinessFullScanAge(effectiveFullScanAt, now());
  const businessFullScan: OlxBusinessFullScanReport = {
    lastFullScanAt: fullScanAge.lastFullScanAt,
    ageMinutes: fullScanAge.ageMinutes,
    due: fullScanAge.due,
    succeeded: snapshotCommitAllowed,
    pagesExpected: businessApartmentsScan.expectedPages,
    pagesFetched: businessApartmentsScan.fetchedPages.length,
    apartmentMode: businessApartmentsScan.mode,
    apartmentFullCoverage: businessApartmentsScan.fullCoverage,
    ageStatus: fullScanAge.unsafe
      ? "unsafe"
      : fullScanAge.degraded
        ? "coverage_degraded"
        : "healthy",
  };
  const pagesFetchedTotal =
    apartmentsScan.fetchedPages.length +
    housesScan.fetchedPages.length +
    businessApartmentsScan.fetchedPages.length +
    businessHousesScan.fetchedPages.length;
  // A hot apartment page is acquisition, not a coverage hole, while the last
  // snapshot is still inside the healthy age. A failed or overdue snapshot is not.
  const coverageTruncated =
    privateIncomplete ||
    apartmentCoverageProblem ||
    houseCoverageProblem ||
    fullScanAge.degraded ||
    fullScanAge.unsafe;
  const boundaryReached = !coverageTruncated;

  notes.push(
    ...olxPrivateCatalogNotes({
      distanceKm: OLX_DISTANCE_KM,
      apartmentsStatus: apartmentsScan.status,
      apartmentsExpectedPages: apartmentsScan.expectedPages,
      apartmentsFetchedPages: apartmentsScan.fetchedPages,
      apartmentsTotalElements: apartmentsScan.totalElements,
      housesStatus: housesScan.status,
      housesExpectedPages: housesScan.expectedPages,
      housesFetchedPages: housesScan.fetchedPages,
      housesTotalElements: housesScan.totalElements,
      businessLeakCount: apartmentsScan.businessLeakCount + housesScan.businessLeakCount,
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

  const listings = dedupeListings([
    ...apartments.listings.map((listing) => stampAccountCatalog(listing, "private")),
    ...houses.listings.map((listing) => stampAccountCatalog(listing, "private")),
    ...businessApartmentListings,
    ...businessHouseListings,
  ]);
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
  notes.push(
    `businessApartmentMode=${businessFullScan.apartmentMode}`,
    `businessApartmentFullCoverage=${businessFullScan.apartmentFullCoverage}`,
    `businessLastFullScanAt=${businessFullScan.lastFullScanAt ?? "none"}`,
    `businessFullScanAgeMinutes=${businessFullScan.ageMinutes === null ? "none" : String(businessFullScan.ageMinutes)}`,
    `businessFullScanDue=${businessFullScan.due}`,
    `businessFullScanSucceeded=${businessFullScan.succeeded}`,
    `businessFullScanPagesExpected=${businessFullScan.pagesExpected ?? "none"}`,
    `businessFullScanPagesFetched=${businessFullScan.pagesFetched}`,
    `businessFullScanAgeStatus=${businessFullScan.ageStatus}`,
    "business_cross_cycle_page_cursor_not_coverage=true",
  );
  const coverage: IncrementalCoverage = {
    pagesFetched: pagesFetchedTotal,
    cardsFetched: listings.length,
    boundaryReached,
    coverageTruncated,
    // null clears any stored page cursor. It is not a coverage proof.
    catchup: {
      [olxCategoryToCoverageKey("apartments")]: null,
      [olxCategoryToCoverageKey("houses")]: null,
    },
    ...(snapshotCompletedAt ? { olxBusinessLastFullScanAt: snapshotCompletedAt.toISOString() } : {}),
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
    privateScan,
    businessScan,
    businessFullScan,
    ...(deps.captureDir ? { captureRootDir: deps.captureDir } : {}),
  };
}



function emptyPrivateScan(status: OlxPrivateScanStatus): OlxPrivateCategoryScan {
  return {
    status,
    expectedPages: null,
    fetchedPages: [],
    totalElements: null,
    uniqueListingIds: 0,
    businessLeakCount: 0,
    privateFilterContractLeak: false,
    failureDetails: [],
    pageElapsedMs: [],
  };
}

function safePrivateListings(extracted: OlxBrowserCategoryExtract): {
  kept: Listing[];
  leakIds: string[];
} {
  const leakIds = new Set(extracted.trustedBusinessIds ?? []);
  for (const listing of extracted.listings) {
    if (listing.metadata?.olxIsBusiness === true) {
      leakIds.add(listing.sourceId);
    }
  }
  const kept = extracted.listings.filter(
    (listing) => listing.metadata?.olxIsBusiness !== true && !leakIds.has(listing.sourceId),
  );
  return { kept, leakIds: [...leakIds] };
}

function navigationFailed(extracted: OlxBrowserCategoryExtract): boolean {
  return extracted.rejections.some(
    (item) =>
      item.reason === "category_page_navigation_failed" ||
      item.reason === "category_budget_exhausted" ||
      item.reason === "navigation_response_missing",
  );
}

/**
 * Sequential Private-only walk. End condition is structured totalPages from page 1.
 * A later totalPages change is pagination instability, not a completed catalog.
 * createdTime order is not consulted.
 */
async function scanOlxPrivateCategory(
  browser: Browser,
  category: OlxBrowserCategoryName,
  deps: {
    navigationTimeoutMs: number;
    categoryBudgetMs: number;
    now: () => Date;
    clock: () => number;
    commit: string;
    runDeadlineAt: number;
    cleanupBudgetMs: number;
    captureDir?: string;
  },
): Promise<{
  merged: OlxBrowserCategoryExtract;
  privateScan: OlxPrivateCategoryScan;
  notes: string[];
}> {
  const notes: string[] = [`${category}_strategy=private_structured_full_scan`];
  const fetchedPages: number[] = [];
  const pageExtracts: OlxBrowserCategoryExtract[] = [];
  const keptListings: Listing[] = [];
  const leakIds = new Set<string>();
  let expectedPages: number | null = null;
  let totalElements: number | null = null;
  let status: OlxPrivateScanStatus = "complete";
  let failureDetail: string | undefined;
  let pageAccessible = false;
  const failureDetails: OlxPrivateCatalogFailureDetail[] = [];
  const pageElapsedMs: number[] = [];

  const rememberFailure = (page: number, reason: string, detail: string) => {
    failureDetails.push({ page, reason, detail });
  };

  const stop = (next: OlxPrivateScanStatus, detail: string) => {
    if (status === "complete") {
      status = next;
    }
    failureDetail = detail;
    notes.push(detail);
  };

  const absorbPage = (
    extracted: OlxBrowserCategoryExtract,
    options?: { countFetchedPage?: number },
  ) => {
    const safe = safePrivateListings(extracted);
    for (const id of safe.leakIds) {
      leakIds.add(id);
    }
    keptListings.push(...safe.kept);
    // Keep the page shell even with 0 kept cards so accessibility and parse
    // rejections survive (e.g. card-marker HTML without structured state).
    pageExtracts.push({ ...extracted, listings: safe.kept });
    pageAccessible = pageAccessible || extracted.accessibilityOk;
    if (options?.countFetchedPage !== undefined) {
      fetchedPages.push(options.countFetchedPage);
    }
  };

  for (let page = 1; page <= OLX_PRIVATE_CATALOG_PAGE_CAP; page += 1) {
    if (expectedPages !== null && page > expectedPages) {
      break;
    }
    if (remainingMs(deps.runDeadlineAt, deps.clock()) < MIN_GOTO_BUDGET_MS) {
      const detail = `${category}_page_${page}_skipped_budget`;
      pageElapsedMs.push(0);
      rememberFailure(
        page,
        fetchedPages.length === 0 ? "category_page_navigation_failed" : "category_budget_exhausted",
        detail,
      );
      stop(fetchedPages.length === 0 ? "navigation_failed" : "incomplete", detail);
      break;
    }
    const url = buildOlxBrowserCategoryUrl(category, { page });
    const left = remainingMs(deps.runDeadlineAt, deps.clock());
    const pageBudget = Math.min(deps.categoryBudgetMs, left);
    let extracted: OlxBrowserCategoryExtract;
    const pageStarted = deps.clock();
    try {
      extracted = await extractCategory(browser, category, url, {
        navigationTimeoutMs: Math.min(deps.navigationTimeoutMs, pageBudget),
        categoryBudgetMs: pageBudget,
        now: deps.now,
        clock: deps.clock,
        commit: deps.commit,
        runDeadlineAt: deps.runDeadlineAt,
        cleanupBudgetMs: deps.cleanupBudgetMs,
        ...(deps.captureDir ? { captureDir: deps.captureDir } : {}),
      });
    } catch (error) {
      if (!isRecoverableOlxCategoryExtractionError(error)) {
        throw error;
      }
      const detail = safeErrorDetail(error);
      pageElapsedMs.push(Math.max(0, deps.clock() - pageStarted));
      rememberFailure(page, "category_page_navigation_failed", detail);
      stop("navigation_failed", `${category}_page_${page}_extraction_error=${detail}`);
      break;
    }
    pageElapsedMs.push(extracted.elapsedMs);

    if (navigationFailed(extracted)) {
      absorbPage(extracted);
      const nav = extracted.rejections.find(
        (item) =>
          item.reason === "category_page_navigation_failed" ||
          item.reason === "category_budget_exhausted" ||
          item.reason === "navigation_response_missing",
      );
      rememberFailure(
        page,
        nav?.reason ?? "category_page_navigation_failed",
        nav?.detail ?? `${category}_page_${page}_navigation_failed`,
      );
      stop("navigation_failed", `${category}_page_${page}_navigation_failed`);
      break;
    }

    const structured = extracted.structuredCatalog;
    if (!structured) {
      absorbPage(extracted);
      const statePresent = extracted.htmlDiagnostics?.hasPrerenderedState === true;
      const reason = statePresent ? "olx_pagination_invalid" : "olx_structured_state_missing";
      rememberFailure(page, reason, `${category}_page_${page}_${reason}`);
      stop("parser_failure", `${category}_page_${page}_${reason}`);
      break;
    }

    if (structured.pageNumber !== page) {
      // Do not keep cards from a mismatched page — coverage is invalid.
      pageAccessible = pageAccessible || extracted.accessibilityOk;
      const detail = `${category}_page_${page}_mismatch structured=${structured.pageNumber}`;
      rememberFailure(page, "olx_page_mismatch", detail);
      stop("page_mismatch", detail);
      break;
    }

    if (expectedPages === null) {
      expectedPages = structured.totalPages;
      totalElements = structured.totalElements;
      if (expectedPages > OLX_PRIVATE_CATALOG_PAGE_CAP) {
        stop("incomplete", `${category}_declared_pages_exceed_cap=${expectedPages}`);
      }
    } else if (structured.totalPages !== expectedPages) {
      absorbPage(extracted, { countFetchedPage: page });
      const detail = `${category}_page_${page}_totalPages_changed expected=${expectedPages} actual=${structured.totalPages}`;
      rememberFailure(page, "olx_pagination_unstable", detail);
      stop("pagination_unstable", detail);
      break;
    }

    const adsCount = extracted.structuredAdsCount ?? 0;
    if (structured.totalElements > 0 && adsCount === 0 && extracted.listings.length === 0) {
      absorbPage(extracted);
      const detail = `${category}_page_${page}_elements_without_ads`;
      rememberFailure(page, "olx_structured_state_missing", detail);
      stop("parser_failure", detail);
      break;
    }

    absorbPage(extracted, { countFetchedPage: page });

    if (status !== "complete") {
      break;
    }
  }

  if (status === "complete" && expectedPages === null) {
    status = "parser_failure";
    notes.push(`${category}_structured_state_missing`);
  } else if (
    status === "complete" &&
    expectedPages !== null &&
    fetchedPages.length !== Math.min(expectedPages, OLX_PRIVATE_CATALOG_PAGE_CAP)
  ) {
    status = "incomplete";
    notes.push(`${category}_pages_incomplete expected=${expectedPages} fetched=${fetchedPages.join(",") || "none"}`);
  }

  const mergedListings = dedupeListings(keptListings);
  const businessLeakCount = leakIds.size;
  if (businessLeakCount > 0) {
    notes.push(`${category}_private_filter_contract_leak=${businessLeakCount}`);
  }
  const privateScan: OlxPrivateCategoryScan = {
    status,
    expectedPages,
    fetchedPages,
    totalElements,
    uniqueListingIds: mergedListings.length,
    businessLeakCount,
    privateFilterContractLeak: businessLeakCount > 0,
    failureDetails,
    pageElapsedMs,
  };
  notes.push(
    `${category}_pages=${fetchedPages.join(",") || "none"}`,
    `${category}_status=${status}`,
    `${category}_expected_pages=${expectedPages ?? "none"}`,
    `${category}_total_elements=${totalElements ?? "none"}`,
    `${category}_business_leak_count=${businessLeakCount}`,
  );
  if (failureDetail && !notes.includes(failureDetail)) {
    notes.push(failureDetail);
  }

  const first = pageExtracts[0];
  const leakRejection =
    businessLeakCount > 0
      ? [
          {
            reason: "olx_private_filter_contract_leak",
            detail: `rejected=${businessLeakCount}`,
          },
        ]
      : [];
  const failureReasons: Record<OlxPrivateScanStatus, string> = {
    complete: "olx_structured_state_missing",
    navigation_failed: "category_page_navigation_failed",
    parser_failure: "olx_structured_state_missing",
    page_mismatch: "olx_page_mismatch",
    pagination_unstable: "olx_pagination_unstable",
    incomplete: "olx_structured_state_missing",
  };
  const failureReason = failureReasons[status];
  const failedPage = emptyCategory(
    category,
    buildOlxBrowserCategoryUrl(category),
    failureReason,
    failureDetail ?? status,
  );
  const merged: OlxBrowserCategoryExtract = first
    ? {
        ...first,
        listings: mergedListings,
        validatedListingCount: mergedListings.length,
        requestedUrl: buildOlxBrowserCategoryUrl(category),
        rejections: [...pageExtracts.flatMap((item) => item.rejections), ...leakRejection],
        elapsedMs: pageExtracts.reduce((sum, item) => sum + (item.elapsedMs ?? 0), 0),
        accessibilityOk:
          pageExtracts.some((item) => item.accessibilityOk) ||
          pageAccessible ||
          status === "complete",
        timedOut: pageExtracts.some((item) => item.timedOut),
        budgetExceeded: pageExtracts.some((item) => item.budgetExceeded),
      }
    : {
        ...failedPage,
        accessibilityOk: pageAccessible,
        rejections: [...failedPage.rejections, ...leakRejection],
      };

  return { merged, privateScan, notes };
}
