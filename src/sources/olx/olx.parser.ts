import { listingSchema, type Listing, type PropertyType } from "../../domain/listing.ts";
import { detectPropertyType } from "../../filters/listing-filter.ts";
import { classifyOwner, sellerAnnotation } from "../../filters/owner-filter.ts";
import { collectTextEvidence } from "../../utils/text-evidence.ts";
import { olxOfferSchema, type OlxOffer } from "./olx.types.ts";

function readPrice(offer: OlxOffer): Listing["price"] | undefined {
  const params = offer.params ?? [];
  const priceParam = params.find((item) => item.key === "price");
  const value = priceParam?.value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const amount = typeof record.value === "number" ? record.value : Number(record.value);
    const currency = typeof record.currency === "string" ? record.currency.trim() : "";
    if (Number.isFinite(amount) && currency) {
      return { amount, currency, period: "month" };
    }
  }
  return undefined;
}

function sellerSignals(offer: OlxOffer) {
  const company = offer.user?.company_name?.trim() || undefined;
  const userSellerType =
    typeof offer.user?.sellerType === "string" && offer.user.sellerType.trim()
      ? offer.user.sellerType.trim()
      : undefined;
  const sellerName = offer.user?.name?.trim() || undefined;
  const publicText = [offer.title, offer.description, sellerName].filter(Boolean).join("\n");
  const extra = collectTextEvidence(publicText);
  if (offer.business === false) {
    extra.unshift(
      "OLX isBusiness/business = false (private account, not proof of property ownership)",
    );
  }
  if (offer.business === true) {
    extra.unshift(
      "OLX isBusiness/business = true (account type, not proof of agency/realtor status)",
    );
  }
  if (userSellerType) {
    extra.push(`OLX user.sellerType = ${userSellerType}`);
  } else if (
    offer.user &&
    (offer.user.sellerType === null || offer.user.sellerType === undefined)
  ) {
    extra.push("OLX user.sellerType is null (does not establish ownership)");
  }
  return classifyOwner({
    platformPrivate: offer.business === false,
    isBusiness: offer.business === true,
    agencyName: company,
    text: publicText,
    extraEvidence: extra,
  });
}

function propertyTypeFromOlx(offer: OlxOffer): PropertyType {
  const categoryId = Number(offer.category?.id);
  // 1760 = long-term apartment rent; 330 = long-term house rent (see olx.source.ts).
  if (categoryId === 1760) {
    return "apartment";
  }
  if (categoryId === 330) {
    return "house";
  }
  return detectPropertyType({
    title: offer.title,
    categoryText: `${offer.title ?? ""} ${JSON.stringify(offer.category ?? {})}`,
  });
}

/**
 * Extract the short ID token from an OLX listing URL (e.g. "11gWHG" from `...-ID11gWHG.html`).
 *
 * Use string comparison of tokens for exact identity matching (e.g. against LUN originalUrl).
 * Do NOT base62-decode the token into the numeric offer id: verified live on 2026-09-15 that
 * token<->id is not a consistent base62 mapping (offer 934944232 carries token 11gWHG while
 * offer 934948076 carries token 11gVHG).
 */
export function extractOlxUrlToken(url: string): string | undefined {
  const match = /ID([A-Za-z0-9]+)\.html/i.exec(url);
  return match?.[1];
}

function photoLinks(photos: OlxOffer["photos"] | undefined): string[] {
  if (!Array.isArray(photos)) {
    return [];
  }
  const links: string[] = [];
  for (const photo of photos) {
    if (typeof photo === "string" && /^https?:\/\//i.test(photo)) {
      links.push(photo);
      continue;
    }
    if (photo && typeof photo === "object") {
      const link = photo.link ?? photo.url;
      if (typeof link === "string" && /^https?:\/\//i.test(link)) {
        links.push(link);
      }
    }
  }
  return links;
}

function formatZodIssue(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  const first = error.issues[0];
  if (!first) {
    return "unknown validation issue";
  }
  const path = first.path.length > 0 ? first.path.map(String).join(".") : "(root)";
  return `${path}: ${first.message}`;
}

