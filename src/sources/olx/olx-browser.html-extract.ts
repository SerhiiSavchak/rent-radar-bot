/**
 * Extract structured OLX offer payloads from public catalog HTML.
 * Prefer embedded hydration state over fragile card-marker DOM scraping.
 */

import type { Listing } from "../../domain/listing.ts";
import { parseOlxOffer, parseOlxOffersPayload } from "./olx.parser.ts";

export type OlxHtmlExtractRejection = {
  reason: string;
  detail?: string;
};

export type OlxHtmlExtractDiagnostics = {
  hasPrerenderedState: boolean;
  hasNextData: boolean;
  hasOffersApiShapeInHtml: boolean;
  markerHits: string[];
  rawCandidateCount: number;
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
  const raw = extractPrerenderedStateRaw(html);
  if (!raw) {
    return undefined;
  }
  let parsed = tryJsonParse(raw);
  if (parsed === undefined) {
    // Some pages leave the string unescaped in the assignment capture.
    parsed = tryJsonParse(`"${raw.replaceAll('"', '\\"')}"`);
  }
  // Double-encoded: first parse yields a string of JSON.
  if (typeof parsed === "string") {
    const second = tryJsonParse(parsed);
    return second;
  }
  return parsed;
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

/**
 * Normalize common embedded catalog shapes into api/v1/offers-compatible records.
 * Does not invent seller ownership or publication time.
 */
export function normalizeEmbeddedOlxAd(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") {
    return raw;
  }
  const ad = raw as Record<string, unknown>;
  const location = ad.location;
  let normalizedLocation: Record<string, unknown> | undefined;
  if (location && typeof location === "object" && !Array.isArray(location)) {
    const loc = location as Record<string, unknown>;
    if (loc.city && typeof loc.city === "object") {
      normalizedLocation = loc;
    } else {
      const cityName =
        typeof loc.cityName === "string"
          ? loc.cityName
          : typeof loc.city === "string"
            ? loc.city
            : undefined;
      const districtName =
        typeof loc.districtName === "string"
          ? loc.districtName
          : typeof loc.district === "string"
            ? loc.district
            : undefined;
      const regionName =
        typeof loc.regionName === "string"
          ? loc.regionName
          : typeof loc.region === "string"
            ? loc.region
            : undefined;
      normalizedLocation = {
        ...(cityName ? { city: { name: cityName } } : {}),
        ...(districtName ? { district: { name: districtName } } : {}),
        ...(regionName ? { region: { name: regionName } } : {}),
        ...(typeof loc.lat === "number" ? { lat: loc.lat } : {}),
        ...(typeof loc.lon === "number" ? { lon: loc.lon } : {}),
      };
    }
  }

  let params = Array.isArray(ad.params) ? ad.params : undefined;
  if (!params) {
    const price = ad.price;
    if (price && typeof price === "object" && !Array.isArray(price)) {
      const p = price as Record<string, unknown>;
      const amount =
        typeof p.value === "number"
          ? p.value
          : typeof p.amount === "number"
            ? p.amount
            : undefined;
      const currency =
        typeof p.currency === "string"
          ? p.currency
          : typeof p.currencyCode === "string"
            ? p.currencyCode
            : "UAH";
      if (amount !== undefined) {
        params = [{ key: "price", value: { value: amount, currency } }];
      }
    }
  }

  const created =
    (typeof ad.created_time === "string" && ad.created_time) ||
    (typeof ad.createdTime === "string" && ad.createdTime) ||
    undefined;
  const refreshed =
    (typeof ad.last_refresh_time === "string" && ad.last_refresh_time) ||
    (typeof ad.lastRefreshTime === "string" && ad.lastRefreshTime) ||
    undefined;
  const business =
    typeof ad.business === "boolean"
      ? ad.business
      : typeof ad.isBusiness === "boolean"
        ? ad.isBusiness
        : undefined;

  return {
    ...ad,
    ...(normalizedLocation ? { location: normalizedLocation } : {}),
    ...(params ? { params } : {}),
    ...(created ? { created_time: created } : {}),
    ...(refreshed ? { last_refresh_time: refreshed } : {}),
    ...(business !== undefined ? { business } : {}),
  };
}

