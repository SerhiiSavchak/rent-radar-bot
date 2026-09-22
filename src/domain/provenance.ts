import type { Listing } from "./listing.ts";
import { canonicalListingUrl } from "../delivery/delivery-ports.ts";

export type ExternalPlatform = "olx" | "rieltor" | "domria";

export type ListingProvenance = {
  source: string;
  sourceListingId: string;
  canonicalUrl: string;
  externalSourceName?: string;
  externalSourceUrl?: string;
  externalListingId?: string;
  groupId?: string;
  similarPageIds?: string[];
  hasDuplicates?: boolean;
  platformSiteName?: string;
  notes?: string[];
};

export type IdentityKeyClass = "own" | "explicit_external" | "lun_cluster";

export type IdentityKey = {
  key: string;
  keyClass: IdentityKeyClass;
};

export type ProvenanceListing = Pick<Listing, "source" | "sourceId" | "url"> &
  Partial<
    Pick<
      Listing,
      | "metadata"
      | "rooms"
      | "areaM2"
      | "price"
      | "location"
      | "title"
      | "description"
      | "sellerType"
      | "sellerEvidence"
      | "sellerConfidence"
    >
  >;

const OLX_TOKEN = /ID([A-Za-z0-9]+)\.html/i;
const RIELTOR_VIEW = /\/view\/(\d+)(?:\/|$)/i;
const DOMRIA_ID = /(\d{6,})\.html$/i;

export function platformFromHost(hostname: string): ExternalPlatform | "lun" | undefined {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  if (host === "olx.ua" || host.endsWith(".olx.ua")) {
    return "olx";
  }
  if (host === "rieltor.ua" || host.endsWith(".rieltor.ua")) {
    return "rieltor";
  }
  if (host === "dom.ria.com" || host.endsWith(".dom.ria.com")) {
    return "domria";
  }
  if (host === "lun.ua" || host.endsWith(".lun.ua")) {
    return "lun";
  }
  return undefined;
}

export function externalListingId(platform: ExternalPlatform, rawUrl: string): string | undefined {
  if (platform === "olx") {
    return OLX_TOKEN.exec(rawUrl)?.[1];
  }
  if (platform === "rieltor") {
    return RIELTOR_VIEW.exec(rawUrl)?.[1];
  }
  return DOMRIA_ID.exec(new URL(rawUrl).pathname)?.[1];
}

function metaString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function metaStringList(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map((item) => String(item));
}

function metaBoolean(
  metadata: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readProvenance(listing: ProvenanceListing): ListingProvenance {
  const metadata = listing.metadata;
  const canonicalUrl = canonicalListingUrl(listing.url);
  const provenance: ListingProvenance = {
    source: listing.source,
    sourceListingId: listing.sourceId,
    canonicalUrl,
  };
  const notes: string[] = [];
  const groupId = metaString(metadata, "lunGroupId");
  if (groupId) {
    provenance.groupId = groupId;
  }
  const similar = metaStringList(metadata, "similarPageIds");
  if (similar.length > 0) {
    provenance.similarPageIds = similar;
  }
  const hasDuplicates = metaBoolean(metadata, "hasDuplicates");
  if (hasDuplicates !== undefined) {
    provenance.hasDuplicates = hasDuplicates;
  }
  const siteName = metaString(metadata, "aggregatedSite");
  if (siteName) {
    provenance.platformSiteName = siteName;
  }
  const rawExternal = metaString(metadata, "originalUrl");
  if (rawExternal) {
    try {
      const parsed = new URL(rawExternal);
      const platform = platformFromHost(parsed.hostname);
      const externalCanonical = canonicalListingUrl(rawExternal);
      if (platform && platform !== "lun" && externalCanonical !== canonicalUrl) {
        provenance.externalSourceName = platform;
        provenance.externalSourceUrl = externalCanonical;
        const listingId = externalListingId(platform, rawExternal);
        if (listingId) {
          provenance.externalListingId = listingId;
        } else {
          notes.push("external_id_not_deterministic");
        }
        if (siteName) {
          const sitePlatform = platformFromHost(
            siteName.includes(".") ? siteName : `${siteName}.invalid`,
          );
          if (sitePlatform && sitePlatform !== platform) {
            notes.push("site_name_disagrees_with_url");
          }
        }
      }
    } catch {
      notes.push("external_url_unparseable");
    }
  }
  if (notes.length > 0) {
    provenance.notes = notes;
  }
  return provenance;
}

function olxToken(listing: ProvenanceListing): string | undefined {
  return OLX_TOKEN.exec(listing.url)?.[1] ?? metaString(listing.metadata, "urlToken");
}

function ownPlatformId(listing: ProvenanceListing): IdentityKey | undefined {
  if (listing.source === "olx") {
    const token = olxToken(listing);
    return token ? { key: `olx:token:${token}`, keyClass: "own" } : undefined;
  }
  if (listing.source === "rieltor") {
    return { key: `rieltor:id:${listing.sourceId}`, keyClass: "own" };
  }
  if (listing.source === "domria") {
    return { key: `domria:id:${listing.sourceId}`, keyClass: "own" };
  }
  return undefined;
}

export function identityKeys(listing: ProvenanceListing): IdentityKey[] {
  const provenance = readProvenance(listing);
  const keys: IdentityKey[] = [{ key: `url:${provenance.canonicalUrl}`, keyClass: "own" }];
  const ownId = ownPlatformId(listing);
  if (ownId) {
    keys.push(ownId);
  }
  if (listing.source === "lun" && provenance.groupId) {
    keys.push({ key: `lun:group:${provenance.groupId}`, keyClass: "lun_cluster" });
  }
  if (provenance.externalSourceUrl) {
    keys.push({ key: `url:${provenance.externalSourceUrl}`, keyClass: "explicit_external" });
  }
  if (provenance.externalSourceName && provenance.externalListingId) {
    const prefix =
      provenance.externalSourceName === "olx"
        ? "olx:token:"
        : provenance.externalSourceName === "rieltor"
          ? "rieltor:id:"
          : "domria:id:";
    keys.push({
      key: `${prefix}${provenance.externalListingId}`,
      keyClass: "explicit_external",
    });
  }
  const rank: Record<IdentityKeyClass, number> = { explicit_external: 3, own: 2, lun_cluster: 1 };
  const byKey = new Map<string, IdentityKey>();
  for (const item of keys) {
    const existing = byKey.get(item.key);
    if (!existing || rank[item.keyClass] > rank[existing.keyClass]) {
      byKey.set(item.key, item);
    }
  }
  return [...byKey.values()];
}