function buildListingFromOffer(offer: OlxOffer, discoveredAt: Date): Listing | undefined {
  const sourceId = String(offer.id);
  const url = offer.url ?? `https://www.olx.ua/d/obyavlenie/-ID${sourceId}.html`;
  if (!offer.title) {
    return undefined;
  }
  const owner = sellerSignals(offer);
  const city = offer.location?.city?.name;
  const district = offer.location?.district?.name;
  const rawLocation = [city, district].filter(Boolean).join(", ") || "unknown";
  const price = readPrice(offer);
  const lat = offer.map?.lat ?? offer.location?.lat;
  const lon = offer.map?.lon ?? offer.location?.lon;
  const published = offer.created_time;
  let refreshedAt: Date | undefined;
  if (offer.last_refresh_time) {
    const refreshed = new Date(offer.last_refresh_time);
    if (!Number.isNaN(refreshed.getTime())) {
      refreshedAt = refreshed;
    }
  }
  const urlToken = extractOlxUrlToken(url);
  const showDetailed = offer.map?.show_detailed;
  const listing: Listing = {
    source: "olx",
    sourceId,
    url,
    title: offer.title,
    location: {
      raw: rawLocation,
      ...(city ? { city } : {}),
      ...(district ? { district } : {}),
      ...(lat !== undefined ? { latitude: lat } : {}),
      ...(lon !== undefined ? { longitude: lon } : {}),
    },
    propertyType: propertyTypeFromOlx(offer),
    sellerType: owner.sellerType,
    sellerConfidence: owner.confidence,
    sellerEvidence: owner.sellerEvidence,
    discoveredAt,
    ...(refreshedAt ? { refreshedAt } : {}),
    metadata: {
      filterConsidersPrivateOwner: owner.filterConsidersPrivateOwner,
      filterConsidersSelfDeclaredOwner: owner.filterConsidersSelfDeclaredOwner,
      ownerEvidenceLevel: owner.ownerEvidenceLevel,
      ...sellerAnnotation(owner),
      transportCandidate: "public JSON API api/v1/offers",
      publishedAtProvenance: offer.created_time ? "olx.createdTime" : "missing",
      ...(urlToken ? { urlToken } : {}),
      ...(offer.map?.radius !== undefined ? { coordinatesRadiusKm: offer.map.radius } : {}),
      ...(showDetailed !== undefined ? { coordinatesShowDetailed: showDetailed } : {}),
      ...(showDetailed === false ? { coordinatesApproximate: true } : {}),
      ...(offer.last_refresh_time ? { lastRefreshTime: offer.last_refresh_time } : {}),
      ...(offer.pushup_time ? { pushupTime: offer.pushup_time } : {}),
      ...(offer.business !== undefined ? { olxIsBusiness: offer.business } : {}),
      ...(offer.user?.id !== undefined ? { olxUserId: String(offer.user.id) } : {}),
      ...(offer.user ? { olxUserSellerType: offer.user.sellerType ?? null } : {}),
      ...(offer.category?.id !== undefined ? { olxCategoryId: offer.category.id } : {}),
    },
  };
  if (offer.description) {
    listing.description = offer.description;
  }
  if (price) {
    listing.price = price;
  }
  if (published) {
    const date = new Date(published);
    if (!Number.isNaN(date.getTime())) {
      listing.publishedAt = date;
    }
  }
  const images = photoLinks(offer.photos);
  if (images.length > 0) {
    listing.images = images;
  }
  return listing;
}

/**
 * Why parseOlxOffer returned undefined. Used in extract diagnostics; does not invent listings.
 */
export function diagnoseOlxOfferParse(offerRaw: unknown, discoveredAt = new Date()): string {
  const parsed = olxOfferSchema.safeParse(offerRaw);
  if (!parsed.success) {
    return `offer_schema ${formatZodIssue(parsed.error)}`;
  }
  const built = buildListingFromOffer(parsed.data, discoveredAt);
  if (!built) {
    return "missing_title";
  }
  const validated = listingSchema.safeParse(built);
  if (!validated.success) {
    return `listing_schema ${formatZodIssue(validated.error)}`;
  }
  return "unknown_parse_failure";
}

export function parseOlxOffer(offerRaw: unknown, discoveredAt = new Date()): Listing | undefined {
  const parsed = olxOfferSchema.safeParse(offerRaw);
  if (!parsed.success) {
    return undefined;
  }
  const listing = buildListingFromOffer(parsed.data, discoveredAt);
  if (!listing) {
    return undefined;
  }
  const validated = listingSchema.safeParse(listing);
  return validated.success ? validated.data : undefined;
}

export function parseOlxOffersPayload(payload: unknown, discoveredAt = new Date()): Listing[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((item) => parseOlxOffer(item, discoveredAt))
    .filter((item): item is Listing => Boolean(item));
}