function listingsFromCandidates(
  candidates: unknown[],
  discoveredAt: Date,
): { listings: Listing[]; rawOfferCount: number; rejectedMalformed: number } {
  const listings: Listing[] = [];
  let rejectedMalformed = 0;
  for (const candidate of candidates) {
    const normalized = normalizeEmbeddedOlxAd(candidate);
    const listing = parseOlxOffer(normalized, discoveredAt);
    if (listing) {
      listings.push(listing);
    } else {
      rejectedMalformed += 1;
    }
  }
  return { listings, rawOfferCount: candidates.length, rejectedMalformed };
}

/**
 * Prefer structured hydration payloads. Never invent Listings from card markers alone.
 */
export function extractListingsFromOlxCatalogHtml(
  html: string,
  discoveredAt = new Date(),
): OlxHtmlStructuredExtract {
  const rejections: OlxHtmlExtractRejection[] = [];
  const markerHits: string[] = [];
  if (/data-cy=["']l-card["']/i.test(html)) {
    markerHits.push("data_cy_l_card");
  }
  if (/ID[A-Za-z0-9]+\.html/i.test(html)) {
    markerHits.push("offer_id_html_link");
  }

  const prerendered = parsePrerenderedState(html);
  const hasPrerenderedState = prerendered !== undefined;
  if (hasPrerenderedState) {
    markerHits.push("prerendered_state");
    const candidates = collectOfferLikeObjects(prerendered);
    const parsed = listingsFromCandidates(candidates, discoveredAt);
    if (parsed.listings.length > 0) {
      return {
        listings: parsed.listings,
        rawOfferCount: parsed.rawOfferCount,
        source: "prerendered_state",
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
          hasPrerenderedState: true,
          hasNextData: false,
          hasOffersApiShapeInHtml: false,
          markerHits,
          rawCandidateCount: parsed.rawOfferCount,
        },
      };
    }
    if (candidates.length > 0) {
      rejections.push({
        reason: "prerendered_offers_failed_schema_validation",
        detail: `raw=${candidates.length}`,
      });
    } else {
      rejections.push({
        reason: "prerendered_state_present_without_offer_objects",
        detail: "state parsed but no offer-like nodes found",
      });
    }
  }

  const nextData = extractNextDataJson(html);
  const hasNextData = nextData !== undefined;
  if (hasNextData) {
    markerHits.push("next_data");
    const candidates = collectOfferLikeObjects(nextData);
    const parsed = listingsFromCandidates(candidates, discoveredAt);
    if (parsed.listings.length > 0) {
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
          hasPrerenderedState,
          hasNextData: true,
          hasOffersApiShapeInHtml: false,
          markerHits,
          rawCandidateCount: parsed.rawOfferCount,
        },
      };
    }
  }

  // Direct api/v1/offers-shaped JSON embedded in HTML/scripts.
  const apiShapeMatch = html.match(/\{\s*"data"\s*:\s*\[[\s\S]{0,500000}?\]\s*(?:,\s*"metadata"[\s\S]{0,20000}?)?\}/);
  let hasOffersApiShapeInHtml = false;
  if (apiShapeMatch?.[0]) {
    const payload = tryJsonParse(apiShapeMatch[0]);
    if (payload) {
      hasOffersApiShapeInHtml = true;
      markerHits.push("embedded_offers_api_shape");
      const listings = parseOlxOffersPayload(payload, discoveredAt);
      const data = (payload as { data?: unknown }).data;
      const rawOfferCount = Array.isArray(data) ? data.length : 0;
      if (listings.length > 0) {
        return {
          listings,
          rawOfferCount,
          source: "embedded_offers_api_shape",
          rejections: [],
          diagnostics: {
            hasPrerenderedState,
            hasNextData,
            hasOffersApiShapeInHtml: true,
            markerHits,
            rawCandidateCount: rawOfferCount,
          },
        };
      }
      if (rawOfferCount > 0) {
        rejections.push({
          reason: "embedded_offers_failed_schema_validation",
          detail: `raw=${rawOfferCount}`,
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
  if (!hasPrerenderedState && !hasNextData && !hasOffersApiShapeInHtml) {
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
      hasPrerenderedState,
      hasNextData,
      hasOffersApiShapeInHtml,
      markerHits,
      rawCandidateCount: 0,
    },
  };
}
