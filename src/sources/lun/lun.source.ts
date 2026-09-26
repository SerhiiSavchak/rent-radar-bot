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
 * Live-verified 2026-09-26: `?page=2` returns novel listing ids vs page 1
 * (3/3 workstation cycles). Path `/page/2` is 404; `?offset=24` duplicates page 1.
 */
export const LUN_POLL_PAGE_BUDGET = 2;

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
    const pageBudget = Math.max(1, Math.min(LUN_POLL_PAGE_BUDGET, 3));
    notes.push(`lun_page_budget=${pageBudget}`);
    notes.push("lun_pagination=query_page_live_verified_2026-09-26");

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

    for (const categoryUrl of categories) {
      for (let page = 1; page <= pageBudget; page += 1) {
        const pageUrl = buildLunCategoryPageUrl(categoryUrl, page);
        const response = await httpGet(pageUrl, {
          timeoutMs: config.sourceTimeoutMs,
          maxRetries: config.sourceMaxRetries,
        });
        lastStatus = response.status;
        notes.push(`${pageUrl} -> ${response.status} ${headerBag(response)}`);
        if (response.status !== 200) {
          httpError = true;
          if (page === 1) {
            break;
          }
          // Deeper-page transport loss after page-1 success → partial coverage.
          coverageTruncated = true;
          notes.push(`${pageUrl} coverage_truncated=deeper_http`);
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
          if (page === 1) {
            break;
          }
          coverageTruncated = true;
          notes.push(`${pageUrl} coverage_truncated=deeper_parser`);
          break;
        }
        sawStructure = true;
        pagesFetched += 1;
        listings.push(...inspection.listings);
        if (inspection.listings.length === 0) {
          // Confirmed empty deeper page — category walk complete within budget.
          break;
        }
        if (page === pageBudget) {
          // Bounded sample only (no LUN catch-up cursor). Do not flip coverage_degraded
          // every poll just because the catalog has more than pageBudget pages.
          notes.push(`${categoryUrl} sample_complete_within_budget=true deeper_pages_may_exist`);
        }
      }
    }
    notes.push(`lun_pages_fetched=${pagesFetched}`);

    const acquired = keepAcquiredByCategory(dedupe(listings));
    const unique = acquired.kept;
    if (acquired.truncated) {
      notes.push(
        `acquired-response cap kept ${unique.length} cards; a normal first page is below the cap`,
      );
      coverageTruncated = true;
    }
    // Partial success: if any page yielded listings, prefer ok over masking as parser_failure.
    const resultKind =
      unique.length > 0
        ? "ok"
        : parserFailure
          ? "parser_failure"
          : httpError
            ? "http_error"
            : sawStructure
              ? "valid_empty"
              : "http_error";
    const capCoverage = coverageForAcquiredCards(unique.length, acquired.truncated);
    const coverage =
      coverageTruncated || capCoverage
        ? {
            pagesFetched: Math.max(pagesFetched, capCoverage?.pagesFetched ?? 1),
            cardsFetched: unique.length,
            boundaryReached: false,
            coverageTruncated: true,
          }
        : undefined;
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
      ...(coverage ? { coverage } : {}),
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
        resultKind: coverageTruncated && resultKind === "ok" ? "ok" : resultKind,
        ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
        transport: "embedded JSON (Next.js RSC cards + JSON-LD)",
        message: coverageTruncated
          ? `LUN partial coverage: kept ${unique.length} listings (cap or deeper-page failure)`
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
