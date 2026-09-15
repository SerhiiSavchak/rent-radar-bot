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

const LUN_FLATS = "https://lun.ua/rent/lviv/flats-bez-poserednykiv";
const LUN_HOUSES = "https://lun.ua/rent/lviv/houses";

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
    const pages: string[] = [];
    if (options?.includeApartments !== false) {
      pages.push(LUN_FLATS);
    }
    if (options?.includeHouses !== false) {
      pages.push(LUN_HOUSES);
    }

    const listings: Listing[] = [];
    let lastStatus: number | undefined;
    let parserFailure = false;
    let httpError = false;
    let sawStructure = false;
    let extractedCardCount = 0;
    let validatedCardCount = 0;
    let hasJsonLd = false;
    let hasRscCards = false;

    for (const page of pages) {
      const response = await httpGet(page, {
        timeoutMs: config.sourceTimeoutMs,
        maxRetries: config.sourceMaxRetries,
      });
      lastStatus = response.status;
      notes.push(`${page} -> ${response.status} ${headerBag(response)}`);
      if (response.status !== 200) {
        httpError = true;
        continue;
      }
      const inspection = inspectLunHtml(response.bodyText);
      hasJsonLd = hasJsonLd || inspection.hasJsonLdList;
      hasRscCards = hasRscCards || inspection.hasRscCardsMarker;
      extractedCardCount += inspection.rawCardCount;
      validatedCardCount += inspection.validatedCardCount;
      notes.push(
        `${page} integrity: rsc=${inspection.hasRscCardsMarker} jsonld=${inspection.hasJsonLdList} rawCards=${inspection.rawCardCount} validated=${inspection.validatedCardCount} kind=${inspection.resultKind}`,
      );
      if (inspection.resultKind === "parser_failure") {
        parserFailure = true;
        continue;
      }
      sawStructure = true;
      const perPage = Math.max(3, Math.ceil((options?.limit ?? 10) / pages.length));
      listings.push(...inspection.listings.slice(0, perPage));
    }

    const unique = dedupe(listings).slice(0, options?.limit ?? 10);
    const resultKind = parserFailure
      ? "parser_failure"
      : httpError && unique.length === 0
        ? "http_error"
        : unique.length === 0 && sawStructure
          ? "valid_empty"
          : unique.length > 0
            ? "ok"
            : "http_error";
    const healthy = resultKind === "ok" || resultKind === "valid_empty";
    logger.info("lun.inspect", { count: unique.length, status: lastStatus, resultKind });
    return {
      listings: unique,
      transport: "embedded JSON (Next.js RSC cards + JSON-LD)",
      dataKind: "LIVE DATA",
      resultKind,
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
        resultKind,
        ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
        transport: "embedded JSON (Next.js RSC cards + JSON-LD)",
        message: messageFor(resultKind, unique.length, lastStatus),
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
    return "LUN parser failure: HTTP 200 but expected realties.cards structure missing";
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
