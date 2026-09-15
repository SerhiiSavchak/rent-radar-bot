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
import { extractInitialStateJson, parseDomriaCatalog, parseDomriaInfo } from "./domria.parser.ts";
import { domriaSearchResponseSchema } from "./domria.types.ts";

const APARTMENTS_HTML = "https://dom.ria.com/uk/arenda-kvartir/lvov/";
const HOUSES_HTML = "https://dom.ria.com/uk/arenda-domov/lvov/";

export class DomriaSource implements ListingSourceAdapter {
  readonly source = "domria" as const;

  async healthCheck(): Promise<SourceHealth> {
    const started = Date.now();
    const config = getConfig();
    if (config.domriaApiKey) {
      const url = `https://developers.ria.com/dom/search?api_key=${encodeURIComponent(config.domriaApiKey)}&category=1&realty_type=2&operation_type=3&state_id=5&city_id=5`;
      const response = await httpGet(url, { timeoutMs: config.sourceTimeoutMs, maxRetries: 0 });
      return {
        source: this.source,
        healthy: response.status === 200,
        checkedAt: new Date(),
        latencyMs: Date.now() - started,
        httpStatus: response.status,
        transport: "official API",
        message: response.status === 200 ? "DIM.RIA official API reachable" : response.bodyText.slice(0, 200),
      };
    }
    const response = await httpGet(APARTMENTS_HTML, { timeoutMs: config.sourceTimeoutMs, maxRetries: 0 });
    return {
      source: this.source,
      healthy: response.status === 200,
      checkedAt: new Date(),
      latencyMs: Date.now() - started,
      httpStatus: response.status,
      transport: "public HTML",
      message: config.domriaApiKey
        ? undefined
        : "DOM.RIA live official API requires DOMRIA_API_KEY; public HTML fallback used for health",
    };
  }

  async fetchLatest(options?: FetchListingsOptions): Promise<Listing[]> {
    const result = await this.inspectLatest(options);
    if (!result.health.healthy) {
      throw new AppError({
        code: "DOMRIA_UNAVAILABLE",
        message: result.health.message ?? "DIM.RIA fetch failed",
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

    if (config.domriaApiKey) {
      const api = await this.fetchOfficial(config.domriaApiKey, options, notes);
      if (api.listings.length > 0) {
        return finish(api.listings, started, "official API", api.status, notes, options?.limit);
      }
      notes.push("Official API did not yield listings; considering public HTML fallback.");
    } else {
      notes.push("DOM.RIA live test requires DOMRIA_API_KEY for the official developers.ria.com API.");
    }

    if (!config.domriaUsePublicHtmlFallback) {
      return finish([], started, "official API", undefined, notes, options?.limit, false);
    }

    const htmlListings: Listing[] = [];
    const pages: string[] = [];
    if (options?.includeApartments !== false) {
      pages.push(APARTMENTS_HTML);
    }
    if (options?.includeHouses !== false) {
      pages.push(HOUSES_HTML);
    }
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
      try {
        const state = extractInitialStateJson(response.bodyText);
        const parsed = parseDomriaCatalog(state);
        const perPage = Math.max(3, Math.ceil((options?.limit ?? 10) / pages.length));
        htmlListings.push(...parsed.slice(0, perPage));
      } catch (error) {
        notes.push(`HTML parse failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return finish(htmlListings, started, "public HTML embedded JSON", lastStatus, notes, options?.limit);
  }

  private async fetchOfficial(
    apiKey: string,
    options: FetchListingsOptions | undefined,
    notes: string[],
  ): Promise<{ listings: Listing[]; status?: number }> {
    const searches: Array<{ label: string; url: string }> = [];
    if (options?.includeApartments !== false) {
      searches.push({
        label: "apartments",
        url: `https://developers.ria.com/dom/search?api_key=${encodeURIComponent(apiKey)}&category=1&realty_type=2&operation_type=3&state_id=5&city_id=5&page=0`,
      });
    }
    if (options?.includeHouses !== false) {
      searches.push({
        label: "houses",
        url: `https://developers.ria.com/dom/search?api_key=${encodeURIComponent(apiKey)}&category=4&realty_type=5&operation_type=3&state_id=5&city_id=5&page=0`,
      });
    }
    const ids: number[] = [];
    let status: number | undefined;
    for (const search of searches) {
      const response = await httpGet(search.url, {
        timeoutMs: getConfig().sourceTimeoutMs,
        maxRetries: getConfig().sourceMaxRetries,
        headers: { Accept: "application/json" },
      });
      status = response.status;
      notes.push(`official search ${search.label} -> ${response.status}`);
      if (response.status !== 200) {
        notes.push(response.bodyText.slice(0, 300));
        continue;
      }
      const parsed = domriaSearchResponseSchema.safeParse(JSON.parse(response.bodyText) as unknown);
      if (!parsed.success) {
        notes.push(`search schema mismatch for ${search.label}`);
        continue;
      }
      for (const item of parsed.data.items ?? []) {
        const id = Number(item);
        if (Number.isFinite(id)) {
          ids.push(id);
        }
      }
    }
    const uniqueIds = [...new Set(ids)].slice(0, Math.min(options?.limit ?? 8, 8));
    const listings: Listing[] = [];
    for (const id of uniqueIds) {
      const infoUrl = `https://developers.ria.com/dom/info/${id}?api_key=${encodeURIComponent(apiKey)}`;
      const response = await httpGet(infoUrl, {
        timeoutMs: getConfig().sourceTimeoutMs,
        maxRetries: 1,
        headers: { Accept: "application/json" },
      });
      notes.push(`official info ${id} -> ${response.status}`);
      if (response.status !== 200) {
        continue;
      }
      const listing = parseDomriaInfo(JSON.parse(response.bodyText) as unknown);
      if (listing) {
        listings.push(listing);
      }
    }
    return { listings, ...(status !== undefined ? { status } : {}) };
  }
}

function finish(
  listings: Listing[],
  started: number,
  transport: string,
  status: number | undefined,
  notes: string[],
  limit?: number,
  forceHealthy?: boolean,
): SourceFetchResult {
  const unique = dedupe(listings).slice(0, limit ?? 10);
  const healthy = forceHealthy === false ? false : unique.length > 0;
  logger.info("domria.inspect", { transport, count: unique.length, status });
  return {
    listings: unique,
    transport,
    dataKind: "LIVE DATA",
    ...(status !== undefined ? { httpStatus: status } : {}),
    rawNotes: notes,
    health: {
      source: "domria",
      healthy,
      checkedAt: new Date(),
      latencyMs: Date.now() - started,
      ...(status !== undefined ? { httpStatus: status } : {}),
      transport,
      message: healthy
        ? `DIM.RIA returned ${unique.length} listings via ${transport}`
        : notes[0] ?? "DIM.RIA returned no listings",
    },
  };
}

function dedupe(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  return listings.filter((listing) => {
    const key = listing.sourceId;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
