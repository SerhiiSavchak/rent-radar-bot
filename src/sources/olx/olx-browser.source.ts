/**
 * OLX catalog via stock Playwright extract.
 * Used only when ENABLE_OLX_BROWSER=true. Never falls back to api/v1/offers HTTP.
 */

import type { Listing } from "../../domain/listing.ts";
import type {
  FetchListingsOptions,
  FetchResultKind,
  ListingSourceAdapter,
  SourceFetchResult,
  SourceHealth,
} from "../../domain/source.ts";
import { getConfig } from "../../config/env.ts";
import { keepBalancedCatalogSample } from "../../delivery/catalog-sample.ts";
import { AppError } from "../../utils/errors.ts";
import { logger } from "../../utils/logger.ts";
import {
  emptyOlxExtractPhaseTiming,
  extractOlxListingsViaBrowser,
  type OlxBrowserExtractDeps,
  type OlxBrowserExtractResult,
} from "./olx-browser.extract.ts";

export const OLX_BROWSER_TRANSPORT = "stock_playwright_chromium";

export type OlxBrowserSourceDeps = {
  extract?: (deps: OlxBrowserExtractDeps) => Promise<OlxBrowserExtractResult>;
  timeoutMs?: number;
  categoryBudgetMs?: number;
  totalBudgetMs?: number;
  now?: () => Date;
};

export function resolveOlxBrowserBudgets(env: NodeJS.ProcessEnv = process.env): {
  timeoutMs: number;
  categoryBudgetMs: number;
  totalBudgetMs: number;
} {
  const timeoutMs = Math.max(5_000, Number(env.OLX_BROWSER_TIMEOUT_MS ?? "45000"));
  const categoryBudgetMs = Math.max(5_000, Number(env.OLX_BROWSER_CATEGORY_BUDGET_MS ?? String(timeoutMs)));
  const totalBudgetMs = Math.max(
    categoryBudgetMs + 5_000,
    Number(env.OLX_BROWSER_TOTAL_BUDGET_MS ?? String(categoryBudgetMs * 2 + 5_000)),
  );
  return { timeoutMs, categoryBudgetMs, totalBudgetMs };
}

export function mapOlxBrowserExtractToFetchResult(
  result: OlxBrowserExtractResult,
  options: { limit?: number; includeApartments?: boolean; includeHouses?: boolean; startedMs: number },
): SourceFetchResult {
  let listings = result.listings;
  if (options.includeApartments === false) {
    listings = listings.filter((item) => item.propertyType !== "apartment");
  }
  if (options.includeHouses === false) {
    listings = listings.filter((item) => item.propertyType !== "house");
  }
  const unique = keepBalancedCatalogSample(dedupe(listings), options.limit ?? 10);

  const statuses = [result.apartments.httpStatus, result.houses.httpStatus].filter(
    (status): status is number => status !== undefined,
  );
  const blockedStatus = statuses.find((status) => status === 403 || status === 429);
  const reportedStatus = result.apartments.httpStatus ?? result.houses.httpStatus;
  const blockedWithoutExtract = blockedStatus !== undefined && !result.extractionOk;

  let resultKind: FetchResultKind;
  if (blockedWithoutExtract) {
    resultKind = "http_error";
  } else if (unique.length > 0 && result.extractionOk) {
    resultKind = "ok";
  } else if (result.accessibilityOk && unique.length === 0) {
    resultKind = result.extractionOk ? "valid_empty" : "parser_failure";
  } else {
    resultKind = "parser_failure";
  }

  const healthy = resultKind === "ok" || resultKind === "valid_empty";
  const notes = [
    `transport=${OLX_BROWSER_TRANSPORT}`,
    "no_http_api_fallback=true",
    `extractionOk=${result.extractionOk}`,
    `accessibilityOk=${result.accessibilityOk}`,
    `apartments=${result.apartments.validatedListingCount}`,
    `houses=${result.houses.validatedListingCount}`,
    `htmlInputKind=${result.apartments.htmlInputKind ?? "none"}/${result.houses.htmlInputKind ?? "none"}`,
    ...result.notes.slice(0, 6),
  ];

  return {
    listings: unique,
    transport: OLX_BROWSER_TRANSPORT,
    dataKind: "LIVE DATA",
    resultKind,
    rawNotes: notes,
    ...(reportedStatus !== undefined ? { httpStatus: reportedStatus } : {}),
    health: {
      source: "olx",
      healthy,
      checkedAt: new Date(),
      latencyMs: Date.now() - options.startedMs,
      resultKind,
      transport: OLX_BROWSER_TRANSPORT,
      ...(reportedStatus !== undefined ? { httpStatus: reportedStatus } : {}),
      message: healthy
        ? `OLX browser extract returned ${unique.length} listings`
        : blockedWithoutExtract
          ? `OLX browser transport_blocked HTTP ${blockedStatus} — not an HTTP API success and not a catalog extract`
          : `OLX browser extract did not return listings (${resultKind})`,
    },
  };
}

