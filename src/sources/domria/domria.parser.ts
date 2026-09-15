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

function classifyDomriaRole(info: DomriaInfo): {
  offerLabel?: string;
  platformOwner?: boolean;
  platformAgent?: boolean;
  platformBusiness?: boolean;
  recognized: boolean;
} {
  const raw = info.characteristics_values?.["1437"];
  if (raw === undefined || raw === null || raw === "") {
    return { recognized: false };
  }
  const id = String(raw);
  const offerLabel = DOMRIA_OFFER_TYPE[id];
  if (!offerLabel) {
    return { recognized: false, offerLabel: `unrecognized characteristic 1437 = ${id}` };
  }
  return {
    offerLabel,
    recognized: true,
    platformOwner: offerLabel === "від власника",
    platformAgent: offerLabel === "від посередника" || offerLabel === "від представника власника (без комісійних)",
    platformBusiness: offerLabel === "від забудовника" || offerLabel === "від представника забудовника",
  };
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
  const role = classifyDomriaRole(info);
  const agencyId = num(info.agency_id) ?? 0;
  const owner = classifyOwner({
    platformOwner: role.platformOwner === true,
    platformAgent: role.platformAgent === true,
    platformBusiness: role.platformBusiness === true,
    offerTypeLabel: role.offerLabel,
    text: `${title}\n${description ?? ""}`,
    extraEvidence: [
      ...collectTextEvidence(`${title}\n${description ?? ""}`),
      ...(agencyId > 0 ? [`agency_id=${agencyId} (not used as ownership proof)`] : []),
      ...(!role.recognized ? ["characteristic 1437 missing or unrecognized"] : []),
    ],
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
    sellerConfidence: owner.confidence,
    sellerEvidence: owner.sellerEvidence,
    discoveredAt,
    metadata: {
      filterConsidersPrivateOwner: owner.filterConsidersPrivateOwner,
      sellerConfidence: owner.confidence,
      advertType: info.advert_type_name_uk ?? info.advert_type_name,
      userId: info.user_id,
      characteristic1437Recognized: role.recognized,
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
