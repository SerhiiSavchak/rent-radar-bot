import type { Listing } from "../../domain/listing.ts";
import { parseDomriaInfo } from "./domria.parser.ts";
import { domriaSearchResponseSchema } from "./domria.types.ts";

/** First searchEngine page only. Deep history is not pulled every poll. */
export const DOMRIA_NEWEST_PAGE_LIMIT = 20;

/** New listing pages per category per poll. Known ids do not spend this cap. */
export const DOMRIA_NEWEST_DETAIL_CAP = 8;

export const DOMRIA_ACQUIRED_IDS_KEY = "domria_acquired_ids";

export const DOMRIA_ACQUIRED_ID_MEMORY = 160;

export type DomriaNewestCategory = "apartment" | "house";

const SEARCH_ORIGIN = "https://dom.ria.com/node/searchEngine/v2/";

/**
 * Public newest-first request observed by selecting «Спочатку нові».
 * Apartments: category=1, realty_type=2. Houses: category=4, realty_type=0.
 * Both use sort=created_at. The bare catalog URLs are not this request.
 */
export function buildDomriaNewestSearchUrl(category: DomriaNewestCategory): string {
  const params = new URLSearchParams({
    addMoreRealty: "false",
    excludeSold: "1",
    category: category === "apartment" ? "1" : "4",
    realty_type: category === "apartment" ? "2" : "0",
    operation: "3",
    state_id: "5",
    in_radius: "0",
    with_newbuilds: "0",
    price_cur: "1",
    wo_dupl: "1",
    complex_inspected: "0",
    sort: "created_at",
    period: "0",
    notFirstFloor: "0",
    notLastFloor: "0",
    with_map: "0",
    photos_count_from: "0",
    with_video_only: "0",
    firstIteraction: "false",
    fromAmp: "0",
    page: "0",
    limit: String(DOMRIA_NEWEST_PAGE_LIMIT),
    city_ids: "5",
    operation_type: "3",
    client: "searchV2",
    ch: "246_244",
    mobileStatus: "0",
  });
  return `${SEARCH_ORIGIN}?${params.toString()}`;
}

export function buildDomriaRealtyDataUrl(id: string): string {
  return `https://dom.ria.com/realty/data/${encodeURIComponent(id)}?lang_id=4`;
}

export function buildDomriaListingPageUrl(beautifulUrl: string): string {
  if (beautifulUrl.startsWith("http")) {
    return beautifulUrl;
  }
  return `https://dom.ria.com/uk/${beautifulUrl.replace(/^\//, "")}`;
}

export type DomriaDetailPlan = {
  toFetch: string[];
  skippedKnown: string[];
  deferred: string[];
};

/** Walk the returned id list. Do not stop because an earlier id has an older date. */
export function planDomriaDetailFetches(
  ids: readonly string[],
  knownIds: ReadonlySet<string>,
  cap = DOMRIA_NEWEST_DETAIL_CAP,
): DomriaDetailPlan {
  const toFetch: string[] = [];
  const skippedKnown: string[] = [];
  const deferred: string[] = [];
  for (const id of ids) {
    if (knownIds.has(id)) {
      skippedKnown.push(id);
      continue;
    }
    if (toFetch.length < cap) {
      toFetch.push(id);
      continue;
    }
    deferred.push(id);
  }
  return { toFetch, skippedKnown, deferred };
}

export function parseDomriaAcquiredIds(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item !== "");
  } catch {
    return [];
  }
}

export function mergeDomriaAcquiredIds(
  previous: readonly string[],
  fetched: readonly string[],
  cap = DOMRIA_ACQUIRED_ID_MEMORY,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of [...previous, ...fetched]) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(id);
  }
  return merged.slice(Math.max(0, merged.length - cap));
}