export class OlxBrowserSource implements ListingSourceAdapter {
  readonly source = "olx" as const;

  constructor(private readonly deps: OlxBrowserSourceDeps = {}) {}

  async healthCheck(): Promise<SourceHealth> {
    const result = await this.inspectLatest({ includeHouses: false, limit: 5 });
    return result.health;
  }

  async fetchLatest(options?: FetchListingsOptions): Promise<Listing[]> {
    const result = await this.inspectLatest(options);
    if (!result.health.healthy) {
      throw new AppError({
        code: "OLX_UNAVAILABLE",
        message: result.health.message ?? "OLX browser extract failed",
        retryable: false,
        status: result.httpStatus,
      });
    }
    return result.listings;
  }

  async inspectLatest(options?: FetchListingsOptions): Promise<SourceFetchResult> {
    const started = Date.now();
    const config = getConfig();
    const budgets = resolveOlxBrowserBudgets();
    const extract = this.deps.extract ?? extractOlxListingsViaBrowser;
    const result = await extract({
      timeoutMs: this.deps.timeoutMs ?? budgets.timeoutMs,
      categoryBudgetMs: this.deps.categoryBudgetMs ?? budgets.categoryBudgetMs,
      totalBudgetMs: this.deps.totalBudgetMs ?? budgets.totalBudgetMs,
      maxPagesPerCategory: 1,
      now: this.deps.now ?? (() => new Date()),
    });
    const mapped = mapOlxBrowserExtractToFetchResult(result, {
      startedMs: started,
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.includeApartments !== undefined ? { includeApartments: options.includeApartments } : {}),
      ...(options?.includeHouses !== undefined ? { includeHouses: options.includeHouses } : {}),
    });
    logger.info("olx.browser.inspect", {
      count: mapped.listings.length,
      resultKind: mapped.resultKind,
      status: mapped.httpStatus,
      transport: OLX_BROWSER_TRANSPORT,
      ownerOnly: config.ownerOnly,
      sellerPolicy: config.sellerPolicy,
    });
    return mapped;
  }
}

export function emptyOlxBrowserExtractResult(
  overrides: Partial<OlxBrowserExtractResult> = {},
): OlxBrowserExtractResult {
  const emptyCategory = {
    accessibility: "parser_failure" as const,
    accessibilityOk: false,
    apiResponsesCaptured: 0,
    rawOfferCount: 0,
    validatedListingCount: 0,
    listings: [],
    rejections: [],
    elapsedMs: 0,
    extractSource: "none",
    timedOut: false,
    htmlInputKind: "none" as const,
  };
  return {
    apartments: {
      category: "apartments",
      requestedUrl: "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/",
      finalUrl: "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/",
      ...emptyCategory,
    },
    houses: {
      category: "houses",
      requestedUrl: "https://www.olx.ua/uk/nedvizhimost/doma/arenda-domov/lvov/",
      finalUrl: "https://www.olx.ua/uk/nedvizhimost/doma/arenda-domov/lvov/",
      ...emptyCategory,
    },
    listings: [],
    accessibilityOk: false,
    extractionOk: false,
    browserClosed: true,
    notes: [],
    budgets: { navigationTimeoutMs: 1, categoryBudgetMs: 1, totalBudgetMs: 1 },
    wallClockMs: 0,
    budgetExceeded: false,
    timing: {
      apartments: emptyOlxExtractPhaseTiming(),
      houses: emptyOlxExtractPhaseTiming(),
      browserCloseMs: 0,
      browserCloseTimedOut: false,
    },
    ...overrides,
  };
}

function dedupe(listings: Listing[]): Listing[] {
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
