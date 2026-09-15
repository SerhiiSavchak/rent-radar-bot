import type { Listing } from "../../domain/listing.ts";
import { detectPropertyType } from "../../filters/listing-filter.ts";
import { classifyOwner } from "../../filters/owner-filter.ts";
import { collectTextEvidence } from "../../utils/text-evidence.ts";
import { DOMRIA_OFFER_TYPE, domriaInfoSchema, type DomriaInfo } from "./domria.types.ts";

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function offerType(info: DomriaInfo): string | undefined {
  const raw = info.characteristics_values?.["1437"];
  const id = raw === undefined ? undefined : String(raw);
  if (!id) {
    return undefined;
  }
  return DOMRIA_OFFER_TYPE[id] ?? `characteristic 1437 = ${id}`;
}

export function parseDomriaInfo(raw: unknown, discoveredAt = new Date()): Listing | undefined {
  const parsed = domriaInfoSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const info = parsed.data;
  const sourceId = info.realty_id !== undefined ? String(info.realty_id) : undefined;
  const path = info.beautiful_url ?? info.beautifulUrl;
  if (!sourceId || !path) {
    return undefined;
  }
  const url = path.startsWith("http") ? path : `https://dom.ria.com/uk/${path.replace(/^\//, "")}`;
  const city = info.city_name_uk ?? info.city_name;
  const district = info.district_name_uk ?? info.district_name;
  const street = info.street_name_uk ?? info.street_name;
  const title =
    [info.realty_type_name_uk, street, city].filter(Boolean).join(", ") || `DIM.RIA ${sourceId}`;
  const description = info.description_uk || info.description;
  const offer = offerType(info);
  const agencyId = num(info.agency_id) ?? 0;
  const owner = classifyOwner({
    platformOwner: offer === "від власника",
    platformAgent: offer === "від посередника" || agencyId > 0,
    platformBusiness: offer === "від забудовника" || offer === "від представника забудовника",
    offerTypeLabel: offer,
    agencyId: agencyId > 0 ? agencyId : undefined,
    text: `${title}\n${description ?? ""}`,
    extraEvidence: collectTextEvidence(`${title}\n${description ?? ""}`),
  });
  const lat = num(info.latitude);
  const lng = num(info.longitude);
  const amount = num(info.price);
  const publishedRaw = info.publishing_date ?? info.publishingDate;
  const listing: Listing = {
    source: "domria",
    sourceId,
    url,
    title,
    location: {
      raw: [street, district, city].filter(Boolean).join(", ") || "Lviv",
      ...(city ? { city } : {}),
      ...(district ? { district } : {}),
      ...(lat !== undefined ? { latitude: lat } : {}),
      ...(lng !== undefined ? { longitude: lng } : {}),
    },
    propertyType: detectPropertyType({
      realtyTypeId: info.realty_type_id,
      categoryText: `${info.realty_type_name_uk ?? ""} ${info.advert_type_name_uk ?? ""} ${path}`,
    }),
    sellerType: owner.sellerType,
    sellerEvidence: owner.sellerEvidence,
    discoveredAt,
    metadata: {
      filterConsidersPrivateOwner: owner.filterConsidersPrivateOwner,
      advertType: info.advert_type_name_uk ?? info.advert_type_name,
      userId: info.user_id,
    },
  };
  if (description) {
    listing.description = description;
  }
  if (amount !== undefined) {
    listing.price = {
      amount,
      currency: info.currency_type ?? "UAH",
      period: "month",
    };
  }
  if (publishedRaw) {
    const publishedAt = new Date(publishedRaw.replace(" ", "T"));
    if (!Number.isNaN(publishedAt.getTime())) {
      listing.publishedAt = publishedAt;
    }
  }
  if (info.main_photo) {
    listing.images = [`https://cdn.riastatic.com/photosnew/${info.main_photo}`];
  }
  return listing;
}

export function extractInitialStateJson(html: string): unknown {
  const marker = "__INITIAL_STATE__=";
  const index = html.indexOf(marker);
  if (index === -1) {
    throw new Error("DIM.RIA __INITIAL_STATE__ not found");
  }
  const raw = html.slice(index + marker.length);
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return JSON.parse(raw.slice(start, i + 1)) as unknown;
      }
    }
  }
  throw new Error("DIM.RIA __INITIAL_STATE__ JSON was truncated");
}

export function parseDomriaCatalog(state: unknown, discoveredAt = new Date()): Listing[] {
  if (!state || typeof state !== "object") {
    return [];
  }
  const catalog = (state as { catalog?: { realtyForCatalog?: unknown } }).catalog;
  const items = catalog?.realtyForCatalog;
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => parseDomriaInfo(item, discoveredAt))
    .filter((item): item is Listing => Boolean(item));
}
