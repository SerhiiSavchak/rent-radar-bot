import type { Listing } from "../../domain/listing.ts";
import type {
  FetchListingsOptions,
  FetchResultKind,
  ListingSourceAdapter,
  SourceFetchResult,
  SourceHealth,
} from "../../domain/source.ts";
import { getConfig } from "../../config/env.ts";
import { AppError } from "../../utils/errors.ts";
import { httpGet } from "../../utils/http.ts";
import { logger } from "../../utils/logger.ts";
import { bindingPollIntervalSeconds, decideDomriaTransport } from "./domria-budget.ts";
import {
  acquireDomriaNewest,
  buildDomriaNewestSearchUrl,
  parseDomriaSearchIds,
  type DomriaNewestCategory,
} from "./domria-newest.ts";
import { extractInitialStateJson, parseDomriaInfo } from "./domria.parser.ts";
import { domriaSearchResponseSchema } from "./domria.types.ts";
import { coverageForAcquiredCards, keepAcquiredByCategory } from "../../delivery/catalog-sample.ts";

export class DomriaSource implements ListingSourceAdapter {
  readonly source = "domria" as const;

  async healthCheck(): Promise<SourceHealth> {
    const started = Date.now();
    const config = getConfig();
    const response = await httpGet(buildDomriaNewestSearchUrl("apartment"), {
      timeoutMs: config.sourceTimeoutMs,
      maxRetries: 0,
      headers: { Accept: "application/json" },
    });
    const parsed = response.status === 200 ? parseDomriaSearchIds(response.bodyText) : undefined;
    const healthy = response.status === 200 && parsed?.ok === true;
    return {
      source: this.source,
      healthy,
      checkedAt: new Date(),
      latencyMs: Date.now() - started,
      httpStatus: response.status,
      transport: "public newest-first searchEngine",
      message: healthy
        ? "DIM.RIA newest-first search reachable"
        : response.bodyText.slice(0, 200),
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

    const decision = decideDomriaTransport({
      mode: config.domriaAcquisition,
      hasApiKey: Boolean(config.domriaApiKey),
      intervalSeconds: bindingPollIntervalSeconds(config),
      searchesPerPoll: 2,
      infoPerPoll: config.domriaMaxInfoPerPoll,
    });
    notes.push(decision.reason);

    if (decision.transport === "official" && config.domriaApiKey) {
      const api = await this.fetchOfficial(
        config.domriaApiKey,
        options,
        notes,
        config.domriaMaxInfoPerPoll,
      );
      if (api.listings.length > 0) {
        return finish(api.listings, started, "official API", api.status, notes, {
          structurePresent: true,
        });
      }
      notes.push("Official API did not yield listings; using public HTML.");
    }

    if (!config.domriaUsePublicHtmlFallback && decision.transport !== "html") {
      return finish([], started, "official API", undefined, notes, {
        forceUnhealthy: true,
      });
    }
    if (!config.domriaUsePublicHtmlFallback && config.domriaAcquisition === "html") {
      notes.push("DOMRIA_USE_PUBLIC_HTML_FALLBACK=false disables the production HTML path.");
      return finish([], started, "public HTML", undefined, notes, {
        forceUnhealthy: true,
      });
    }

    const categories: DomriaNewestCategory[] = [];
    if (options?.includeApartments !== false) {
      categories.push("apartment");
    }
    if (options?.includeHouses !== false) {
      categories.push("house");
    }
    const acquired = await acquireDomriaNewest({
      categories,
      knownIds: new Set(options?.domriaKnownIds ?? []),
      extractState: extractInitialStateJson,
      get: async (url) => {
        const response = await httpGet(url, {
          timeoutMs: config.sourceTimeoutMs,
          maxRetries: 0,
          headers: { Accept: "application/json,text/html;q=0.9,*/*;q=0.8" },
        });
        return { status: response.status, url: response.url, bodyText: response.bodyText };
      },
    });
    notes.push(...acquired.notes);
    const finished = finish(
      acquired.listings,
      started,
      "public newest-first searchEngine",
      acquired.lastStatus,
      notes,
      {
        structurePresent: acquired.structurePresent && !acquired.parserFailure,
        parserFailure: acquired.parserFailure,
        httpError: acquired.httpError,
      },
    );
    return {
      ...finished,
      coverage: {
        pagesFetched: categories.length,
        cardsFetched: finished.listings.length,
        boundaryReached: acquired.boundaryReached,
        coverageTruncated: acquired.coverageTruncated || Boolean(finished.coverage?.coverageTruncated),
        ...(acquired.persistIds ? { retainedSourceIds: acquired.persistIds } : {}),
      },
      health: {
        ...finished.health,
        healthy: finished.health.healthy && acquired.boundaryReached && !acquired.coverageTruncated,
      },
    };
  }

  private async fetchOfficial(
    apiKey: string,
    options: FetchListingsOptions | undefined,
    notes: string[],
    infoCap: number,
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
    const uniqueIds = [...new Set(ids)].slice(0, Math.max(0, infoCap));
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

/** Pure resultKind for soak/Telegram — must never be left unset when listings exist. */
export function deriveDomriaInspectResultKind(input: {
  listingCount: number;
  httpStatus?: number;
  forceUnhealthy?: boolean;
  /** Catalog array was present. Empty array is valid_empty, missing array is parser_failure. */
  structurePresent?: boolean;
  parserFailure?: boolean;
  httpError?: boolean;
}): FetchResultKind {
  if (input.forceUnhealthy) {
    return "http_error";
  }
  if (input.listingCount > 0) {
    return "ok";
  }
  if (input.parserFailure) {
    return "parser_failure";
  }
  if (input.httpError || (input.httpStatus !== undefined && input.httpStatus !== 200)) {
    return "http_error";
  }
  if (input.structurePresent) {
    return "valid_empty";
  }
  return "parser_failure";
}

function finish(
  listings: Listing[],
  started: number,
  transport: string,
  status: number | undefined,
  notes: string[],
  flags: {
    forceUnhealthy?: boolean;
    structurePresent?: boolean;
    parserFailure?: boolean;
    httpError?: boolean;
  } = {},
): SourceFetchResult {
  const acquired = keepAcquiredByCategory(dedupe(listings));
  const unique = acquired.kept;
  if (acquired.truncated) {
    notes.push(
      `acquired-response cap kept ${unique.length} cards; a normal first page is below the cap`,
    );
  }
  const resultKind = deriveDomriaInspectResultKind({
    listingCount: unique.length,
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(flags.forceUnhealthy ? { forceUnhealthy: true } : {}),
    ...(flags.structurePresent ? { structurePresent: true } : {}),
    ...(flags.parserFailure ? { parserFailure: true } : {}),
    ...(flags.httpError ? { httpError: true } : {}),
  });
  const capCoverage = coverageForAcquiredCards(unique.length, acquired.truncated);
  const healthyFinal =
    (resultKind === "ok" || resultKind === "valid_empty") && !acquired.truncated;
  logger.info("domria.inspect", { transport, count: unique.length, status, resultKind });
  return {
    listings: unique,
    transport,
    dataKind: "LIVE DATA",
    resultKind,
    ...(capCoverage ? { coverage: capCoverage } : {}),
    ...(status !== undefined ? { httpStatus: status } : {}),
    rawNotes: notes,
    health: {
      source: "domria",
      healthy: healthyFinal,
      checkedAt: new Date(),
      latencyMs: Date.now() - started,
      resultKind,
      ...(status !== undefined ? { httpStatus: status } : {}),
      transport,
      message:
        resultKind === "valid_empty"
          ? "DIM.RIA VALID_EMPTY_RESULT: catalog structure present, zero listings"
          : healthyFinal
            ? `DIM.RIA returned ${unique.length} listings via ${transport}`
            : (notes[0] ?? "DIM.RIA returned no listings"),
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
