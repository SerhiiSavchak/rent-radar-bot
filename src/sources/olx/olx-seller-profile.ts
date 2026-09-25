import {
  assessSellerProfile,
  normalizeSellerAddress,
  SELLER_PROFILE_DISTINCT_ADDRESS_MIN,
  type SellerProfileDecision,
} from "../../delivery/seller-profile.ts";

/**
 * Public OLX seller inventory from `/uk/list/user/{slug}/` or a linked shop
 * host (`https://{slug}.olx.ua/…`).
 *
 * Shop/business presence alone is not intermediary proof — the URL is only a
 * bounded place to read inventory or explicit agency evidence.
 *
 * Property identity:
 * - Precise keys need street + building/unit (or an equally specific line).
 * - Coarse keys are city+district or city+street without a building — useful as
 *   distinct *location samples*, not verified property addresses.
 * - Listing ids never count as properties. Repeated ads for one address collapse.
 * - When neither precise nor coarse distinctness can be established → unknown.
 *
 * `profile_likely_intermediary` from ≥3 precise addresses, or from ≥3 coarse
 * location samples labeled as coarse (not “verified addresses”). Delivery still
 * follows `SELLER_PROFILE_LIKELY_POLICY` (default reject).
 *
 * Threshold matches `SELLER_PROFILE_DISTINCT_ADDRESS_MIN` (3). The undeployed
 * phase-6-product-correctness ≥10 RE-ad count for native OLX is not adopted here.
 */
export const OLX_PROFILE_PROBE_BUDGET = 2;

/** Likely inventory stays cached across several poll cycles. */
export const OLX_PROFILE_LIKELY_TTL_MS = 12 * 60 * 60 * 1000;

/** Small profiles are rechecked within about one hour. */
export const OLX_PROFILE_UNKNOWN_TTL_MS = 45 * 60 * 1000;

/** Failed reads stay sendable and are not retried every cycle. */
export const OLX_PROFILE_FAILURE_TTL_MS = 60 * 60 * 1000;

/** Platform/system OLX hosts — not a seller shop storefront. */
const OLX_RESERVED_SUBDOMAINS = new Set([
  "www",
  "m",
  "blog",
  "help",
  "business",
  "dostavka",
  "safety",
  "static",
  "img",
  "api",
  "account",
  "ssl",
  "secure",
  "promo",
]);

export type OlxProfileSnapshot = {
  acquired: boolean;
  totalPages?: number;
  totalElements?: number;
  visibleAds?: number;
  realEstateAds?: number;
  /** Building-level / unit-level address keys. */
  precisePropertyKeys?: string[];
  /** City+district or city+street without building — not verified properties. */
  coarseLocationKeys?: string[];
  /**
   * @deprecated Prefer precisePropertyKeys / coarseLocationKeys.
   * Kept as the keys fed into assessSellerProfile for the likely threshold.
   */
  propertyKeys?: string[];
};

export function findOlxPublicProfilePath(html: string): string | undefined {
  const match = html.match(/\/uk\/list\/user\/[A-Za-z0-9]+\/?/);
  if (!match) {
    return undefined;
  }
  return match[0].endsWith("/") ? match[0] : `${match[0]}/`;
}

/**
 * Seller shop/home URL linked from the listing
 * (`data-testid="user-profile-link"` / `seller-link` → `https://{slug}.olx.ua/…`).
 * Used as a probe target only — not as confirmed intermediary evidence.
 */
export function findOlxSellerShopUrl(html: string): string | undefined {
  const labeled = [
    ...html.matchAll(
      /data-testid="(?:user-profile-link|seller-link)"[^>]*href="(https:\/\/[a-z0-9-]+\.olx\.ua[^"]*)"/gi,
    ),
    ...html.matchAll(
      /href="(https:\/\/[a-z0-9-]+\.olx\.ua[^"]*)"[^>]*data-testid="(?:user-profile-link|seller-link)"/gi,
    ),
  ];
  for (const match of labeled) {
    const url = match[1];
    if (!url) {
      continue;
    }
    const host = shopHost(url);
    if (host) {
      return `https://${host}.olx.ua/uk/home/`;
    }
  }
  for (const match of html.matchAll(/https:\/\/([a-z0-9-]+)\.olx\.ua\/(?:uk\/)?home\/?/gi)) {
    const host = match[1]?.toLowerCase();
    if (host && !OLX_RESERVED_SUBDOMAINS.has(host)) {
      return `https://${host}.olx.ua/uk/home/`;
    }
  }
  return undefined;
}

/** Prefer `/uk/list/user/…`, else the linked shop/home URL, as inventory probe target. */
export function resolveOlxInventoryProbeTarget(html: string | undefined): string | undefined {
  if (!html) {
    return undefined;
  }
  return findOlxPublicProfilePath(html) ?? findOlxSellerShopUrl(html);
}

function shopHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const parts = parsed.hostname.toLowerCase().split(".");
    if (parts.length < 3 || parts.slice(-2).join(".") !== "olx.ua") {
      return undefined;
    }
    const sub = parts[0];
    if (!sub || OLX_RESERVED_SUBDOMAINS.has(sub)) {
      return undefined;
    }
    return sub;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isRealEstateAd(raw: unknown): boolean {
  const category = asRecord(asRecord(raw)?.category);
  return category?.type === "real_estate";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Building / unit token: digit or Ukrainian number-like fragment on the street line. */
const BUILDING_HINT = /(?:^|\s)(?:буд\.?|будинок|стр\.?|корп\.?|№|#)?\s*\d+[а-яa-z]?/i;

export type OlxLocationKeyKind = "precise" | "coarse" | "insufficient";

export function classifyOlxLocationKey(parts: {
  city?: string;
  district?: string;
  street?: string;
}): { kind: OlxLocationKeyKind; key?: string } {
  const city = parts.city ? normalizeSellerAddress(parts.city) : undefined;
  const district = parts.district ? normalizeSellerAddress(parts.district) : undefined;
  const street = parts.street ? normalizeSellerAddress(parts.street) : undefined;
  if (!city) {
    return { kind: "insufficient" };
  }
  if (street && BUILDING_HINT.test(parts.street ?? "")) {
    const key = normalizeSellerAddress([city, district, street].filter(Boolean).join(", "));
    return key ? { kind: "precise", key } : { kind: "insufficient" };
  }
  if (district || street) {
    const key = normalizeSellerAddress([city, district, street].filter(Boolean).join(", "));
    return key ? { kind: "coarse", key } : { kind: "insufficient" };
  }
  return { kind: "insufficient" };
}

/**
 * Address/location key for one real-estate ad. Listing ids are never used.
 */
export function propertyKeyFromOlxProfileAd(raw: unknown):
  | { kind: "precise" | "coarse"; key: string }
  | undefined {
  if (!isRealEstateAd(raw)) {
    return undefined;
  }
  const ad = asRecord(raw);
  if (!ad) {
    return undefined;
  }
  const loc = asRecord(ad.location);
  const city =
    stringField(asRecord(loc?.city)?.name) ??
    stringField(loc?.cityName) ??
    stringField(loc?.city);
  const district =
    stringField(asRecord(loc?.district)?.name) ??
    stringField(loc?.districtName) ??
    stringField(loc?.district);
  const street = stringField(loc?.streetName) ?? stringField(loc?.street);
  const classified = classifyOlxLocationKey({
    ...(city ? { city } : {}),
    ...(district ? { district } : {}),
    ...(street ? { street } : {}),
  });
  if (classified.kind === "insufficient" || !classified.key) {
    return undefined;
  }
  return { kind: classified.kind, key: classified.key };
}

export function parseOlxProfileInventory(state: unknown): OlxProfileSnapshot {
  const nested = asRecord(asRecord(asRecord(state)?.userListing)?.userListing);
  const totalPages = nested?.totalPages;
  const totalElements = nested?.totalElements;
  if (typeof totalPages !== "number" || typeof totalElements !== "number") {
    return { acquired: false };
  }
  const ads = Array.isArray(nested?.ads) ? nested.ads : [];
  const realEstateAds = ads.filter((ad) => isRealEstateAd(ad));
  const precisePropertyKeys: string[] = [];
  const coarseLocationKeys: string[] = [];
  const preciseSeen = new Set<string>();
  const coarseSeen = new Set<string>();
  for (const ad of realEstateAds) {
    const key = propertyKeyFromOlxProfileAd(ad);
    if (!key) {
      continue;
    }
    if (key.kind === "precise") {
      if (!preciseSeen.has(key.key)) {
        preciseSeen.add(key.key);
        precisePropertyKeys.push(key.key);
      }
    } else if (!coarseSeen.has(key.key)) {
      coarseSeen.add(key.key);
      coarseLocationKeys.push(key.key);
    }
  }
  // assessSellerProfile still wants a flat address list: precise first, else coarse.
  const propertyKeys =
    precisePropertyKeys.length > 0 ? precisePropertyKeys : coarseLocationKeys;
  return {
    acquired: true,
    totalPages,
    totalElements,
    visibleAds: ads.length,
    realEstateAds: realEstateAds.length,
    precisePropertyKeys,
    coarseLocationKeys,
    propertyKeys,
  };
}

/** Adds a second public page onto the first. Totals stay from the first page. */
export function mergeOlxProfilePages(
  first: OlxProfileSnapshot,
  second: OlxProfileSnapshot,
): OlxProfileSnapshot {
  if (!first.acquired) {
    return second.acquired ? second : { acquired: false };
  }
  if (!second.acquired) {
    return first;
  }
  const precisePropertyKeys = [
    ...new Set([...(first.precisePropertyKeys ?? []), ...(second.precisePropertyKeys ?? [])]),
  ];
  const coarseLocationKeys = [
    ...new Set([...(first.coarseLocationKeys ?? []), ...(second.coarseLocationKeys ?? [])]),
  ];
  const propertyKeys =
    precisePropertyKeys.length > 0 ? precisePropertyKeys : coarseLocationKeys;
  return {
    acquired: true,
    ...(first.totalPages !== undefined ? { totalPages: first.totalPages } : {}),
    ...(first.totalElements !== undefined ? { totalElements: first.totalElements } : {}),
    visibleAds: (first.visibleAds ?? 0) + (second.visibleAds ?? 0),
    realEstateAds: (first.realEstateAds ?? 0) + (second.realEstateAds ?? 0),
    precisePropertyKeys,
    coarseLocationKeys,
    propertyKeys,
  };
}

export function classifyOlxProfileInventory(
  snapshot: OlxProfileSnapshot,
  now: Date = new Date(),
  distinctMin: number = SELLER_PROFILE_DISTINCT_ADDRESS_MIN,
): SellerProfileDecision {
  if (!snapshot.acquired) {
    return { verdict: "unknown", evidence: "olx_profile_unreadable" };
  }
  const precise = snapshot.precisePropertyKeys ?? [];
  const coarse = snapshot.coarseLocationKeys ?? [];
  const legacy = snapshot.propertyKeys ?? [];
  const usingPrecise = precise.length > 0;
  const keys = usingPrecise ? precise : coarse.length > 0 ? coarse : legacy;
  const coarseInference = !usingPrecise && keys.length > 0;
  const decision = assessSellerProfile({
    confirmedOwner: false,
    addresses: keys,
    now,
    distinctAddressMin: distinctMin,
  });
  const locationEvidence = usingPrecise
    ? `olx_precise_addresses=${precise.length}`
    : coarseInference
      ? `olx_coarse_locations=${keys.length};not_verified_property_addresses=1`
      : `olx_precise_addresses=0;olx_coarse_locations=0`;
  const evidence = [
    usingPrecise
      ? decision.evidence
      : decision.verdict === "profile_likely_intermediary"
        ? `distinct_coarse_locations=${keys.length}`
        : decision.evidence === "no_profile_signal"
          ? "no_profile_signal"
          : `coarse_locations=${keys.length}`,
    decision.verdict === "profile_likely_intermediary" ? "olx_likely=1" : "olx_likely=0",
    locationEvidence,
    `olx_pages=${snapshot.totalPages ?? 0}`,
    `olx_total=${snapshot.totalElements ?? 0}`,
    `olx_visible=${snapshot.visibleAds ?? 0}`,
    `olx_real_estate_count=${snapshot.realEstateAds ?? 0}`,
  ].join(";");
  return { verdict: decision.verdict, evidence };
}

export function olxProfileEvidence(snapshot: OlxProfileSnapshot, checkedAt: Date): string {
  const decision = classifyOlxProfileInventory(snapshot, checkedAt);
  const checked = `olx_checked_at=${checkedAt.toISOString()}`;
  if (decision.evidence.includes("olx_profile_unreadable")) {
    return `olx_unreadable=1;${checked}`;
  }
  return `${decision.evidence};${checked}`;
}

function token(evidence: string, name: string): string | undefined {
  const match = evidence.match(new RegExp(`(?:^|;)${name}=([^;]*)`));
  return match?.[1];
}

export function olxProfileCacheState(
  evidence: string | undefined,
  now: Date,
): "absent" | "fresh_likely" | "fresh_unknown" | "stale" {
  if (!evidence || !evidence.includes("olx_checked_at=")) {
    return "absent";
  }
  const checkedAt = Date.parse(token(evidence, "olx_checked_at") ?? "");
  if (!Number.isFinite(checkedAt)) {
    return "absent";
  }
  const age = now.getTime() - checkedAt;
  if (age < 0) {
    return "stale";
  }
  if (token(evidence, "olx_unreadable") === "1") {
    return age < OLX_PROFILE_FAILURE_TTL_MS ? "fresh_unknown" : "stale";
  }
  const likely = token(evidence, "olx_likely") === "1";
  const ttl = likely ? OLX_PROFILE_LIKELY_TTL_MS : OLX_PROFILE_UNKNOWN_TTL_MS;
  if (age >= ttl) {
    return "stale";
  }
  return likely ? "fresh_likely" : "fresh_unknown";
}
