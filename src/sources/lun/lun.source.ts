import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Listing } from "../../domain/listing.ts";
import type {
  FetchListingsOptions,
  ListingSourceAdapter,
  SourceFetchResult,
  SourceHealth,
} from "../../domain/source.ts";
import { getConfig } from "../../config/env.ts";
import { AppError } from "../../utils/errors.ts";
import { headerBag, httpGet } from "../../utils/http.ts";
import { logger } from "../../utils/logger.ts";
import { inspectLunHtml } from "./lun.parser.ts";
import { coverageForAcquiredCards, keepAcquiredByCategory } from "../../delivery/catalog-sample.ts";

/** Public Lviv long-term flats catalog. Not the bez-poserednykiv owner-only route. */
export const LUN_FLATS_URL = "https://lun.ua/rent/lviv/flats";
export const LUN_HOUSES_URL = "https://lun.ua/rent/lviv/houses";

/**
 * Live-verified 2026-09-26: `?page=2` returns novel listing ids vs page 1.
 * Path `/page/2` is 404; `?offset=24` duplicates page 1.
 * 2026-10-01: pages are not newest-first. A fixed 2-page budget misses same-day
 * cards. The walk continues until unique card ids reach totalGroupedCount,
 * totalPages, or an empty cards page. Repeated ids do not advance the count.
 * This cap is only an emergency guard.
 */
export const LUN_PAGE_SAFETY_CAP = 80;

/** Per category. Stopping here is coverage_degraded, not a complete catalog. */
export const LUN_CATEGORY_WALK_BUDGET_MS = 180_000;

/**
 * Above a full Lviv rent catalog (about 1 600 grouped flats on 2026-10-01).
 * The shared 120-card cap would drop a completed walk and hide fresh cards
 * that are not on the first pages. Hitting this cap is coverage_degraded.
 */
export const LUN_ACQUIRED_CARD_CAP = 2_500;

export type LunPageResponse = {
  status: number;
  bodyText: string;
  headers?: Record<string, string>;
};

export type LunSourceDeps = {
  get?: (url: string, timeoutMs: number) => Promise<LunPageResponse>;
  now?: () => number;
  safetyCap?: number;
  categoryBudgetMs?: number;
  acquiredCardCap?: number;
};

export type LunWalkBoundary = {
  totalGroupedCount?: number;
  totalPages?: number;
};

/** Structured catalog size from the RSC payload. Display text is not a boundary. */
export function readLunWalkBoundary(html: string): LunWalkBoundary {
  const boundary: LunWalkBoundary = {};
  const grouped = html.match(/totalGroupedCount\\?":(\d+)/);
  const pages = html.match(/totalPages\\?":(\d+)/);
  if (grouped) {
    const count = Number(grouped[1]);
    if (Number.isInteger(count) && count >= 0) {
      boundary.totalGroupedCount = count;
    }
  }
  if (pages) {
    const count = Number(pages[1]);
    if (Number.isInteger(count) && count >= 1) {
      boundary.totalPages = count;
    }
  }
  return boundary;
}

export function buildLunCategoryPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) {
    return baseUrl;
  }
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(page));
  return url.toString();
}

/**
 * When LUN_CAPTURE_DIR is set (prefer ~/rent-radar-runtime/...), write a bounded
 * sample of failing HTML outside the git worktree for later framing verification.
 */
