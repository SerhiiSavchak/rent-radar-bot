import type { Listing } from "../../domain/listing.ts";
import type {
  FetchListingsOptions,
  FetchResultKind,
  ListingSourceAdapter,
  SourceFetchResult,
  SourceHealth,
} from "../../domain/source.ts";
import { getConfig, usesOwnerOnlySourceFilter } from "../../config/env.ts";
import { AppError } from "../../utils/errors.ts";
import { headerBag, httpGet } from "../../utils/http.ts";
import { logger } from "../../utils/logger.ts";
import { isRieltorTransportBlocked, resolveRieltorInspectKind } from "./rieltor-classify.ts";
import { buildRieltorSearchUrl, inspectRieltorHtml } from "./rieltor.parser.ts";
import {
  RIELTOR_MAX_PAGES_PER_CATEGORY,
  RIELTOR_PAGE_SIZE,
  RIELTOR_REQUEST_GAP_MS,
  type RieltorCategory,
} from "./rieltor.types.ts";

export class RieltorSource implements ListingSourceAdapter {
  readonly source = "rieltor" as const;

  async healthCheck(): Promise<SourceHealth> {
    const result = await this.inspectLatest({ includeHouses: false, limit: 5 });
    return result.health;
  }

  async fetchLatest(options?: FetchListingsOptions): Promise<Listing[]> {
    const result = await this.inspectLatest(options);
    if (!result.health.healthy) {
      throw new AppError({
        code: "RIELTOR_UNAVAILABLE",
        message: result.health.message ?? "RIELTOR fetch failed",
        retryable: false,
        status: result.httpStatus,
      });
    }
    return result.listings;
  }

  async inspectLatest(options?: FetchListingsOptions): Promise<SourceFetchResult> {
    const started = Date.now();
    const config = getConfig();
    // Default public catalog keeps unknown sellers. f-owners=1 only for legacy owner_only.
    const effectiveOptions: FetchListingsOptions = {
      ...options,
      preferOwners: options?.preferOwners ?? usesOwnerOnlySourceFilter(config),
    };
    const notes: string[] = [];
    const categories: RieltorCategory[] = [];
    if (effectiveOptions.includeApartments !== false) {
      categories.push("apartment");
    }
    if (effectiveOptions.includeHouses !== false) {
      categories.push("house");
    }

    const listings: Listing[] = [];
    let lastStatus: number | undefined;
    let parserFailure = false;
    let httpError = false;
    let blocked = false;
    let sawStructure = false;
    let truncated = false;
    let extractedCardCount = 0;
    let validatedCardCount = 0;
    let hasJsonLd = false;
    let declaredTotal = 0;
    let requestCount = 0;

    for (const [index, category] of categories.entries()) {
      if (index > 0) {
        await sleep(RIELTOR_REQUEST_GAP_MS);
      }
      const page = await this.fetchCategoryPages(
        category,
        effectiveOptions,
        notes,
        config.sourceTimeoutMs,
      );
      requestCount += page.requestCount;
      lastStatus = page.lastStatus ?? lastStatus;
      extractedCardCount += page.extractedCardCount;
      validatedCardCount += page.validatedCardCount;
      hasJsonLd = hasJsonLd || page.hasJsonLd;
      declaredTotal += page.declaredCount ?? 0;
      truncated = truncated || page.truncated;
      if (page.blocked) {
        blocked = true;
        httpError = true;
        notes.push(`${category}: stopped after HTTP ${page.lastStatus}`);
        break;
      }
      if (page.parserFailure) {
        parserFailure = true;
        continue;
      }
      if (page.httpError) {
        httpError = true;
        continue;
      }
      sawStructure = true;
      listings.push(...page.listings);
    }

    const unique = dedupe(listings).slice(0, options?.limit ?? 10);
    if (effectiveOptions.preferOwners !== true && declaredTotal > unique.length) {
      notes.push(
        `public catalog sample=${unique.length} declared≈${declaredTotal} — not exhaustive under existing page/limit bounds`,
      );
    }
    const resultKind = resolveRieltorInspectKind({
      parserFailure,
      httpError,
      blocked,
      uniqueCount: unique.length,
      sawStructure,
    });
    const healthy = resultKind === "ok" || resultKind === "valid_empty";
    logger.info("rieltor.inspect", {
      count: unique.length,
      status: lastStatus,
      resultKind,
      requestCount,
      truncated,
    });
    return {
      listings: unique,
      transport: "public HTML catalog cards + optional JSON-LD",
      dataKind: "LIVE DATA",
      resultKind,
      ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
      rawNotes: [
        ...notes,
        `requests=${requestCount}`,
        truncated
          ? "TRUNCATED: declared catalog size exceeds fetched cards; do not treat this scan as complete"
          : "scanCompleteWithinFetchedPages=true (full-catalog completeness still depends on declaredCount)",
      ],
      integrity: {
        ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
        hasExpectedMarkers: sawStructure,
        hasJsonLd,
        extractedCardCount,
        validatedCardCount,
        validationRatio: extractedCardCount > 0 ? validatedCardCount / extractedCardCount : 0,
      },
      health: {
        source: this.source,
        healthy,
        checkedAt: new Date(),
        latencyMs: Date.now() - started,
        resultKind,
        ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
        transport: "public HTML catalog cards + optional JSON-LD",
        message: messageFor(resultKind, unique.length, lastStatus, truncated, declaredTotal),
      },
    };
  }