export function parseDomriaSearchIds(bodyText: string):
  | { ok: true; ids: string[]; empty: boolean }
  | { ok: false } {
  let json: unknown;
  try {
    json = JSON.parse(bodyText) as unknown;
  } catch {
    return { ok: false };
  }
  const parsed = domriaSearchResponseSchema.safeParse(json);
  if (!parsed.success || !Array.isArray(parsed.data.items)) {
    return { ok: false };
  }
  const ids = parsed.data.items
    .map((item) => String(item))
    .filter((id) => /^\d+$/.test(id));
  return { ok: true, ids, empty: ids.length === 0 };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function characteristic1437(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const nested = asRecord(record.characteristics_values);
  if (nested && nested["1437"] !== undefined && nested["1437"] !== null && nested["1437"] !== "") {
    return nested["1437"];
  }
  if (record["1437"] !== undefined && record["1437"] !== null && record["1437"] !== "") {
    return record["1437"];
  }
  return undefined;
}

/**
 * Listing HTML embeds the card somewhere under __INITIAL_STATE__.
 * Characteristic 1437 may sit on the card or on a parent of that card.
 * `/realty/data/{id}` omits it and must not be treated as the role source.
 */
export function findDomriaListingState(state: unknown, realtyId: string): Record<string, unknown> | undefined {
  const parents: Record<string, unknown>[] = [];
  let found: Record<string, unknown> | undefined;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    const id = record.realty_id;
    if (id !== undefined && String(id) === realtyId) {
      const roleCarrier = [record, ...parents].find((item) => characteristic1437(item) !== undefined);
      const role = roleCarrier ? characteristic1437(roleCarrier) : undefined;
      const characteristics = asRecord(record.characteristics_values) ?? {};
      found = {
        ...record,
        characteristics_values: {
          ...characteristics,
          ...(role !== undefined ? { "1437": role } : {}),
        },
      };
      return;
    }
    parents.push(record);
    for (const value of Object.values(record)) {
      visit(value);
      if (found) {
        return;
      }
    }
    parents.pop();
  };
  visit(state);
  return found;
}

export type DomriaFetchResponse = {
  status: number;
  url: string;
  bodyText: string;
};

export type DomriaNewestAcquisition = {
  listings: Listing[];
  lastStatus?: number;
  parserFailure: boolean;
  httpError: boolean;
  structurePresent: boolean;
  notes: string[];
  /** Ids whose seller page was read. Absent when the id list itself failed. */
  persistIds?: string[];
  coverageTruncated: boolean;
  boundaryReached: boolean;
};

