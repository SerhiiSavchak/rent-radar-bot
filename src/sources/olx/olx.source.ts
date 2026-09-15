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
import { parseOlxOffersPayload } from "./olx.parser.ts";

const OLX_APARTMENTS_URL =
  "https://www.olx.ua/api/v1/offers/?offset=0&limit=10&category_id=1760&region_id=12&city_id=13&sort_by=created_at:desc";
const OLX_HOUSES_URL =
  "https://www.olx.ua/api/v1/offers/?offset=0&limit=10&category_id=1758&region_id=12&city_id=13&sort_by=created_at:desc";
const OLX_HTML_URL =
  "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/";

export class OlxSource implements ListingSourceAdapter {
  readonly source = "olx" as const;

  async healthCheck(): Promise<SourceHealth> {
    const started = Date.now();
    const response = await httpGet(OLX_HTML_URL, {
      timeoutMs: getConfig().sourceTimeoutMs,
      maxRetries: 0,
    });
    return {
      source: this.source,
      healthy: response.status === 200,
      checkedAt: new Date(),
      latencyMs: Date.now() - started,
      httpStatus: response.status,
      transport: "HTTP HTML",
      message:
        response.status === 200
          ? "OLX HTML reachable"
          : `OLX blocked or unavailable (${response.status})`,
    };
  }

  async fetchLatest(options?: FetchListingsOptions): Promise<Listing[]> {
    const result = await this.inspectLatest(options);
    if (!result.health.healthy) {
      throw new AppError({
        code: "OLX_UNAVAILABLE",
        message: result.health.message ?? "OLX fetch failed",
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
    const urls: string[] = [];
    if (options?.includeApartments !== false) {
      urls.push(OLX_APARTMENTS_URL);
    }
    if (options?.includeHouses !== false) {
      urls.push(OLX_HOUSES_URL);
    }

    let lastStatus: number | undefined;
    const listings: Listing[] = [];
    let transport = "public JSON API api/v1/offers";
    let jsonSucceeded = false;

    for (const url of urls) {
      const response = await httpGet(url, {
        timeoutMs: config.sourceTimeoutMs,
        maxRetries: config.sourceMaxRetries,
        headers: {
          Accept: "application/json",
          Referer: "https://www.olx.ua/",
        },
      });
      lastStatus = response.status;
      notes.push(`${url} -> ${response.status} ${headerBag(response)}`);
      if (response.status === 200) {
        try {
          const payload: unknown = JSON.parse(response.bodyText);
          const parsed = parseOlxOffersPayload(payload);
          listings.push(...parsed);
          if (parsed.length > 0) {
            jsonSucceeded = true;
          } else {
            notes.push(`JSON 200 but no offers parsed. Body starts: ${response.bodyText.slice(0, 180)}`);
          }
        } catch (error) {
          notes.push(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (!jsonSucceeded) {
      const html = await httpGet(OLX_HTML_URL, {
        timeoutMs: config.sourceTimeoutMs,
        maxRetries: 0,
      });
      lastStatus = html.status;
      transport = "HTTP HTML";
      notes.push(`HTML ${OLX_HTML_URL} -> ${html.status} ${headerBag(html)}`);
      if (html.status === 200) {
        notes.push("HTML reached, but Phase 0 does not scrape brittle OLX CSS cards without JSON.");
      }
    }

    const unique = dedupe(listings).slice(0, options?.limit ?? 10);
    const resultKind =
      unique.length > 0
        ? "ok"
        : lastStatus !== undefined && lastStatus !== 200
          ? "http_error"
          : jsonSucceeded
            ? "valid_empty"
            : "parser_failure";
    const healthy = resultKind === "ok" || resultKind === "valid_empty";
    logger.info("olx.inspect", {
      status: lastStatus,
      count: unique.length,
      transport,
      resultKind,
    });

    return {
      listings: unique,
      transport,
      dataKind: "LIVE DATA",
      resultKind,
      ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
      rawNotes: notes,
      health: {
        source: this.source,
        healthy,
        checkedAt: new Date(),
        latencyMs: Date.now() - started,
        resultKind,
        ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
        transport,
        message: healthy
          ? `OLX returned ${unique.length} listings via ${transport}`
          : lastStatus === 403
            ? "OLX CloudFront/WAF returned 403 for ordinary Node.js HTTP. No anti-bot bypass was attempted."
            : `OLX did not return listings (HTTP ${lastStatus ?? "n/a"})`,
      },
    };
  }
}

function dedupe(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  const result: Listing[] = [];
  for (const listing of listings) {
    const key = `${listing.source}:${listing.sourceId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(listing);
  }
  return result;
}
