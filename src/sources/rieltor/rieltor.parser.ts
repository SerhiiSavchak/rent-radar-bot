import type { Listing } from "../../domain/listing.ts";
import type { FetchResultKind } from "../../domain/source.ts";
import { classifyOwner } from "../../filters/owner-filter.ts";
import { collectTextEvidence } from "../../utils/text-evidence.ts";
import {
  RIELTOR_CITY_PREFIX,
  type RieltorCategory,
  type RieltorJsonLdItem,
} from "./rieltor.types.ts";

export type RieltorPageInspection = {
  resultKind: FetchResultKind;
  listings: Listing[];
  declaredCount?: number;
  extractedCardCount: number;
  validatedCardCount: number;
  hasCatalog: boolean;
  hasJsonLd: boolean;
  locationResolved: boolean;
  locationLabel?: string;
  truncated: boolean;
  emptyMarket: boolean;
  relativeDateLabels: string[];
};

const LVIV_NAME = /львов/i;
const EMPTY_MARKET = /пропозицій не знайдено/i;
const OWNER_LABEL = /^власник$/i;
const REALTOR_LABEL = /^рієлтор$/i;

export function buildRieltorSearchUrl(
  category: RieltorCategory,
  page = 1,
  ownersOnly = false,
): string {
  const path = category === "house" ? "houses-rent" : "flats-rent";
  const params = new URLSearchParams();
  if (ownersOnly) {
    params.set("f-owners", "1");
  }
  if (page > 1) {
    params.set("page", String(page));
  }
  const query = params.toString();
  return `https://rieltor.ua/${RIELTOR_CITY_PREFIX}/${path}/${query ? `?${query}` : ""}`;
}

export function parseDeclaredCount(html: string): number | undefined {
  const empty = html.match(/data-listing-count[^>]*>([\s\S]*?)<\//);
  if (empty && EMPTY_MARKET.test(empty[1] ?? "")) {
    return 0;
  }
  const match = html.match(/data-listing-count[^>]*>\s*([\d\s]+)\s*оголошен/i);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1].replace(/\s+/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

export function sliceMainCatalog(html: string): string | undefined {
  const start = html.search(/data-listing-items\b/);
  if (start < 0) {
    return undefined;
  }
  const extras = html.indexOf("data-listing-add-items", start);
  return extras > start ? html.slice(start, extras) : html.slice(start);
}

export function resolveRieltorLocation(html: string, pageUrl: string): {
  resolved: boolean;
  label?: string;
} {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(pageUrl);
  } catch {
    return { resolved: false };
  }
  const pathOk = parsedUrl.pathname.startsWith(`/${RIELTOR_CITY_PREFIX}/`);
  const title = html.match(/<title>([^<]+)/i)?.[1] ?? "";
  const heading = html.match(/data-listing-title[^>]*>([\s\S]*?)<\//)?.[1] ?? "";
  const label = `${title} ${heading}`.replace(/\s+/g, " ").trim();
  const nameOk = LVIV_NAME.test(label);
  if (pathOk && nameOk) {
    return { resolved: true, label };
  }
  return { resolved: false, ...(label ? { label } : {}) };
}

export function extractJsonLdItems(html: string): Map<string, RieltorJsonLdItem> {
  const items = new Map<string, RieltorJsonLdItem>();
  const blocks = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1] ?? "") as { "@type"?: string; itemListElement?: unknown[] };
      if (parsed["@type"] !== "ItemList" || !Array.isArray(parsed.itemListElement)) {
        continue;
      }
      for (const entry of parsed.itemListElement) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const item = (entry as { item?: RieltorJsonLdItem }).item ?? (entry as RieltorJsonLdItem);
        if (typeof item.url === "string") {
          items.set(normalizeRieltorUrl(item.url), item);
        }
      }
    } catch {
      // JSON-LD is enrichment only; HTML cards remain authoritative.
    }
  }
  return items;
}

