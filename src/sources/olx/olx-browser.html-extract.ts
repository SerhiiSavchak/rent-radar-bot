/**
 * Extract structured OLX offer payloads from public catalog HTML.
 * Prefer embedded hydration state over fragile card-marker DOM scraping.
 */

import type { Listing } from "../../domain/listing.ts";
import { parseOlxOffer } from "./olx.parser.ts";

export type OlxHtmlExtractRejection = {
  reason: string;
  detail?: string;
};

export type OlxHtmlExtractDiagnostics = {
  hasPrerenderedState: boolean;
  prerenderedStateComplete?: boolean;
  prerenderedStateTruncated?: boolean;
  prerenderedAdsPathFound?: boolean;
  hasNextData: boolean;
  hasOffersApiShapeInHtml: boolean;
  markerHits: string[];
  rawCandidateCount: number;
  rawObjectCount?: number;
  uniqueIdCount?: number;
  normalizedListingCount?: number;
  ownerEligibleCount?: number;
  freshnessEligibleCount?: number;
  htmlSource?: "main_document" | "rendered_dom";
  rejectedWrongCategory?: number;
  rejectedMissingLocation?: number;
};

export type OlxHtmlStructuredExtract = {
  listings: Listing[];
  rawOfferCount: number;
  source: "prerendered_state" | "next_data" | "embedded_offers_api_shape" | "none";
  rejections: OlxHtmlExtractRejection[];
  diagnostics: OlxHtmlExtractDiagnostics;
};

function tryJsonParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Extract assignment RHS for `window.__PRERENDERED_STATE__ = …` (object or JSON string).
 */
export function extractPrerenderedStateRaw(html: string): string | undefined {
  const marker = "__PRERENDERED_STATE__";
  const index = html.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const eq = html.indexOf("=", index + marker.length);
  if (eq < 0) {
    return undefined;
  }
  let i = eq + 1;
  while (i < html.length && /\s/.test(html[i]!)) {
    i += 1;
  }
  if (i >= html.length) {
    return undefined;
  }
  const startChar = html[i]!;
  if (startChar === '"' || startChar === "'") {
    // Capture a JSON/JS string literal and decode escapes via JSON.parse.
    const quote = startChar;
    const start = i;
    i += 1;
    while (i < html.length) {
      const ch = html[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        const literal = html.slice(start, i + 1);
        // Prefer JSON string decoding; fall back to stripping quotes.
        if (quote === '"') {
          const decoded = tryJsonParse(literal);
          if (typeof decoded === "string") {
            return decoded;
          }
        }
        return literal.slice(1, -1);
      }
      i += 1;
    }
    return undefined;
  }
  if (startChar === "{" || startChar === "[") {
    const open = startChar;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    const start = i;
    for (; i < html.length; i += 1) {
      const ch = html[i]!;
      if (ch === '"') {
        // Skip string contents so braces inside strings do not affect depth.
        i += 1;
        while (i < html.length) {
          if (html[i] === "\\") {
            i += 2;
            continue;
          }
          if (html[i] === '"') {
            break;
          }
          i += 1;
        }
        continue;
      }
      if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          return html.slice(start, i + 1);
        }
      }
    }
  }
  return undefined;
}

export function parsePrerenderedState(html: string): unknown | undefined {
  return inspectPrerenderedState(html).decoded;
}

export type PrerenderedStateInspection = {
  present: boolean;
  complete: boolean;
  truncated: boolean;
  decoded?: unknown;
};

/**
 * Decode `window.__PRERENDERED_STATE__ = "…"` as data (JSON.parse only; never eval).
 * An unclosed quoted assignment is truncated — not a successful full-state parse.
 */
export function inspectPrerenderedState(html: string): PrerenderedStateInspection {
  const raw = extractPrerenderedStateRaw(html);
  const present = html.includes("__PRERENDERED_STATE__");
  if (!present) {
    return { present: false, complete: false, truncated: false };
  }
  if (!raw) {
    return { present: true, complete: false, truncated: true };
  }
  let parsed = tryJsonParse(raw);
  if (parsed === undefined) {
    parsed = tryJsonParse(`"${raw.replaceAll('"', '\\"')}"`);
  }
  if (typeof parsed === "string") {
    const second = tryJsonParse(parsed);
    if (second === undefined) {
      return { present: true, complete: true, truncated: false };
    }
    return { present: true, complete: true, truncated: false, decoded: second };
  }
  if (parsed === undefined) {
    return { present: true, complete: true, truncated: false };
  }
  return { present: true, complete: true, truncated: false, decoded: parsed };
}

