import type { Listing } from "../../domain/listing.ts";
import { detectPropertyType } from "../../filters/listing-filter.ts";
import { classifyOwner, sellerAnnotation } from "../../filters/owner-filter.ts";
import { normalizeLatLng } from "../../utils/geo.ts";
import { collectTextEvidence } from "../../utils/text-evidence.ts";
import { lunCardSchema, type LunCard } from "./lun.types.ts";

const NEXT_FLIGHT_PREFIX = 'self.__next_f.push([1,"';

/**
 * Extract each Next.js flight string payload separately.
 * A greedy regex across multiple push() calls concatenates later RSC records into one
 * string and causes JSON.parse: "Unexpected non-whitespace character after JSON".
 */
export function extractNextFlightPayloads(html: string): string[] {
  const payloads: string[] = [];
  let from = 0;
  while (from < html.length) {
    const start = html.indexOf(NEXT_FLIGHT_PREFIX, from);
    if (start === -1) {
      break;
    }
    let i = start + NEXT_FLIGHT_PREFIX.length;
    let raw = "";
    let closed = false;
    while (i < html.length) {
      const ch = html[i]!;
      if (ch === "\\") {
        raw += ch;
        if (i + 1 < html.length) {
          raw += html[i + 1]!;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '"') {
        try {
          payloads.push(JSON.parse(`"${raw}"`) as string);
        } catch {
          // Malformed/truncated string literal — skip this chunk only.
        }
        from = i + 1;
        closed = true;
        break;
      }
      raw += ch;
      i += 1;
    }
    if (!closed) {
      break;
    }
  }
  return payloads;
}

/** @deprecated use extractNextFlightPayloads — kept for call-site clarity in markers */
export function extractNextFlightPayload(html: string): string | undefined {
  return extractNextFlightPayloads(html).find((payload) =>
    payload.includes('"realties":{"cards":['),
  );
}

export type LunCardsExtraction = {
  cards: LunCard[];
  rawCardCount: number;
  /** true when cards marker existed but JSON array could not be parsed */
  cardsParseFailed: boolean;
  payloadCount: number;
};

export function extractLunCardsDetailed(html: string): LunCardsExtraction {
  const payloads = extractNextFlightPayloads(html);
  const marker = '"realties":{"cards":[';
  let cardsParseFailed = false;
  let rawCardCount = 0;
  const cards: LunCard[] = [];

  for (const payload of payloads) {
    const index = payload.indexOf(marker);
    if (index === -1) {
      continue;
    }
    const arrStart = payload.indexOf("[", index + marker.length - 1);
    if (arrStart < 0) {
      cardsParseFailed = true;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = arrStart; i < payload.length; i += 1) {
      const char = payload[i];
      if (char === "[") {
        depth += 1;
      } else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) {
      cardsParseFailed = true;
      continue;
    }
    try {
      const parsed = JSON.parse(payload.slice(arrStart, end + 1)) as unknown;
      if (!Array.isArray(parsed)) {
        cardsParseFailed = true;
        continue;
      }
      rawCardCount += parsed.length;
      for (const item of parsed) {
        const safe = lunCardSchema.safeParse(item);
        if (safe.success) {
          cards.push(safe.data);
        }
      }
    } catch {
      cardsParseFailed = true;
    }
  }

  return {
    cards,
    rawCardCount,
    cardsParseFailed,
    payloadCount: payloads.length,
  };
}

export function extractLunCards(html: string): LunCard[] {
  return extractLunCardsDetailed(html).cards;
}

export function parseLunJsonLdItems(html: string): Array<Record<string, unknown>> {
  const blocks = [
    ...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi),
  ];
  for (const block of blocks) {
    const raw = block[1];
    if (!raw) {
      continue;
    }
    try {
      const json = JSON.parse(raw) as { itemListElement?: unknown };
      if (Array.isArray(json.itemListElement)) {
        return json.itemListElement
          .map((entry) => {
            if (entry && typeof entry === "object" && "item" in entry) {
              return (entry as { item: Record<string, unknown> }).item;
            }
            return undefined;
          })
          .filter((item): item is Record<string, unknown> => Boolean(item && item["@type"]));
      }
    } catch {
      continue;
    }
  }
  return [];
}

function geoFromCard(card: LunCard): { latitude?: number; longitude?: number } {
  const location = card.location;
  if (!location || location.length < 2) {
    return {};
  }
  const lng = location[0];
  const lat = location[1];
  if (lng === undefined || lat === undefined) {
    return {};
  }
  return normalizeLatLng(lat, lng);
}