export function inspectRieltorHtml(
  html: string,
  options: { category: RieltorCategory; pageUrl: string; discoveredAt?: Date },
): RieltorPageInspection {
  const discoveredAt = options.discoveredAt ?? new Date();
  const location = resolveRieltorLocation(html, options.pageUrl);
  const main = sliceMainCatalog(html);
  const declaredCount = parseDeclaredCount(html);
  const emptyMarket = declaredCount === 0 || EMPTY_MARKET.test(html);
  const jsonLd = extractJsonLdItems(html);

  if (!location.resolved) {
    return {
      resultKind: "parser_failure",
      listings: [],
      extractedCardCount: 0,
      validatedCardCount: 0,
      hasCatalog: Boolean(main),
      hasJsonLd: jsonLd.size > 0,
      locationResolved: false,
      truncated: false,
      emptyMarket: false,
      relativeDateLabels: [],
      ...(location.label ? { locationLabel: location.label } : {}),
      ...(declaredCount !== undefined ? { declaredCount } : {}),
    };
  }

  if (main === undefined) {
    return {
      resultKind: "parser_failure",
      listings: [],
      extractedCardCount: 0,
      validatedCardCount: 0,
      hasCatalog: false,
      hasJsonLd: jsonLd.size > 0,
      locationResolved: true,
      truncated: false,
      emptyMarket: false,
      relativeDateLabels: [],
      ...(location.label ? { locationLabel: location.label } : {}),
      ...(declaredCount !== undefined ? { declaredCount } : {}),
    };
  }

  const cards = extractCardHtml(main);
  const listings: Listing[] = [];
  const relativeDateLabels: string[] = [];
  for (const card of cards) {
    const listing = parseRieltorCard(card, {
      category: options.category,
      jsonLd,
      discoveredAt,
    });
    if (listing) {
      listings.push(listing);
      const label = listing.metadata?.publishedLabel;
      if (typeof label === "string") {
        relativeDateLabels.push(label);
      }
    }
  }

  const truncated = declaredCount !== undefined && declaredCount > listings.length;
  const resultKind: FetchResultKind =
    listings.length > 0 ? "ok" : emptyMarket || declaredCount === 0 ? "valid_empty" : "parser_failure";

  return {
    resultKind,
    listings,
    extractedCardCount: cards.length,
    validatedCardCount: listings.length,
    hasCatalog: true,
    hasJsonLd: jsonLd.size > 0,
    locationResolved: true,
    truncated,
    emptyMarket,
    relativeDateLabels,
    ...(location.label ? { locationLabel: location.label } : {}),
    ...(declaredCount !== undefined ? { declaredCount } : {}),
  };
}

export function parseRieltorCard(
  cardHtml: string,
  options: {
    category: RieltorCategory;
    jsonLd: Map<string, RieltorJsonLdItem>;
    discoveredAt: Date;
  },
): Listing | undefined {
  const id =
    cardHtml.match(/data-catalog-item-id="(\d+)"/)?.[1] ??
    cardHtml.match(/\/view\/(\d+)\//)?.[1];
  const href = cardHtml.match(/href="(https:\/\/rieltor\.ua\/[^"]+\/view\/\d+\/)"/)?.[1];
  if (!id || !href) {
    return undefined;
  }
  const url = normalizeRieltorUrl(href);
  const json = options.jsonLd.get(url);
  const roleLabel = cardHtml.match(
    /class="catalog-card-author-subtitle"[\s\S]*?<span>([^<]+)<\/span>/,
  )?.[1]
    ?.trim();
  const agencyName = cardHtml
    .match(/class="catalog-card-author-company"[\s\S]*?>([\s\S]*?)<\/button>/)?.[1]
    ?.replace(/<[^>]+>/g, "")
    .trim();
  const owner = classifyRieltorRole(roleLabel, agencyName);
  const address = textOf(cardHtml, "catalog-card-address");
  const region = textOf(cardHtml, "catalog-card-region");
  const title = address || json?.name || `RIELTOR ${id}`;
  const city = firstLocality(region, json?.address?.addressLocality);
  const district = firstDistrict(region);
  const lat = num(attr(cardHtml, "data-latitude") ?? json?.geo?.latitude);
  const lng = num(attr(cardHtml, "data-longitude") ?? json?.geo?.longitude);
  const price = parsePrice(cardHtml, json);
  const publishedLabel = cardHtml.match(/class="catalog-card-update"[\s\S]*?<span>([^<]+)<\/span>/)?.[1]?.trim();
  const publishedAt = parseJsonLdDate(json?.offers?.availabilityStarts);
  const description = json?.description;
  const listing: Listing = {
    source: "rieltor",
    sourceId: id,
    url,
    title,
    location: {
      raw: [address, region].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || city || "Lviv",
      ...(city ? { city } : {}),
      ...(district ? { district } : {}),
      ...(lat !== undefined ? { latitude: lat } : {}),
      ...(lng !== undefined ? { longitude: lng } : {}),
    },
    propertyType: options.category,
    sellerType: owner.sellerType,
    sellerConfidence: owner.confidence,
    sellerEvidence: owner.sellerEvidence,
    discoveredAt: options.discoveredAt,
    metadata: {
      filterConsidersPrivateOwner: owner.filterConsidersPrivateOwner,
      ownerEvidenceLevel: owner.ownerEvidenceLevel,
      platformRoleLabel: roleLabel ?? null,
      coordinatePrecision: lat !== undefined && lng !== undefined ? "unspecified_point" : "missing",
      timestampPrecision: publishedAt ? "jsonld_availabilityStarts_seconds_unknown_semantics" : "relative_or_missing",
      ...(publishedLabel ? { publishedLabel } : {}),
      ...(agencyName ? { agencyName } : {}),
      jsonLdEnriched: Boolean(json),
    },
  };
  if (description) {
    listing.description = description;
  }
  if (price) {
    listing.price = price;
  }
  if (publishedAt) {
    listing.publishedAt = publishedAt;
    listing.metadata = {
      ...listing.metadata,
      publishedAtProvenance: "rieltor.jsonld.offers.availabilityStarts",
      publishedAtTimezone: "uncertain_naive_local",
      publishedAtSemantics: "unknown_created_vs_available_vs_refreshed",
    };
  }
  const rooms = num(json?.numberOfRooms);
  if (rooms !== undefined) {
    listing.rooms = rooms;
  }
  return listing;
}