/** Evidenced Oracle path: decodedState.listing.listing.ads */
export function extractListingAdsFromPrerenderedState(state: unknown): unknown[] {
  if (!state || typeof state !== "object") {
    return [];
  }
  const listing = (state as { listing?: unknown }).listing;
  if (!listing || typeof listing !== "object") {
    return [];
  }
  const inner = (listing as { listing?: unknown }).listing;
  if (!inner || typeof inner !== "object") {
    return [];
  }
  const ads = (inner as { ads?: unknown }).ads;
  return Array.isArray(ads) ? ads : [];
}

export function extractNextDataJson(html: string): unknown | undefined {
  const match = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return tryJsonParse(match[1]);
}

function isOfferLike(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const hasId =
    (typeof id === "number" && Number.isFinite(id)) ||
    (typeof id === "string" && /^\d{6,}$/.test(id));
  const hasTitle = typeof record.title === "string" && record.title.trim().length > 0;
  const hasUrl = typeof record.url === "string" && /olx\.|\/d\//i.test(record.url);
  // Catalog cards sometimes omit url but include id+title+created_time.
  const hasCreated =
    typeof record.created_time === "string" || typeof record.createdTime === "string";
  return hasId && hasTitle && (hasUrl || hasCreated || Array.isArray(record.params));
}

/**
 * Walk a hydration tree and collect offer-like objects (bounded).
 */