const LUN_REALTOR_CONTACT_TYPES = new Set([
  "rieltor",
  "realtor",
  "agent",
  "agency",
  "intermediary",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Structured LUN contact. The source domain alone is not a realtor role. */
function readLunRieltorContact(value: unknown): {
  platformAgent: boolean;
  agencyName?: string;
  contactName?: string;
  notes: string[];
} {
  const contact = asRecord(value);
  const contactType = trimmed(contact?.contactType)?.toLowerCase();
  const agency = asRecord(contact?.agency);
  const agencyName = trimmed(agency?.name);
  const contactName = trimmed(contact?.name);
  const structuredRole = Boolean(contactType && LUN_REALTOR_CONTACT_TYPES.has(contactType));
  return {
    platformAgent: structuredRole || Boolean(agencyName),
    ...(agencyName ? { agencyName } : {}),
    ...(contactName ? { contactName } : {}),
    notes: [
      ...(contactType ? [`lun.rieltorContact.contactType=${contactType}`] : []),
      ...(agencyName ? [`lun.rieltorContact.agency=${agencyName}`] : []),
    ],
  };
}

function locationLabel(card: LunCard, jsonLd?: Record<string, unknown>): string {
  if (jsonLd && typeof jsonLd.name === "string" && jsonLd.name.trim()) {
    return jsonLd.name;
  }
  if (typeof card.header === "string" && card.header.trim()) {
    return card.header;
  }
  return `LUN ${String(card.id)}`;
}

export function parseLunCard(
  card: LunCard,
  jsonLd: Record<string, unknown> | undefined,
  discoveredAt = new Date(),
): Listing | undefined {
  const sourceId = String(card.id);
  const url = `https://lun.ua/uk/realty/${sourceId}`;
  const jsonDescription = typeof jsonLd?.description === "string" ? jsonLd.description : undefined;
  const contact = readLunRieltorContact(card.rieltorContact);
  const text = [card.header, card.text, jsonDescription, contact.contactName, contact.agencyName]
    .filter(Boolean)
    .join("\n");
  const owner = classifyOwner({
    platformOwner: card.isOwner === true,
    platformAgent: Boolean(card.agency) || contact.platformAgent,
    agencyName: card.agency?.name ?? contact.agencyName,
    agencyId: card.agency?.id,
    withoutCommission: card.withoutCommission === true,
    text,
    extraEvidence: [
      ...collectTextEvidence(text),
      ...(card.isOwner === true ? ["lun.isOwner=true"] : []),
      ...(card.site?.displayName ? [`aggregated site = ${card.site.displayName}`] : []),
      ...(card.urlRaw ? [`originalUrl=${card.urlRaw}`] : []),
      ...contact.notes,
    ],
  });
  const coords = geoFromCard(card);
  const address =
    jsonLd && typeof jsonLd.address === "object" && jsonLd.address
      ? (jsonLd.address as { addressLocality?: string; streetAddress?: string })
      : undefined;
  const title = locationLabel(card, jsonLd);
  const listing: Listing = {
    source: "lun",
    sourceId,
    url,
    title,
    location: {
      raw: [address?.streetAddress, address?.addressLocality, title].filter(Boolean).join(", "),
      ...(address?.addressLocality ? { city: address.addressLocality } : { city: "Львів" }),
      ...coords,
    },
    propertyType: detectPropertyType({
      sectionId: card.sectionId,
      categoryText: `${title} ${jsonLd && Array.isArray(jsonLd["@type"]) ? jsonLd["@type"].join(" ") : ""}`,
    }),
    sellerType: owner.sellerType,
    sellerConfidence: owner.confidence,
    sellerEvidence: owner.sellerEvidence,
    discoveredAt,
    metadata: {
      filterConsidersPrivateOwner: owner.filterConsidersPrivateOwner,
      ownerEvidenceLevel: owner.ownerEvidenceLevel,
      originalUrl: card.urlRaw,
      originalHost: originalListingHost(card.urlRaw),
      withoutCommission: card.withoutCommission,
      isOwner: card.isOwner,
      ...sellerAnnotation(owner),
      ...lunProvenanceMetadata(card),
    },
  };
  if (typeof card.roomCount === "number") {
    listing.rooms = card.roomCount;
  }
  const area = finiteNumber((card as { areaTotal?: unknown }).areaTotal);
  if (area !== undefined) {
    listing.areaM2 = area;
  }
  if (jsonDescription) {
    listing.description = jsonDescription;
  } else if (card.text) {
    listing.description = card.text;
  }
  if (card.price !== undefined) {
    listing.price = {
      amount: card.price,
      currency: (card.currency ?? "UAH").toUpperCase(),
      period: "month",
    };
  }
  // insertTime is listing creation; downloadTime is platform ingest/observation — not publishedAt.
  if (card.insertTime) {
    const date = new Date(card.insertTime);
    if (!Number.isNaN(date.getTime())) {
      listing.publishedAt = date;
      listing.metadata = {
        ...listing.metadata,
        publishedAtProvenance: "lun.insertTime",
        publishedAtTimezone: "uncertain_naive_local",
      };
    }
  }
  if (card.downloadTime) {
    const downloaded = new Date(card.downloadTime);
    if (!Number.isNaN(downloaded.getTime())) {
      // Keep as metadata only — not refreshedAt (semantics are ingest, not bump).
      listing.metadata = {
        ...listing.metadata,
        downloadTime: card.downloadTime,
      };
    }
  }
  const imageIds = (card.images ?? [])
    .map((image) => image.imageId)
    .map((id) =>
      typeof id === "number"
        ? id
        : typeof id === "string" && /^\d+$/.test(id)
          ? Number(id)
          : undefined,
    )
    .filter((id): id is number => id !== undefined)
    .slice(0, 5);
  if (imageIds.length > 0) {
    listing.images = imageIds.map(
      (id) => `https://market-images.lunstatic.net/lun-ua/720/960/images/${id}.jpg`,
    );
  }
  return listing;
}

export function parseLunHtml(html: string, discoveredAt = new Date()): Listing[] {
  return inspectLunHtml(html, discoveredAt).listings;
}

export type LunHtmlInspection = {
  listings: Listing[];
  hasNextFlight: boolean;
  hasRscCardsMarker: boolean;
  hasJsonLdList: boolean;
  rawCardCount: number;
  validatedCardCount: number;
  validationRatio: number;
  resultKind: "ok" | "valid_empty" | "parser_failure";
  cardsParseFailed: boolean;
};

export function inspectLunHtml(html: string, discoveredAt = new Date()): LunHtmlInspection {
  const payloads = extractNextFlightPayloads(html);
  const hasNextFlight = payloads.length > 0;
  const hasRscCardsMarker = payloads.some((payload) => payload.includes('"realties":{"cards":['));
  const jsonLd = parseLunJsonLdItems(html);
  const hasJsonLdList = jsonLd.length > 0;
  const extracted = extractLunCardsDetailed(html);
  const cards = extracted.cards;
  const listings = cards
    .map((card, index) => parseLunCard(card, jsonLd[index], discoveredAt))
    .filter((item): item is Listing => Boolean(item));
  const validatedCardCount = cards.length;
  const rawCardCount = extracted.rawCardCount;
  const validationRatio = rawCardCount > 0 ? validatedCardCount / rawCardCount : 0;

  let resultKind: LunHtmlInspection["resultKind"];
  if (extracted.cardsParseFailed) {
    // Marker/framing present but payload unreadable — not a healthy empty market.
    resultKind = "parser_failure";
  } else if (!hasRscCardsMarker) {
    resultKind = "parser_failure";
  } else if (rawCardCount > 0 && listings.length === 0) {
    // Cards were present but none validated. That is a schema break, not an empty market.
    resultKind = "parser_failure";
  } else if (rawCardCount === 0) {
    resultKind = "valid_empty";
  } else {
    resultKind = "ok";
  }

  return {
    listings,
    hasNextFlight,
    hasRscCardsMarker,
    hasJsonLdList,
    rawCardCount,
    validatedCardCount,
    validationRatio,
    resultKind,
    cardsParseFailed: extracted.cardsParseFailed,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Explicit LUN cluster fields. Stored as evidence only; nothing is dropped from them. */
function lunProvenanceMetadata(card: LunCard): Record<string, unknown> {
  const raw = card as LunCard & {
    groupId?: unknown;
    similarPageIds?: unknown;
    hasDuplicates?: unknown;
    floor?: unknown;
    floorCount?: unknown;
    site?: { internalName?: string; displayName?: string };
  };
  const metadata: Record<string, unknown> = {};
  if (typeof raw.groupId === "string" || typeof raw.groupId === "number") {
    metadata.lunGroupId = String(raw.groupId);
  }
  if (Array.isArray(raw.similarPageIds)) {
    const ids = raw.similarPageIds
      .filter((item) => typeof item === "number" || typeof item === "string")
      .map((item) => String(item));
    if (ids.length > 0) {
      metadata.similarPageIds = ids;
    }
  }
  if (typeof raw.hasDuplicates === "boolean") {
    metadata.hasDuplicates = raw.hasDuplicates;
  }
  const floor = finiteNumber(raw.floor);
  const floorCount = finiteNumber(raw.floorCount);
  if (floor !== undefined) {
    metadata.floor = floor;
  }
  if (floorCount !== undefined) {
    metadata.totalFloors = floorCount;
  }
  if (raw.site?.internalName) {
    metadata.aggregatedSite = raw.site.internalName;
  }
  return metadata;
}

export function originalListingHost(urlRaw: string | undefined): string | undefined {
  if (!urlRaw) {
    return undefined;
  }
  try {
    return new URL(urlRaw).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
