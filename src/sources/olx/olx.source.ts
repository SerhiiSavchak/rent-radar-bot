import type { Listing } from "../../domain/listing.ts";
import type {
  FetchListingsOptions,
  ListingSourceAdapter,
  SourceFetchResult,
  SourceHealth,
} from "../../domain/source.ts";
import { getConfig } from "../../config/env.ts";
import {
  deriveOlxInspectResultKind,
  OLX_HTML_APARTMENTS_URL,
  selectOlxHtmlFallbackUrl,
} from "../../probe/olx-experiment-classify.ts";
import { AppError } from "../../utils/errors.ts";
import { headerBag, httpGet } from "../../utils/http.ts";
import { logger } from "../../utils/logger.ts";
import { parseOlxOffersPayload } from "./olx.parser.ts";

/**
 * Geo/category ids verified live on 2026-09-15 against public OLX endpoints
 * (from an environment where ordinary HTTP was not blocked):
 * - `/api/v1/geo-encoder/regions/`: 5 = Львівська область (the previous hardcoded
 *   region_id=12 was Черкаська область and city_id=13 was Краснодон, Луганська обл.).
 * - `/api/v1/geo-encoder/regions/5/cities/`: 176 = Львів.
 * - category 1760 = довгострокова оренда квартир (`.../kvartiry/dolgosrochnaya-arenda-kvartir/`).
 * - category 330 = довгострокова оренда будинків (`.../doma/arenda-domov/`; the previous
 *   hardcoded 1758 was «Продаж квартир»). Confirmed via `/api/v1/offers/<id>` category.id.
 * - `distance=15` expands the search ~15 km around the city; verified to return suburb
 *   listings (Солонка, Сокільники, Брюховичі, Зимна Вода, ...) with their own city ids.
 */
export const OLX_REGION_ID_LVIV_OBLAST = 5;
export const OLX_CITY_ID_LVIV = 176;
export const OLX_DISTANCE_KM = 15;
export const OLX_CATEGORY_APARTMENTS_LONG_TERM_RENT = 1760;
export const OLX_CATEGORY_HOUSES_LONG_TERM_RENT = 330;

export function buildOlxOffersUrl(categoryId: number, limit = 10): string {
  const params = new URLSearchParams({
    offset: "0",
    limit: String(limit),
    category_id: String(categoryId),
    region_id: String(OLX_REGION_ID_LVIV_OBLAST),
    city_id: String(OLX_CITY_ID_LVIV),
    distance: String(OLX_DISTANCE_KM),
    sort_by: "created_at:desc",
  });
  return `https://www.olx.ua/api/v1/offers/?${params.toString()}`;
}

const OLX_APARTMENTS_URL = buildOlxOffersUrl(OLX_CATEGORY_APARTMENTS_LONG_TERM_RENT);
const OLX_HOUSES_URL = buildOlxOffersUrl(OLX_CATEGORY_HOUSES_LONG_TERM_RENT);

export class OlxSource implements ListingSourceAdapter {
  readonly source = "olx" as const;

  async healthCheck(): Promise<SourceHealth> {
    const started = Date.now();
    const response = await httpGet(OLX_HTML_APARTMENTS_URL, {
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

    let lastApiStatus: number | undefined;
    let lastHtmlStatus: number | undefined;
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
      lastApiStatus = response.status;
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
      const htmlUrl = selectOlxHtmlFallbackUrl(options);
      const html = await httpGet(htmlUrl, {
        timeoutMs: config.sourceTimeoutMs,
        maxRetries: 0,
      });
      lastHtmlStatus = html.status;
      transport = "HTTP HTML";
      notes.push(`HTML ${htmlUrl} -> ${html.status} ${headerBag(html)}`);
      if (html.status === 200) {
        notes.push(
          "HTML reached, but Phase 0 does not scrape brittle OLX CSS cards without JSON. HTML 200 is not successful OLX API access.",
        );
      }
    }

    const unique = dedupe(listings).slice(0, options?.limit ?? 10);
    const resultKind = deriveOlxInspectResultKind({
      listingCount: unique.length,
      jsonSucceeded,
      notes,
      ...(lastApiStatus !== undefined ? { apiStatus: lastApiStatus } : {}),
      ...(lastHtmlStatus !== undefined ? { htmlStatus: lastHtmlStatus } : {}),
    });
    // Prefer API status when JSON failed — HTML 200 must not mask CloudFront 403.
    const reportedStatus =
      jsonSucceeded || unique.length > 0
        ? lastApiStatus
        : lastApiStatus !== undefined && lastApiStatus !== 200
          ? lastApiStatus
          : (lastHtmlStatus ?? lastApiStatus);
    const healthy = resultKind === "ok" || resultKind === "valid_empty";
    logger.info("olx.inspect", {
      status: reportedStatus,
      count: unique.length,
      transport,
      resultKind,
    });

    return {
      listings: unique,
      transport,
      dataKind: "LIVE DATA",
      resultKind,
      ...(reportedStatus !== undefined ? { httpStatus: reportedStatus } : {}),
      rawNotes: notes,
      health: {
        source: this.source,
        healthy,
        checkedAt: new Date(),
        latencyMs: Date.now() - started,
        resultKind,
        ...(reportedStatus !== undefined ? { httpStatus: reportedStatus } : {}),
        transport,
        message: healthy
          ? `OLX returned ${unique.length} listings via ${transport}`
          : reportedStatus === 403
            ? "OLX CloudFront/WAF returned 403 for ordinary Node.js HTTP. No anti-bot bypass was attempted."
            : `OLX did not return listings (HTTP ${reportedStatus ?? "n/a"})`,
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