function maybeCaptureLunFailure(page: string, bodyText: string, reason: string): string | undefined {
  const dir = process.env.LUN_CAPTURE_DIR?.trim();
  if (!dir) {
    return undefined;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(bodyText).digest("hex").slice(0, 12);
    const maxBytes = Math.max(64_000, Number(process.env.LUN_CAPTURE_MAX_BYTES ?? "512000"));
    const sample = bodyText.slice(0, maxBytes);
    const path = join(dir, `lun-fail-${hash}.html`);
    writeFileSync(path, sample, { mode: 0o600 });
    const metaPath = join(dir, `lun-fail-${hash}.json`);
    writeFileSync(
      metaPath,
      `${JSON.stringify(
        {
          page,
          reason,
          capturedAt: new Date().toISOString(),
          bodyChars: bodyText.length,
          sampleChars: sample.length,
          sha256_12: hash,
          suspectedDefect:
            "Prior greedy self.__next_f.push regex concatenated multiple RSC records; fixed by per-push parse. Re-verify against this capture if parse still fails.",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return path;
  } catch {
    return undefined;
  }
}

export class LunSource implements ListingSourceAdapter {
  readonly source = "lun" as const;

  constructor(private readonly deps: LunSourceDeps = {}) {}

  async healthCheck(): Promise<SourceHealth> {
    const result = await this.inspectLatest({ includeHouses: false, limit: 5 });
    return result.health;
  }

  async fetchLatest(options?: FetchListingsOptions): Promise<Listing[]> {
    const result = await this.inspectLatest(options);
    if (!result.health.healthy) {
      throw new AppError({
        code: "LUN_UNAVAILABLE",
        message: result.health.message ?? "LUN fetch failed",
        retryable: false,
        status: result.httpStatus,
      });
    }
    return result.listings;
  }

  async inspectLatest(options?: FetchListingsOptions): Promise<SourceFetchResult> {
    const started = Date.now();
    const config = getConfig();
    const notes: string[] = [];
    const categories: string[] = [];
    if (options?.includeApartments !== false) {
      categories.push(LUN_FLATS_URL);
    }
    if (options?.includeHouses !== false) {
      categories.push(LUN_HOUSES_URL);
    }
    const safetyCap = this.deps.safetyCap ?? LUN_PAGE_SAFETY_CAP;
    const categoryBudgetMs = this.deps.categoryBudgetMs ?? LUN_CATEGORY_WALK_BUDGET_MS;
    const now = this.deps.now ?? Date.now;
    notes.push(`lun_page_safety_cap=${safetyCap}`);
    notes.push("lun_pagination=walk_until_terminal");

    const listings: Listing[] = [];
    let lastStatus: number | undefined;
    let parserFailure = false;
    let httpError = false;
    let sawStructure = false;
    let extractedCardCount = 0;
    let validatedCardCount = 0;
    let hasJsonLd = false;
    let hasRscCards = false;
    let pagesFetched = 0;
    let coverageTruncated = false;
    let schemaRejects = 0;
    let locationNulls = 0;
    let boundaryReached = categories.length > 0;
    const stopReasons: string[] = [];

    const getPage = async (url: string): Promise<LunPageResponse> => {
      if (this.deps.get) {
        return this.deps.get(url, config.sourceTimeoutMs);
      }
      const response = await httpGet(url, {
        timeoutMs: config.sourceTimeoutMs,
        maxRetries: config.sourceMaxRetries,
      });
      return {
        status: response.status,
        bodyText: response.bodyText,
        headers: response.headers,
      };
    };

    for (const categoryUrl of categories) {
      const seenIds = new Set<string>();
      const seenRawIds = new Set<string>();
      const seenPageSets = new Set<string>();
      let rawRows = 0;
      let declaredTotal: number | undefined;
      let declaredPages: number | undefined;
      let categoryTerminal = false;
      const startedAt = now();

      for (let page = 1; page <= safetyCap; page += 1) {
        if (page > 1 && now() - startedAt >= categoryBudgetMs) {
          coverageTruncated = true;
          categoryTerminal = false;
          stopReasons.push("time_budget");
          notes.push(`${categoryUrl} coverage_truncated=time_budget`);
          break;
        }
        const pageUrl = buildLunCategoryPageUrl(categoryUrl, page);
        let response: LunPageResponse;
        try {
          response = await getPage(pageUrl);
        } catch (error) {
          const timedOut = error instanceof AppError && error.code === "TIMEOUT";
          if (page === 1 && listings.length === 0 && seenIds.size === 0) {
            httpError = true;
            notes.push(`${pageUrl} ${timedOut ? "timeout" : "transport_error"}`);
          } else {
            coverageTruncated = true;
            stopReasons.push(timedOut ? "timeout" : "http_error");
            notes.push(`${pageUrl} coverage_truncated=${timedOut ? "timeout" : "http_error"}`);
          }
          break;
        }
        const pageOneOutage = page === 1 && seenIds.size === 0 && listings.length === 0;
        if (response.status === 200 || pageOneOutage) {
          lastStatus = response.status;
        }
        const bag = response.headers
          ? headerBag({
              status: response.status,
              url: pageUrl,
              headers: response.headers,
              bodyText: response.bodyText,
              redirected: false,
            })
          : "";
        notes.push(`${pageUrl} -> ${response.status}${bag ? ` ${bag}` : ""}`);
        pagesFetched += 1;
        if (response.status !== 200) {
          if (page === 1 && seenIds.size === 0) {
            httpError = true;
          } else {
            coverageTruncated = true;
            stopReasons.push("http_error");
            notes.push(`${pageUrl} coverage_truncated=http_error`);
          }
          break;
        }
        const inspection = inspectLunHtml(response.bodyText);
        hasJsonLd = hasJsonLd || inspection.hasJsonLdList;
        hasRscCards = hasRscCards || inspection.hasRscCardsMarker;
        extractedCardCount += inspection.rawCardCount;
        validatedCardCount += inspection.validatedCardCount;
        notes.push(
          `${pageUrl} integrity: rsc=${inspection.hasRscCardsMarker} jsonld=${inspection.hasJsonLdList} rawCards=${inspection.rawCardCount} validated=${inspection.validatedCardCount} kind=${inspection.resultKind} cardsParseFailed=${inspection.cardsParseFailed} payloads=${inspection.hasNextFlight}`,
        );
        const boundary = readLunWalkBoundary(response.bodyText);
        if (boundary.totalGroupedCount !== undefined && boundary.totalGroupedCount !== declaredTotal) {
          declaredTotal = boundary.totalGroupedCount;
          notes.push(`${categoryUrl} totalGroupedCount=${declaredTotal}`);
        }
        if (boundary.totalPages !== undefined && boundary.totalPages !== declaredPages) {
          declaredPages = boundary.totalPages;
          notes.push(`${categoryUrl} totalPages=${declaredPages}`);
        }
        if (inspection.resultKind !== "parser_failure") {
          schemaRejects += inspection.schemaRejectCount;
          locationNulls += inspection.locationNullCount;
        }
        if (inspection.resultKind === "parser_failure") {
          parserFailure = true;
          const capture = maybeCaptureLunFailure(
            pageUrl,
            response.bodyText,
            inspection.cardsParseFailed ? "cards_json_parse_failed" : "missing_rsc_cards_marker",
          );
          if (capture) {
            notes.push(`capture=${capture}`);
          }
          if (page === 1 && seenIds.size === 0) {
            break;
          }
          coverageTruncated = true;
          stopReasons.push("parser_failure");
          notes.push(`${pageUrl} coverage_truncated=parser_failure`);
          break;
        }
        sawStructure = true;
        for (const id of inspection.rawCardIds) {
          seenRawIds.add(id);
        }
        const ids = inspection.listings.map((listing) => listing.sourceId);
        const pageKey = [...ids].sort().join(",");
        if (ids.length > 0 && seenPageSets.has(pageKey)) {
          coverageTruncated = true;
          stopReasons.push("repeated_page");
          notes.push(`${pageUrl} coverage_truncated=repeated_page`);
          break;
        }
        seenPageSets.add(pageKey);
        for (const id of ids) {
          seenIds.add(id);
        }
        rawRows += inspection.rawCardCount;
        listings.push(...inspection.listings);
        if (inspection.listings.length === 0 && inspection.rawCardCount === 0) {
          const slotsCovered = rawRows >= (declaredTotal ?? 0);
          const premature =
            declaredTotal !== undefined &&
            declaredTotal > 0 &&
            seenRawIds.size < declaredTotal &&
            !slotsCovered;
          if (premature) {
            coverageTruncated = true;
            stopReasons.push("premature_empty");
            notes.push(
              `${pageUrl} coverage_truncated=premature_empty uniqueRawIds=${seenRawIds.size} total=${declaredTotal}`,
            );
          } else {
            categoryTerminal = true;
            notes.push(`${pageUrl} terminal=empty uniqueRawIds=${seenRawIds.size}`);
          }
          break;
        }
        if (declaredTotal !== undefined && declaredTotal > 0 && seenRawIds.size >= declaredTotal) {
          categoryTerminal = true;
          notes.push(`${categoryUrl} terminal=totalGroupedCount uniqueRawIds=${seenRawIds.size}`);
          break;
        }
        if (declaredPages !== undefined && page >= declaredPages) {
          categoryTerminal = true;
          notes.push(`${categoryUrl} terminal=totalPages page=${page}`);
          break;
        }
        if (page === safetyCap) {
          coverageTruncated = true;
          stopReasons.push("safety_cap");
          notes.push(`${categoryUrl} coverage_truncated=safety_cap`);
          break;
        }
      }
      if (!categoryTerminal) {
        boundaryReached = false;
        if (listings.length > 0) {
          coverageTruncated = true;
          if (stopReasons.length === 0) {
            stopReasons.push("incomplete");
          }
        }
      }
    }
    notes.push(`lun_pages_fetched=${pagesFetched}`);
    notes.push(`lun_schema_rejects=${schemaRejects}`);
    notes.push(`lun_location_null=${locationNulls}`);
    if (schemaRejects > 0) {
      coverageTruncated = true;
      boundaryReached = false;
      stopReasons.push("schema_reject");
    }
    if (!boundaryReached && listings.length > 0) {
      coverageTruncated = true;
      if (stopReasons.length === 0) {
        stopReasons.push("incomplete");
      }
    }

    const acquired = keepAcquiredByCategory(
      dedupe(listings),
      this.deps.acquiredCardCap ?? LUN_ACQUIRED_CARD_CAP,
    );
    const unique = acquired.kept;
    if (acquired.truncated) {
      notes.push(
        `acquired-response cap kept ${unique.length} cards; a normal first page is below the cap`,
      );
      coverageTruncated = true;
      boundaryReached = false;
      stopReasons.push("safety_cap");
    }
    // Listings from a partial walk stay processable. Completeness is coverage, not resultKind ok.
    const resultKind =
      unique.length > 0
        ? "ok"
        : coverageTruncated
          ? "valid_empty"
          : parserFailure
            ? "parser_failure"
            : httpError
              ? "http_error"
              : sawStructure
                ? "valid_empty"
                : "http_error";
    const capCoverage = coverageForAcquiredCards(unique.length, acquired.truncated);
    const coverage = {
      pagesFetched: Math.max(pagesFetched, capCoverage?.pagesFetched ?? 0),
      cardsFetched: unique.length,
      boundaryReached: boundaryReached && !coverageTruncated,
      coverageTruncated,
    };
    const healthy =
      (resultKind === "ok" || resultKind === "valid_empty") && !coverageTruncated;
    logger.info("lun.inspect", {
      count: unique.length,
      status: lastStatus,
      resultKind,
      pagesFetched,
      coverageTruncated,
    });
    return {
      listings: unique,
      transport: "embedded JSON (Next.js RSC cards + JSON-LD)",
      dataKind: "LIVE DATA",
      resultKind,
      coverage,
      ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
      rawNotes: notes,
      integrity: {
        ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
        hasExpectedMarkers: hasRscCards,
        hasJsonLd,
        hasRscCards,
        extractedCardCount,
        validatedCardCount,
        validationRatio: extractedCardCount > 0 ? validatedCardCount / extractedCardCount : 0,
      },
      health: {
        source: this.source,
        healthy,
        checkedAt: new Date(),
        latencyMs: Date.now() - started,
        ...(healthy ? { resultKind } : {}),
        ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
        transport: "embedded JSON (Next.js RSC cards + JSON-LD)",
        message: coverageTruncated
          ? `LUN coverage_degraded: ${stopReasons[0] ?? "incomplete"} kept ${unique.length} listings`
          : messageFor(resultKind, unique.length, lastStatus),
      },
    };
  }
}

function messageFor(
  kind: "ok" | "valid_empty" | "parser_failure" | "http_error",
  count: number,
  status: number | undefined,
): string {
  if (kind === "parser_failure") {
    return "LUN parser failure: HTTP 200 but expected realties.cards structure missing or unreadable";
  }
  if (kind === "valid_empty") {
    return "LUN VALID_EMPTY_RESULT: page structure present, zero cards";
  }
  if (kind === "ok") {
    return `LUN returned ${count} listings`;
  }
  return `LUN HTTP error (${status ?? "n/a"})`;
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
