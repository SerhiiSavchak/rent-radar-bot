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

const LUN_FLATS = "https://lun.ua/rent/lviv/flats-bez-poserednykiv";
const LUN_HOUSES = "https://lun.ua/rent/lviv/houses";

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
        `${page} integrity: rsc=${inspection.hasRscCardsMarker} jsonld=${inspection.hasJsonLdList} rawCards=${inspection.rawCardCount} validated=${inspection.validatedCardCount} kind=${inspection.resultKind} cardsParseFailed=${inspection.cardsParseFailed} payloads=${inspection.hasNextFlight}`,
      );
      if (inspection.resultKind === "parser_failure") {
        parserFailure = true;
        const capture = maybeCaptureLunFailure(
          page,
          response.bodyText,
          inspection.cardsParseFailed ? "cards_json_parse_failed" : "missing_rsc_cards_marker",
        );
        if (capture) {
          notes.push(`capture=${capture}`);
        }
        continue;
      }
      sawStructure = true;
      const perPage = Math.max(3, Math.ceil((options?.limit ?? 10) / pages.length));
      listings.push(...inspection.listings.slice(0, perPage));
    }

    const unique = dedupe(listings).slice(0, options?.limit ?? 10);
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