export async function acquireDomriaNewest(input: {
  categories: readonly DomriaNewestCategory[];
  knownIds: ReadonlySet<string>;
  get: (url: string) => Promise<DomriaFetchResponse>;
  extractState: (html: string) => unknown;
  detailCap?: number;
  discoveredAt?: Date;
}): Promise<DomriaNewestAcquisition> {
  const notes: string[] = [];
  const listings: Listing[] = [];
  const persistIds: string[] = [];
  let lastStatus: number | undefined;
  let parserFailure = false;
  let httpError = false;
  let structurePresent = false;
  let coverageTruncated = false;
  let sawSearch = false;
  const cap = input.detailCap ?? DOMRIA_NEWEST_DETAIL_CAP;
  const discoveredAt = input.discoveredAt ?? new Date();

  for (const category of input.categories) {
    const searchUrl = buildDomriaNewestSearchUrl(category);
    let search: DomriaFetchResponse;
    try {
      search = await input.get(searchUrl);
    } catch (error) {
      httpError = true;
      coverageTruncated = true;
      notes.push(
        `${category} search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    lastStatus = search.status;
    notes.push(`${searchUrl} -> ${search.status}`);
    if (search.status !== 200) {
      httpError = true;
      coverageTruncated = true;
      continue;
    }
    const parsedIds = parseDomriaSearchIds(search.bodyText);
    if (!parsedIds.ok) {
      parserFailure = true;
      coverageTruncated = true;
      notes.push(`${category} parser_failure: searchEngine items missing`);
      continue;
    }
    sawSearch = true;
    structurePresent = true;
    if (parsedIds.empty) {
      notes.push(`${category} searchEngine items empty`);
      continue;
    }
    const plan = planDomriaDetailFetches(parsedIds.ids, input.knownIds, cap);
    notes.push(
      `${category} ids=${parsedIds.ids.length} fetch=${plan.toFetch.length} known=${plan.skippedKnown.length} deferred=${plan.deferred.length}`,
    );
    if (plan.deferred.length > 0) {
      coverageTruncated = true;
    }
    for (const id of plan.toFetch) {
      const loaded = await loadDomriaCandidate(
        id,
        category,
        input.get,
        input.extractState,
        discoveredAt,
        notes,
      );
      if (!loaded.ok) {
        coverageTruncated = true;
        if (loaded.httpError) {
          httpError = true;
        }
        if (loaded.parserFailure) {
          parserFailure = true;
        }
        notes.push(`${category} detail ${id} failed; continuing later ids`);
        continue;
      }
      listings.push(loaded.listing);
      persistIds.push(id);
    }
  }

  return {
    listings,
    ...(lastStatus !== undefined ? { lastStatus } : {}),
    parserFailure,
    httpError,
    structurePresent: structurePresent && sawSearch,
    notes,
    ...(sawSearch ? { persistIds } : {}),
    coverageTruncated,
    boundaryReached: sawSearch && !coverageTruncated && !parserFailure && !httpError,
  };
}

async function loadDomriaCandidate(
  id: string,
  category: DomriaNewestCategory,
  get: (url: string) => Promise<DomriaFetchResponse>,
  extractState: (html: string) => unknown,
  discoveredAt: Date,
  notes: string[],
): Promise<
  | { ok: true; listing: Listing }
  | { ok: false; httpError?: boolean; parserFailure?: boolean }
> {
  let data: DomriaFetchResponse;
  try {
    data = await get(buildDomriaRealtyDataUrl(id));
  } catch (error) {
    notes.push(
      `realty/data ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, httpError: true };
  }
  notes.push(`realty/data ${id} -> ${data.status}`);
  if (data.status !== 200) {
    return { ok: false, httpError: true };
  }
  let info: unknown;
  try {
    info = JSON.parse(data.bodyText) as unknown;
  } catch {
    notes.push(`realty/data ${id} parser_failure`);
    return { ok: false, parserFailure: true };
  }
  const record = asRecord(info);
  const beautiful = record?.beautiful_url ?? record?.beautifulUrl;
  if (!record || typeof beautiful !== "string" || beautiful === "") {
    notes.push(`realty/data ${id} parser_failure: beautiful_url missing`);
    return { ok: false, parserFailure: true };
  }
  let page: DomriaFetchResponse;
  try {
    page = await get(buildDomriaListingPageUrl(beautiful));
  } catch (error) {
    notes.push(
      `listing ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, httpError: true };
  }
  notes.push(`listing ${id} -> ${page.status}`);
  if (page.status !== 200) {
    return { ok: false, httpError: true };
  }
  let roleState: Record<string, unknown> | undefined;
  try {
    roleState = findDomriaListingState(extractState(page.bodyText), id);
  } catch (error) {
    notes.push(
      `listing ${id} state parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, parserFailure: true };
  }
  const roleValues = asRecord(roleState?.characteristics_values);
  const merged = {
    ...record,
    ...(roleState ?? {}),
    realty_id: record.realty_id ?? id,
    beautiful_url: beautiful,
    characteristics_values: {
      ...(asRecord(record.characteristics_values) ?? {}),
      ...(roleValues ?? {}),
    },
    user_id: record.user_id ?? roleState?.user_id,
    publishing_date: record.publishing_date ?? roleState?.publishing_date,
    agency_id: record.agency_id ?? roleState?.agency_id,
  };
  const listing = parseDomriaInfo(merged, discoveredAt);
  if (!listing) {
    notes.push(`listing ${id} parser_failure: card rejected`);
    return { ok: false, parserFailure: true };
  }
  return { ok: true, listing: applyCategoryPropertyType(listing, category, id, notes) };
}

/**
 * Acquisition category is trusted only when the parsed type is unknown.
 * Explicit apartment/house contradictions are left as-is with a diagnostic note.
 */
export function applyCategoryPropertyType(
  listing: Listing,
  category: DomriaNewestCategory,
  id: string,
  notes: string[],
): Listing {
  if (listing.propertyType === "unknown") {
    return { ...listing, propertyType: category };
  }
  if (
    (listing.propertyType === "apartment" || listing.propertyType === "house") &&
    listing.propertyType !== category
  ) {
    notes.push(
      `listing ${id} propertyType=${listing.propertyType} contradicts search category=${category}; preserving parsed type`,
    );
  }
  return listing;
}