function classifyRieltorRole(roleLabel: string | undefined, agencyName: string | undefined) {
  const platformOwner = roleLabel !== undefined && OWNER_LABEL.test(roleLabel);
  const platformAgent = roleLabel !== undefined && REALTOR_LABEL.test(roleLabel);
  return classifyOwner({
    platformOwner,
    platformAgent,
    offerTypeLabel: roleLabel,
    agencyName,
    extraEvidence: [
      ...(roleLabel
        ? [`RIELTOR card label = ${roleLabel}`]
        : ["RIELTOR card label missing or unrecognized"]),
      ...collectTextEvidence(roleLabel),
    ],
  });
}

function extractCardHtml(main: string): string[] {
  const cards: string[] = [];
  const starts = [...main.matchAll(/<div class="catalog-card\s*"/g)];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]?.index;
    if (start === undefined) {
      continue;
    }
    const end = starts[index + 1]?.index ?? main.length;
    cards.push(main.slice(start, end));
  }
  return cards;
}

function attr(html: string, name: string): string | undefined {
  return html.match(new RegExp(`${name}="([^"]+)"`))?.[1];
}

function textOf(html: string, className: string): string | undefined {
  const match = html.match(new RegExp(`class="${className}"[\\s\\S]*?>([\\s\\S]*?)</`));
  if (!match?.[1]) {
    return undefined;
  }
  const text = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function firstLocality(region: string | undefined, jsonLocality: string | undefined): string | undefined {
  if (jsonLocality) {
    return jsonLocality.trim();
  }
  if (!region) {
    return undefined;
  }
  const first = region.split(",")[0]?.trim();
  return first || undefined;
}

function firstDistrict(region: string | undefined): string | undefined {
  if (!region) {
    return undefined;
  }
  const parts = region.split(",").map((item) => item.trim()).filter(Boolean);
  return parts[1];
}

function parsePrice(
  cardHtml: string,
  json: RieltorJsonLdItem | undefined,
): Listing["price"] | undefined {
  const jsonAmount = num(json?.offers?.price);
  if (jsonAmount !== undefined) {
    return {
      amount: jsonAmount,
      currency: json?.offers?.priceCurrency ?? "UAH",
      period: "month",
    };
  }
  const raw =
    textOf(cardHtml, "catalog-card-price-title lun-identity-font") ??
    textOf(cardHtml, "catalog-card-price-title") ??
    attr(cardHtml, "data-label");
  if (!raw) {
    return undefined;
  }
  const amount = num(raw.replace(/[^\d.,]/g, "").replace(",", "."));
  if (amount === undefined) {
    return undefined;
  }
  let currency = "UAH";
  if (/\$/.test(raw) || /\busd\b/i.test(raw)) {
    currency = "USD";
  } else if (/€/.test(raw) || /\beur\b/i.test(raw)) {
    currency = "EUR";
  }
  return { amount, currency, period: "month" };
}

function parseJsonLdDate(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/\s+/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeRieltorUrl(url: string): string {
  return url.split("?")[0]?.replace(/\/+$/, "/") ?? url;
}
