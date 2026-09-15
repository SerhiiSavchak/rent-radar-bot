import type { Listing } from "../../domain/listing.ts";
import { detectPropertyType } from "../../filters/listing-filter.ts";
import { classifyOwner } from "../../filters/owner-filter.ts";
import { normalizeLatLng } from "../../utils/geo.ts";
import { collectTextEvidence } from "../../utils/text-evidence.ts";
import { lunCardSchema, type LunCard } from "./lun.types.ts";

function extractNextFlightPayload(html: string): string | undefined {
  const match = html.match(/self\.__next_f\.push\(\[1,"([\s\S]*)"\]\)/);
  if (!match?.[1]) {
    return undefined;
  }
  return JSON.parse(`"${match[1]}"`) as string;
}

export function extractLunCards(html: string): LunCard[] {
  const payload = extractNextFlightPayload(html);
  if (!payload) {
    return [];
  }
  const marker = '"realties":{"cards":[';
  const index = payload.indexOf(marker);
  if (index === -1) {
    return [];
  }
  const arrStart = payload.indexOf("[", index + marker.length - 1);
  let depth = 0;
  for (let i = arrStart; i < payload.length; i += 1) {
    const char = payload[i];
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        const parsed = JSON.parse(payload.slice(arrStart, i + 1)) as unknown;
        if (!Array.isArray(parsed)) {
          return [];
        }
        return parsed
          .map((item) => lunCardSchema.safeParse(item))
          .filter((item) => item.success)
          .map((item) => item.data);
      }
    }
  }
  return [];
}

export function parseLunJsonLdItems(html: string): Array<Record<string, unknown>> {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
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
  const text = [card.header, card.text, jsonDescription].filter(Boolean).join("\n");
  const owner = classifyOwner({
    platformOwner: card.isOwner === true,
    platformAgent: Boolean(card.agency),
    agencyName: card.agency?.name,
    agencyId: card.agency?.id,
    withoutCommission: card.withoutCommission === true,
    text,
    extraEvidence: [
      ...collectTextEvidence(text),
      ...(card.site?.displayName ? [`aggregated site = ${card.site.displayName}`] : []),
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
    sellerEvidence: owner.sellerEvidence,
    discoveredAt,
    metadata: {
      filterConsidersPrivateOwner: owner.filterConsidersPrivateOwner,
      originalUrl: card.urlRaw,
      withoutCommission: card.withoutCommission,
      isOwner: card.isOwner,
    },
  };
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
  const published = card.insertTime ?? card.downloadTime;
  if (published) {
    const date = new Date(published);
    if (!Number.isNaN(date.getTime())) {
      listing.publishedAt = date;
    }
  }
  const imageIds = (card.images ?? [])
    .map((image) => image.imageId)
    .filter((id): id is number => typeof id === "number")
    .slice(0, 5);
  if (imageIds.length > 0) {
    listing.images = imageIds.map(
      (id) => `https://market-images.lunstatic.net/lun-ua/720/960/images/${id}.jpg`,
    );
  }
  return listing;
}

export function parseLunHtml(html: string, discoveredAt = new Date()): Listing[] {
  const cards = extractLunCards(html);
  const jsonLd = parseLunJsonLdItems(html);
  return cards
    .map((card, index) => parseLunCard(card, jsonLd[index], discoveredAt))
    .filter((item): item is Listing => Boolean(item));
}
