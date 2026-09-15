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
import { parseLunHtml } from "./lun.parser.ts";

const LUN_FLATS = "https://lun.ua/rent/lviv/flats-bez-poserednykiv";
const LUN_HOUSES = "https://lun.ua/rent/lviv/houses";

export class LunSource implements ListingSourceAdapter {
  readonly source = "lun" as const;

  async healthCheck(): Promise<SourceHealth> {
    const started = Date.now();
    const response = await httpGet(LUN_FLATS, {
      timeoutMs: getConfig().sourceTimeoutMs,
      maxRetries: 0,
    });
    return {
      source: this.source,
      healthy: response.status === 200,
      checkedAt: new Date(),
      latencyMs: Date.now() - started,
      httpStatus: response.status,
      transport: "HTTP HTML + embedded JSON-LD/RSC",
      message: response.status === 200 ? "LUN search page reachable" : `LUN HTTP ${response.status}`,
    };
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
    for (const page of pages) {
      const response = await httpGet(page, {
        timeoutMs: config.sourceTimeoutMs,
        maxRetries: config.sourceMaxRetries,
      });
      lastStatus = response.status;
      notes.push(`${page} -> ${response.status} ${headerBag(response)}`);
      if (response.status !== 200) {
        continue;
      }
      listings.push(...parseLunHtml(response.bodyText).slice(0, Math.max(3, Math.ceil((options?.limit ?? 10) / pages.length))));
    }

    const unique = dedupe(listings).slice(0, options?.limit ?? 10);
    const healthy = unique.length > 0;
    logger.info("lun.inspect", { count: unique.length, status: lastStatus });
    return {
      listings: unique,
      transport: "embedded JSON (Next.js RSC cards + JSON-LD)",
      dataKind: "LIVE DATA",
      ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
      rawNotes: notes,
      health: {
        source: this.source,
        healthy,
        checkedAt: new Date(),
        latencyMs: Date.now() - started,
        ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
        transport: "embedded JSON (Next.js RSC cards + JSON-LD)",
        message: healthy
          ? `LUN returned ${unique.length} listings`
          : `LUN did not return listings (HTTP ${lastStatus ?? "n/a"})`,
      },
    };
  }
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