export function collectOfferLikeObjects(root: unknown, max = 200): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0 && out.length < max) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") {
      continue;
    }
    if (seen.has(cur)) {
      continue;
    }
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) {
        if (isOfferLike(item)) {
          out.push(item);
          if (out.length >= max) {
            break;
          }
        } else if (item && typeof item === "object") {
          stack.push(item);
        }
      }
      continue;
    }
    for (const value of Object.values(cur as Record<string, unknown>)) {
      if (isOfferLike(value)) {
        out.push(value);
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readRegularPrice(ad: Record<string, unknown>): { value: number; currency: string } | undefined {
  const price = asRecord(ad.price);
  if (!price) {
    return undefined;
  }
  const regular = asRecord(price.regularPrice) ?? asRecord(price.regular_price);
  const amountRaw = regular?.value ?? price.value ?? price.amount;
  const amount = typeof amountRaw === "number" ? amountRaw : Number(amountRaw);
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const currency =
    (typeof regular?.currencyCode === "string" && regular.currencyCode) ||
    (typeof regular?.currency === "string" && regular.currency) ||
    (typeof price.currencyCode === "string" && price.currencyCode) ||
    (typeof price.currency === "string" && price.currency) ||
    "UAH";
  return { value: amount, currency };
}

function categoryIdOf(raw: unknown): number | undefined {
  const id = asRecord(raw)?.category && asRecord(asRecord(raw)?.category)?.id;
  const n = typeof id === "number" ? id : typeof id === "string" ? Number(id) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Explicit adapter for the Oracle catalog camelCase schema
 * (`createdTime`, `isBusiness`, `price.regularPrice`, `location.cityName`, …)
 * plus the older snake_case api/v1/offers shape used by existing fixtures.
 */
export function adaptOracleCatalogAd(raw: unknown): Record<string, unknown> | undefined {
  const ad = asRecord(raw);
  if (!ad) {
    return undefined;
  }
  const id = ad.id;
  const title = typeof ad.title === "string" ? ad.title : undefined;
  if (id === undefined || !title) {
    return undefined;
  }

  const created =
    (typeof ad.createdTime === "string" && ad.createdTime) ||
    (typeof ad.created_time === "string" && ad.created_time) ||
    undefined;
  const refreshed =
    (typeof ad.lastRefreshTime === "string" && ad.lastRefreshTime) ||
    (typeof ad.last_refresh_time === "string" && ad.last_refresh_time) ||
    undefined;
  const pushup =
    (typeof ad.pushupTime === "string" && ad.pushupTime) ||
    (typeof ad.pushup_time === "string" && ad.pushup_time) ||
    undefined;
  const business =
    typeof ad.isBusiness === "boolean"
      ? ad.isBusiness
      : typeof ad.business === "boolean"
        ? ad.business
        : undefined;

  const locIn = asRecord(ad.location);
  let location: Record<string, unknown> | undefined;
  if (locIn) {
    if (asRecord(locIn.city)) {
      location = locIn;
    } else {
      const cityName =
        typeof locIn.cityName === "string"
          ? locIn.cityName
          : typeof locIn.city === "string"
            ? locIn.city
            : undefined;
      const districtName =
        typeof locIn.districtName === "string"
          ? locIn.districtName
          : typeof locIn.district === "string"
            ? locIn.district
            : undefined;
      const regionName =
        typeof locIn.regionName === "string"
          ? locIn.regionName
          : typeof locIn.region === "string"
            ? locIn.region
            : undefined;
      const cityId = locIn.cityId ?? locIn.city_id;
      location = {
        ...(cityName ? { city: { name: cityName, ...(cityId !== undefined ? { id: cityId } : {}) } } : {}),
        ...(districtName ? { district: { name: districtName } } : {}),
        ...(regionName ? { region: { name: regionName } } : {}),
      };
    }
  }

  const paramsIn = Array.isArray(ad.params) ? [...ad.params] : [];
  const hasPriceParam = paramsIn.some(
    (item) => asRecord(item)?.key === "price",
  );
  const regular = readRegularPrice(ad);
  if (!hasPriceParam && regular) {
    paramsIn.push({ key: "price", value: { value: regular.value, currency: regular.currency } });
  }

  const mapIn = asRecord(ad.map);
  const userIn = asRecord(ad.user);
  const company =
    typeof userIn?.company_name === "string" && userIn.company_name.trim()
      ? userIn.company_name.trim()
      : undefined;

  return {
    id,
    title,
    ...(typeof ad.description === "string" ? { description: ad.description } : {}),
    ...(typeof ad.url === "string" ? { url: ad.url } : {}),
    ...(created ? { created_time: created } : {}),
    ...(refreshed ? { last_refresh_time: refreshed } : {}),
    ...(pushup ? { pushup_time: pushup } : {}),
    ...(business !== undefined ? { business } : {}),
    ...(paramsIn.length > 0 ? { params: paramsIn } : {}),
    ...(location ? { location } : {}),
    ...(mapIn ? { map: mapIn } : {}),
    ...(userIn
      ? {
          user: {
            ...userIn,
            ...(company ? { company_name: company } : { company_name: userIn.company_name ?? null }),
            sellerType: userIn.sellerType ?? null,
          },
        }
      : {}),
    ...(asRecord(ad.category) ? { category: asRecord(ad.category) } : {}),
    ...(Array.isArray(ad.photos) ? { photos: ad.photos } : {}),
  };
}

/**
 * Normalize common embedded catalog shapes into api/v1/offers-compatible records.
 * Does not invent seller ownership or publication time.
 */
export function normalizeEmbeddedOlxAd(raw: unknown): unknown {
  return adaptOracleCatalogAd(raw) ?? raw;
}

function hasCityLabel(normalized: Record<string, unknown>): boolean {
  const location = asRecord(normalized.location);
  const city = asRecord(location?.city);
  return typeof city?.name === "string" && city.name.trim().length > 0;
}

function listingsFromCandidates(
  candidates: unknown[],
  discoveredAt: Date,
  options?: { expectedCategoryId?: number },
): {
  listings: Listing[];
  rawOfferCount: number;
  uniqueIdCount: number;
  rejectedMalformed: number;
  rejectedWrongCategory: number;
  rejectedMissingLocation: number;
} {
  const listings: Listing[] = [];
  const seenIds = new Set<string>();
  let rejectedMalformed = 0;
  let rejectedWrongCategory = 0;
  let rejectedMissingLocation = 0;
  for (const candidate of candidates) {
    if (
      options?.expectedCategoryId !== undefined &&
      categoryIdOf(candidate) !== undefined &&
      categoryIdOf(candidate) !== options.expectedCategoryId
    ) {
      rejectedWrongCategory += 1;
      continue;
    }
    const normalized = adaptOracleCatalogAd(candidate);
    if (!normalized) {
      rejectedMalformed += 1;
      continue;
    }
    if (!hasCityLabel(normalized)) {
      rejectedMissingLocation += 1;
      continue;
    }
    const listing = parseOlxOffer(normalized, discoveredAt);
    if (!listing) {
      rejectedMalformed += 1;
      continue;
    }
    const key = `${listing.source}:${listing.sourceId}`;
    if (seenIds.has(key)) {
      continue;
    }
    seenIds.add(key);
    listings.push(listing);
  }
  return {
    listings,
    rawOfferCount: candidates.length,
    uniqueIdCount: seenIds.size,
    rejectedMalformed,
    rejectedWrongCategory,
    rejectedMissingLocation,
  };
}

function htmlSourceField(
  source: "main_document" | "rendered_dom" | undefined,
): { htmlSource?: "main_document" | "rendered_dom" } {
  return source ? { htmlSource: source } : {};
}

function markerHitsFromHtml(html: string): string[] {
  const markerHits: string[] = [];
  if (/data-cy=["']l-card["']/i.test(html)) {
    markerHits.push("data_cy_l_card");
  }
  if (/ID[A-Za-z0-9]+\.html/i.test(html)) {
    markerHits.push("offer_id_html_link");
  }
  return markerHits;
}

function eligibilityCounts(listings: Listing[]): {
  ownerEligibleCount: number;
  freshnessEligibleCount: number;
} {
  return {
    ownerEligibleCount: listings.filter((item) => item.sellerType === "owner").length,
    freshnessEligibleCount: listings.filter((item) => item.publishedAt instanceof Date).length,
  };
}

function extractFromPrerenderedHtml(
  html: string,
  discoveredAt: Date,
  options?: { expectedCategoryId?: number; htmlSource?: "main_document" | "rendered_dom" },
): OlxHtmlStructuredExtract | undefined {
  const inspection = inspectPrerenderedState(html);
  const markerHits = markerHitsFromHtml(html);
  if (inspection.decoded !== undefined) {
    markerHits.push("prerendered_state");
  }
  const ads = extractListingAdsFromPrerenderedState(inspection.decoded);
  const adsPathFound = ads.length > 0 || (inspection.decoded !== undefined && Array.isArray(
    asRecord(asRecord(asRecord(inspection.decoded)?.listing)?.listing)?.ads,
  ));
  if (inspection.decoded !== undefined && ads.length > 0) {
    const parsed = listingsFromCandidates(ads, discoveredAt, options);
    const eligibility = eligibilityCounts(parsed.listings);
    const rejections: OlxHtmlExtractRejection[] = [];
    if (parsed.rejectedMalformed > 0) {
      rejections.push({
        reason: "embedded_offers_partial_schema_failure",
        detail: `rejected=${parsed.rejectedMalformed}`,
      });
    }
    if (parsed.rejectedWrongCategory > 0) {
      rejections.push({
        reason: "rejected_wrong_category",
        detail: `rejected=${parsed.rejectedWrongCategory}`,
      });
    }
    if (parsed.rejectedMissingLocation > 0) {
      rejections.push({
        reason: "rejected_missing_location",
        detail: `rejected=${parsed.rejectedMissingLocation}`,
      });
    }
    if (parsed.listings.length > 0) {
      return {
        listings: parsed.listings,
        rawOfferCount: parsed.rawOfferCount,
        source: "prerendered_state",
        rejections,
        diagnostics: {
          hasPrerenderedState: true,
          prerenderedStateComplete: inspection.complete,
          prerenderedStateTruncated: inspection.truncated,
          prerenderedAdsPathFound: true,
          hasNextData: false,
          hasOffersApiShapeInHtml: false,
          markerHits,
          rawCandidateCount: parsed.rawOfferCount,
          rawObjectCount: parsed.rawOfferCount,
          uniqueIdCount: parsed.uniqueIdCount,
          normalizedListingCount: parsed.listings.length,
          ...eligibility,
          ...htmlSourceField(options?.htmlSource),
          rejectedWrongCategory: parsed.rejectedWrongCategory,
          rejectedMissingLocation: parsed.rejectedMissingLocation,
        },
      };
    }
    return {
      listings: [],
      rawOfferCount: parsed.rawOfferCount,
      source: "none",
      rejections:
        rejections.length > 0
          ? rejections
          : [
              {
                reason: "prerendered_offers_failed_schema_validation",
                detail: `raw=${parsed.rawOfferCount}`,
              },
            ],
      diagnostics: {
        hasPrerenderedState: true,
        prerenderedStateComplete: inspection.complete,
        prerenderedStateTruncated: inspection.truncated,
        prerenderedAdsPathFound: true,
        hasNextData: false,
        hasOffersApiShapeInHtml: false,
        markerHits,
        rawCandidateCount: parsed.rawOfferCount,
        rawObjectCount: parsed.rawOfferCount,
        uniqueIdCount: parsed.uniqueIdCount,
        normalizedListingCount: 0,
        ...htmlSourceField(options?.htmlSource),
        rejectedWrongCategory: parsed.rejectedWrongCategory,
        rejectedMissingLocation: parsed.rejectedMissingLocation,
      },
    };
  }

  if (inspection.present && inspection.truncated) {
    return {
      listings: [],
      rawOfferCount: 0,
      source: "none",
      rejections: [
        {
          reason: "prerendered_state_truncated",
          detail: "quoted __PRERENDERED_STATE__ assignment was not closed; not a full-state parse",
        },
      ],
      diagnostics: {
        hasPrerenderedState: true,
        prerenderedStateComplete: false,
        prerenderedStateTruncated: true,
        prerenderedAdsPathFound: adsPathFound,
        hasNextData: false,
        hasOffersApiShapeInHtml: false,
        markerHits,
        rawCandidateCount: 0,
        ...htmlSourceField(options?.htmlSource),
      },
    };
  }

  if (inspection.present && inspection.decoded !== undefined && ads.length === 0) {
    return {
      listings: [],
      rawOfferCount: 0,
      source: "none",
      rejections: [
        {
          reason: "prerendered_state_present_without_offer_objects",
          detail: "state parsed but listing.listing.ads was missing or empty",
        },
      ],
      diagnostics: {
        hasPrerenderedState: true,
        prerenderedStateComplete: inspection.complete,
        prerenderedStateTruncated: inspection.truncated,
        prerenderedAdsPathFound: false,
        hasNextData: false,
        hasOffersApiShapeInHtml: false,
        markerHits,
        rawCandidateCount: 0,
        ...htmlSourceField(options?.htmlSource),
      },
    };
  }

  if (inspection.present && inspection.decoded === undefined && inspection.complete) {
    return {
      listings: [],
      rawOfferCount: 0,
      source: "none",
      rejections: [
        {
          reason: "prerendered_state_malformed",
          detail: "quoted state assignment could not be JSON.parsed",
        },
      ],
      diagnostics: {
        hasPrerenderedState: true,
        prerenderedStateComplete: inspection.complete,
        prerenderedStateTruncated: false,
        prerenderedAdsPathFound: false,
        hasNextData: false,
        hasOffersApiShapeInHtml: false,
        markerHits,
        rawCandidateCount: 0,
        ...htmlSourceField(options?.htmlSource),
      },
    };
  }

  return undefined;
}

/**
 * Prefer structured hydration payloads. Never invent Listings from card markers alone.
 */
export function extractListingsFromOlxCatalogHtml(
  html: string,
  discoveredAt = new Date(),
  options?: { expectedCategoryId?: number; htmlSource?: "main_document" | "rendered_dom" },
): OlxHtmlStructuredExtract {
  const prerendered = extractFromPrerenderedHtml(html, discoveredAt, options);
  if (prerendered && (prerendered.listings.length > 0 || prerendered.rejections.length > 0)) {
    return prerendered;
  }

  const rejections: OlxHtmlExtractRejection[] = [...(prerendered?.rejections ?? [])];
  const markerHits = markerHitsFromHtml(html);
  const inspection = inspectPrerenderedState(html);

  const nextData = extractNextDataJson(html);
  const hasNextData = nextData !== undefined;
  if (hasNextData) {
    markerHits.push("next_data");
    const candidates = collectOfferLikeObjects(nextData);
    const parsed = listingsFromCandidates(candidates, discoveredAt, options);
    if (parsed.listings.length > 0) {
      const eligibility = eligibilityCounts(parsed.listings);
      return {
        listings: parsed.listings,
        rawOfferCount: parsed.rawOfferCount,
        source: "next_data",
        rejections:
          parsed.rejectedMalformed > 0
            ? [
                {
                  reason: "embedded_offers_partial_schema_failure",
                  detail: `rejected=${parsed.rejectedMalformed}`,
                },
              ]
            : [],
        diagnostics: {
          hasPrerenderedState: inspection.present,
          prerenderedStateComplete: inspection.complete,
          prerenderedStateTruncated: inspection.truncated,
          hasNextData: true,
          hasOffersApiShapeInHtml: false,
          markerHits,
          rawCandidateCount: parsed.rawOfferCount,
          rawObjectCount: parsed.rawOfferCount,
          uniqueIdCount: parsed.uniqueIdCount,
          normalizedListingCount: parsed.listings.length,
          ...eligibility,
          ...htmlSourceField(options?.htmlSource),
        },
      };
    }
  }

  const apiShapeMatch = html.match(/\{\s*"data"\s*:\s*\[[\s\S]{0,500000}?\]\s*(?:,\s*"metadata"[\s\S]{0,20000}?)?\}/);
  let hasOffersApiShapeInHtml = false;
  if (apiShapeMatch?.[0]) {
    const payload = tryJsonParse(apiShapeMatch[0]);
    if (payload) {
      hasOffersApiShapeInHtml = true;
      markerHits.push("embedded_offers_api_shape");
      const data = (payload as { data?: unknown }).data;
      const raw = Array.isArray(data) ? data : [];
      const parsed = listingsFromCandidates(raw, discoveredAt, options);
      if (parsed.listings.length > 0) {
        const eligibility = eligibilityCounts(parsed.listings);
        return {
          listings: parsed.listings,
          rawOfferCount: parsed.rawOfferCount,
          source: "embedded_offers_api_shape",
          rejections: [],
          diagnostics: {
            hasPrerenderedState: inspection.present,
            hasNextData,
            hasOffersApiShapeInHtml: true,
            markerHits,
            rawCandidateCount: parsed.rawOfferCount,
            rawObjectCount: parsed.rawOfferCount,
            uniqueIdCount: parsed.uniqueIdCount,
            normalizedListingCount: parsed.listings.length,
            ...eligibility,
            ...htmlSourceField(options?.htmlSource),
          },
        };
      }
      if (raw.length > 0) {
        rejections.push({
          reason: "embedded_offers_failed_schema_validation",
          detail: `raw=${raw.length}`,
        });
      }
    } else {
      rejections.push({
        reason: "embedded_offers_json_malformed",
        detail: "found data:[] shape but JSON.parse failed",
      });
    }
  }

  if (markerHits.includes("data_cy_l_card") || markerHits.includes("offer_id_html_link")) {
    rejections.push({
      reason: "dom_fallback_insufficient",
      detail: "card markers alone do not yield validated Listing objects",
    });
  }
  if (!inspection.present && !hasNextData && !hasOffersApiShapeInHtml) {
    rejections.push({
      reason: "no_structured_html_payload",
      detail: "no __PRERENDERED_STATE__, __NEXT_DATA__, or offers API JSON in HTML",
    });
  }

  return {
    listings: [],
    rawOfferCount: 0,
    source: "none",
    rejections,
    diagnostics: {
      hasPrerenderedState: inspection.present,
      prerenderedStateComplete: inspection.complete,
      prerenderedStateTruncated: inspection.truncated,
      prerenderedAdsPathFound: false,
      hasNextData,
      hasOffersApiShapeInHtml,
      markerHits,
      rawCandidateCount: 0,
      ...htmlSourceField(options?.htmlSource),
    },
  };
}

/**
 * Parser input priority: original navigation HTML, then rendered DOM.
 * Rendered Oracle pages drop `__PRERENDERED_STATE__`; main-document retains it.
 */
export function extractListingsFromOlxBrowserDocuments(
  input: { mainDocumentHtml?: string; renderedHtml?: string },
  discoveredAt = new Date(),
  options?: { expectedCategoryId?: number },
): OlxHtmlStructuredExtract {
  if (input.mainDocumentHtml) {
    const fromMain = extractListingsFromOlxCatalogHtml(input.mainDocumentHtml, discoveredAt, {
      ...options,
      htmlSource: "main_document",
    });
    if (fromMain.listings.length > 0 || fromMain.source !== "none") {
      return fromMain;
    }
    if (fromMain.rejections.some((item) => item.reason === "prerendered_state_truncated")) {
      const fromRendered = input.renderedHtml
        ? extractListingsFromOlxCatalogHtml(input.renderedHtml, discoveredAt, {
            ...options,
            htmlSource: "rendered_dom",
          })
        : undefined;
      if (fromRendered && fromRendered.listings.length > 0) {
        return fromRendered;
      }
      return fromMain;
    }
  }
  if (input.renderedHtml) {
    return extractListingsFromOlxCatalogHtml(input.renderedHtml, discoveredAt, {
      ...options,
      htmlSource: "rendered_dom",
    });
  }
  return extractListingsFromOlxCatalogHtml("", discoveredAt, options);
}
