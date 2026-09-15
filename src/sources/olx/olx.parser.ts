import type { Listing } from "../../domain/listing.ts";
import { detectPropertyType } from "../../filters/listing-filter.ts";
import { classifyOwner } from "../../filters/owner-filter.ts";
import { collectTextEvidence } from "../../utils/text-evidence.ts";
import { olxOfferSchema, type OlxOffer } from "./olx.types.ts";

function readPrice(offer: OlxOffer): Listing["price"] | undefined {
  const params = offer.params ?? [];
  const priceParam = params.find((item) => item.key === "price");
  const value = priceParam?.value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const amount = typeof record.value === "number" ? record.value : Number(record.value);
    const currency = typeof record.currency === "string" ? record.currency : "UAH";
    if (Number.isFinite(amount)) {
      return { amount, currency, period: "month" };
    }
  }
  return undefined;
}

function sellerSignals(offer: OlxOffer) {
  const company = offer.user?.company_name;
  const business = offer.business === true || Boolean(company);
  const extra = collectTextEvidence(`${offer.title ?? ""} ${offer.description ?? ""}`);
  if (offer.business === false) {
    extra.unshift("OLX business flag = false (private account, not proof of property ownership)");
  }
  return classifyOwner({
    platformPrivate: offer.business === false,
    platformBusiness: business,
    isBusiness: business,
    agencyName: company ?? undefined,
    text: `${offer.title ?? ""}\n${offer.description ?? ""}`,
    extraEvidence: extra,
  });
}

export function parseOlxOffer(offerRaw: unknown, discoveredAt = new Date()): Listing | undefined {
  const parsed = olxOfferSchema.safeParse(offerRaw);
  if (!parsed.success) {
    return undefined;
  }
  const offer = parsed.data;
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
  const published = offer.last_refresh_time ?? offer.created_time;
  const listing: Listing = {
    source: "olx",
    sourceId,
    url,
    title: offer.title,
    location: {
      raw: rawLocation,
      ...(city ? { city } : {}),
      ...(district ? { district } : {}),
      ...(offer.location?.lat !== undefined ? { latitude: offer.location.lat } : {}),
      ...(offer.location?.lon !== undefined ? { longitude: offer.location.lon } : {}),
    },
    propertyType: detectPropertyType({ categoryText: `${offer.title} ${JSON.stringify(offer.category ?? {})}` }),
    sellerType: owner.sellerType,
    sellerEvidence: owner.sellerEvidence,
    discoveredAt,
    metadata: {
      filterConsidersPrivateOwner: owner.filterConsidersPrivateOwner,
      transportCandidate: "public JSON API api/v1/offers",
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
  const images = (offer.photos ?? [])
    .map((photo) => photo.link)
    .filter((link): link is string => Boolean(link));
  if (images.length > 0) {
    listing.images = images;
  }
  return listing;
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