  private async fetchCategoryPages(
    category: RieltorCategory,
    options: FetchListingsOptions | undefined,
    notes: string[],
    timeoutMs: number,
  ): Promise<{
    listings: Listing[];
    lastStatus?: number;
    requestCount: number;
    extractedCardCount: number;
    validatedCardCount: number;
    hasJsonLd: boolean;
    declaredCount?: number;
    truncated: boolean;
    parserFailure: boolean;
    httpError: boolean;
    blocked: boolean;
  }> {
    const ownersOnly = options?.preferOwners === true;
    const limit = options?.limit ?? 10;
    const listings: Listing[] = [];
    let lastStatus: number | undefined;
    let requestCount = 0;
    let extractedCardCount = 0;
    let validatedCardCount = 0;
    let hasJsonLd = false;
    let declaredCount: number | undefined;
    let truncated = false;
    let parserFailure = false;
    let httpError = false;
    let blocked = false;

    const maxPages = Math.min(
      RIELTOR_MAX_PAGES_PER_CATEGORY,
      Math.max(1, Math.ceil(limit / RIELTOR_PAGE_SIZE)),
    );

    for (let page = 1; page <= maxPages; page += 1) {
      if (page > 1) {
        await sleep(RIELTOR_REQUEST_GAP_MS);
      }
      const url = buildRieltorSearchUrl(category, page, ownersOnly);
      const response = await httpGet(url, { timeoutMs, maxRetries: 0 });
      requestCount += 1;
      lastStatus = response.status;
      notes.push(`${url} -> ${response.status} ${headerBag(response)} final=${response.url}`);
      if (isRieltorTransportBlocked({ status: response.status, bodyText: response.bodyText })) {
        blocked = true;
        httpError = true;
        notes.push(
          `${category} page ${page}: transport_blocked (${response.status}); HTML 200 challenge/block page is not catalog success; bounded stop, no proxy/CAPTCHA/stealth retries`,
        );
        // Single bounded pause before returning so the next cycle/source is spaced;
        // do not retry the blocked request aggressively.
        await sleep(RIELTOR_REQUEST_GAP_MS);
        break;
      }
      if (response.status !== 200) {
        httpError = true;
        notes.push(`${category} page ${page}: HTTP ${response.status}`);
        break;
      }
      const inspection = inspectRieltorHtml(response.bodyText, {
        category,
        pageUrl: response.url || url,
      });
      hasJsonLd = hasJsonLd || inspection.hasJsonLd;
      extractedCardCount += inspection.extractedCardCount;
      validatedCardCount += inspection.validatedCardCount;
      declaredCount = inspection.declaredCount ?? declaredCount;
      truncated = truncated || inspection.truncated;
      notes.push(
        `${category} p${page} kind=${inspection.resultKind} declared=${inspection.declaredCount ?? "n/a"} cards=${inspection.extractedCardCount} validated=${inspection.validatedCardCount} jsonld=${inspection.hasJsonLd} location=${inspection.locationResolved} truncated=${inspection.truncated}`,
      );
      if (!inspection.locationResolved) {
        parserFailure = true;
        notes.push(`${category}: refused fallback location (${inspection.locationLabel ?? "unresolved"})`);
        break;
      }
      if (inspection.resultKind === "parser_failure") {
        parserFailure = true;
        break;
      }
      listings.push(...inspection.listings);
      if (inspection.resultKind === "valid_empty" || inspection.listings.length === 0) {
        break;
      }
      if (listings.length >= limit) {
        break;
      }
      const remaining =
        inspection.declaredCount !== undefined
          ? inspection.declaredCount - page * inspection.extractedCardCount
          : 0;
      if (remaining <= 0) {
        truncated = false;
        break;
      }
    }

    if (declaredCount !== undefined && listings.length < declaredCount) {
      truncated = true;
    }

    return {
      listings,
      requestCount,
      extractedCardCount,
      validatedCardCount,
      hasJsonLd,
      truncated,
      parserFailure,
      httpError,
      blocked,
      ...(lastStatus !== undefined ? { lastStatus } : {}),
      ...(declaredCount !== undefined ? { declaredCount } : {}),
    };
  }
}


function messageFor(
  kind: FetchResultKind,
  count: number,
  status: number | undefined,
  truncated: boolean,
  declaredTotal: number,
): string {
  const truncation = truncated ? ` TRUNCATED (declared catalog ≥ ${declaredTotal})` : "";
  if (kind === "parser_failure") {
    return `RIELTOR parser failure: expected catalog markers or Lviv location missing${truncation}`;
  }
  if (kind === "valid_empty") {
    return `RIELTOR VALID_EMPTY_RESULT: catalog structure present, zero primary cards${truncation}`;
  }
  if (kind === "ok") {
    return `RIELTOR returned ${count} listings${truncation}`;
  }
  if (status === 403 || status === 429) {
    return `RIELTOR transport_blocked HTTP ${status} (same path/headers as soak; intermittent edge block — no code discrepancy found)${truncation}`;
  }
  return `RIELTOR HTTP error (${status ?? "n/a"})${truncation}`;
}

function dedupe(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  return listings.filter((listing) => {
    if (seen.has(listing.sourceId)) {
      return false;
    }
    seen.add(listing.sourceId);
    return true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
