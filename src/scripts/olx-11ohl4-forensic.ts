/**
 * Read-only forensic probe for OLX token 11ohl4.
 * No Telegram, no SQLite, no production state.
 *
 * Required: OLX_11OHL4_FORENSIC=true
 * Optional: OLX_11OHL4_MODES, OLX_11OHL4_CATEGORIES, OLX_11OHL4_PAGE_CAP
 * Default page cap is the production private cap. Raise it only to finish a
 * catalog whose declared totalPages is larger.
 */
import { chromium, type Page, type Route } from "playwright";
import { loadConfig } from "../config/env.ts";
import { classifyListingFreshness, LATE_DISCOVERY_GRACE_MINUTES } from "../delivery/listing-freshness.ts";
import { SELLER_INVENTORY_LIMIT_MIN } from "../delivery/seller-profile.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { sellerRejectionReason } from "../filters/owner-filter.ts";
import {
  extractOlxAccountRegistrationYear,
  sellerRegistrationYearRejectionReason,
} from "../sources/olx/olx-account-registration.ts";
import { inspectOlxOfferDetailHtml } from "../sources/olx/olx-browser.detail-inspect.ts";
import {
  OLX_BROWSER_APARTMENTS_PATH,
  OLX_BROWSER_HOUSES_PATH,
  OLX_PRIVATE_CATALOG_PAGE_CAP,
  buildOlxBrowserCategoryUrl,
  type OlxBrowserCategoryName,
} from "../sources/olx/olx-browser.coverage.ts";
import {
  collectOfferLikeObjects,
  extractListingAdsFromPrerenderedState,
  inspectPrerenderedState,
  normalizeEmbeddedOlxAd,
  readOlxStructuredCatalogPage,
} from "../sources/olx/olx-browser.html-extract.ts";
import { OLX_DISTANCE_KM } from "../sources/olx/olx.source.ts";
import { diagnoseOlxOfferParse, extractOlxUrlToken, parseOlxOffer } from "../sources/olx/olx.parser.ts";
import { findOlxPublicProfilePath, parseOlxProfileInventory } from "../sources/olx/olx-seller-profile.ts";

const TOKEN = "11ohl4";
const PAGE_CAP = Number(process.env.OLX_11OHL4_PAGE_CAP ?? OLX_PRIVATE_CATALOG_PAGE_CAP);
const MODES = (process.env.OLX_11OHL4_MODES ?? "private,business")
  .split(",")
  .map((item) => item.trim())
  .filter((item): item is CatalogMode => item === "private" || item === "business");
const CATEGORIES = (process.env.OLX_11OHL4_CATEGORIES ?? "apartments,houses")
  .split(",")
  .map((item) => item.trim())
  .filter((item): item is OlxBrowserCategoryName => item === "apartments" || item === "houses");

if (process.env.OLX_11OHL4_FORENSIC !== "true") {
  console.error(JSON.stringify({ ok: false, error: "Set OLX_11OHL4_FORENSIC=true" }));
  process.exit(2);
}

type CatalogMode = "private" | "business";

type RawHit = {
  category: OlxBrowserCategoryName;
  page: number;
  indexOnPage: number;
  sourceId?: string;
  token?: string;
  url?: string;
  title?: string;
  createdTime?: string;
  lastRefreshTime?: string;
  isBusiness?: boolean;
  sellerType?: string | null;
  sellerName?: string;
  companyName?: string;
  cityName?: string;
  districtName?: string;
  price?: unknown;
  categoryId?: unknown;
  userId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function catalogUrl(mode: CatalogMode, category: OlxBrowserCategoryName, page: number): string {
  if (mode === "private") {
    return buildOlxBrowserCategoryUrl(category, { page });
  }
  const path = category === "apartments" ? OLX_BROWSER_APARTMENTS_PATH : OLX_BROWSER_HOUSES_PATH;
  const params = new URLSearchParams();
  params.set("search[dist]", String(OLX_DISTANCE_KM));
  params.set("search[private_business]", "business");
  if (page > 1) {
    params.set("page", String(page));
  }
  return `https://www.olx.ua${path}?${params.toString()}`;
}

function rawId(ad: Record<string, unknown>): string | undefined {
  const id = ad.id;
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  if (typeof id === "string" && id.trim()) {
    return id.trim();
  }
  return undefined;
}

function rawUrl(ad: Record<string, unknown>): string | undefined {
  const url = textOf(ad.url);
  if (url && /^https?:\/\//i.test(url)) {
    return url;
  }
  const path = textOf(ad.urlPath) ?? (url?.startsWith("/") ? url : undefined);
  return path ? `https://www.olx.ua${path}` : url;
}

function tokenOf(url: string | undefined): string | undefined {
  return url ? extractOlxUrlToken(url) : undefined;
}

function sameToken(value: string | undefined): boolean {
  return value?.toLowerCase() === TOKEN;
}

function titleNearTarget(title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  const lower = title.toLowerCase();
  return lower.includes("власник") && lower.includes("тривал");
}

function hitFromAd(
  category: OlxBrowserCategoryName,
  page: number,
  indexOnPage: number,
  raw: unknown,
): RawHit | undefined {
  const ad = asRecord(raw);
  if (!ad) {
    return undefined;
  }
  const url = rawUrl(ad);
  const token = tokenOf(url);
  const title = textOf(ad.title);
  const sourceId = rawId(ad);
  if (!sameToken(token) && !titleNearTarget(title)) {
    return undefined;
  }
  const user = asRecord(ad.user);
  const location = asRecord(ad.location);
  const business =
    typeof ad.isBusiness === "boolean"
      ? ad.isBusiness
      : typeof ad.business === "boolean"
        ? ad.business
        : undefined;
  const sellerType =
    user && "sellerType" in user ? (textOf(user.sellerType) ?? null) : undefined;
  const createdTime = textOf(ad.createdTime) ?? textOf(ad.created_time);
  const lastRefreshTime = textOf(ad.lastRefreshTime) ?? textOf(ad.last_refresh_time);
  const sellerName = textOf(user?.name);
  const companyName = textOf(user?.company_name);
  const cityName = textOf(location?.cityName);
  const districtName = textOf(location?.districtName);
  return {
    category,
    page,
    indexOnPage,
    ...(sourceId ? { sourceId } : {}),
    ...(token ? { token } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(createdTime ? { createdTime } : {}),
    ...(lastRefreshTime ? { lastRefreshTime } : {}),
    ...(business !== undefined ? { isBusiness: business } : {}),
    ...(sellerType !== undefined ? { sellerType } : {}),
    ...(sellerName ? { sellerName } : {}),
    ...(companyName ? { companyName } : {}),
    ...(cityName ? { cityName } : {}),
    ...(districtName ? { districtName } : {}),
    ...(ad.price !== undefined ? { price: ad.price } : {}),
    ...(ad.category !== undefined ? { categoryId: asRecord(ad.category)?.id ?? ad.category } : {}),
    ...(user?.id !== undefined ? { userId: String(user.id) } : {}),
  };
}

async function continueDocumentOnly(route: Route): Promise<void> {
  if (route.request().resourceType() === "document") {
    await route.continue();
    return;
  }
  await route.abort();
}

async function readDocument(
  page: Page,
  url: string,
): Promise<{ status: number; finalUrl: string; html: string; input: "main_document" | "rendered_dom"; tokenInHtml: boolean }> {
  const response = await page.goto(url, { waitUntil: "commit", timeout: 45_000 });
  let html = (await response?.text()) ?? "";
  let input: "main_document" | "rendered_dom" = "main_document";
  const state = inspectPrerenderedState(html);
  if (!state.decoded) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    html = await page.content();
    input = "rendered_dom";
  }
  return {
    status: response?.status() ?? 0,
    finalUrl: page.url(),
    html,
    input,
    tokenInHtml: html.toLowerCase().includes(TOKEN),
  };
}

async function walkCatalog(page: Page, mode: CatalogMode, category: OlxBrowserCategoryName) {
  const pages: number[] = [];
  const hits: RawHit[] = [];
  const failures: string[] = [];
  let totalPages: number | null = null;
  let totalElements: number | null = null;
  let adsSeen = 0;
  let tokenStringPages = 0;
  const sourceIds: string[] = [];
  const tokens: string[] = [];
  let input: "main_document" | "rendered_dom" | "mixed" = "main_document";
  const firstUrl = catalogUrl(mode, category, 1);
  for (let pageNumber = 1; pageNumber <= PAGE_CAP; pageNumber += 1) {
    if (totalPages !== null && pageNumber > totalPages) {
      break;
    }
    const url = catalogUrl(mode, category, pageNumber);
    console.error(`walk ${mode} ${category} page ${pageNumber}`);
    let loaded: Awaited<ReturnType<typeof readDocument>>;
    try {
      loaded = await readDocument(page, url);
    } catch (error) {
      failures.push(
        `page ${pageNumber}: ${error instanceof Error ? error.message : "navigation_failed"}`.slice(0, 240),
      );
      break;
    }
    if (loaded.tokenInHtml) {
      tokenStringPages += 1;
    }
    if (loaded.input === "rendered_dom") {
      input = pages.length === 0 ? "rendered_dom" : "mixed";
    }
    const state = inspectPrerenderedState(loaded.html);
    const structured = state.decoded ? readOlxStructuredCatalogPage(state.decoded) : undefined;
    if (!structured || !state.complete) {
      failures.push(
        `page ${pageNumber}: status=${loaded.status} structured=${structured ? "yes" : "no"} complete=${state.complete} input=${loaded.input}`,
      );
      break;
    }
    if (structured.pageNumber !== pageNumber) {
      failures.push(`page ${pageNumber}: structured pageNumber=${structured.pageNumber}`);
      break;
    }
    totalPages = structured.totalPages;
    totalElements = structured.totalElements;
    pages.push(pageNumber);
    const ads = state.decoded ? extractListingAdsFromPrerenderedState(state.decoded) : [];
    adsSeen += ads.length;
    for (const [indexOnPage, ad] of ads.entries()) {
      const record = asRecord(ad);
      const id = record ? rawId(record) : undefined;
      const token = record ? tokenOf(rawUrl(record)) : undefined;
      if (id) {
        sourceIds.push(id);
      }
      if (token) {
        tokens.push(token);
      }
      const hit = hitFromAd(category, pageNumber, indexOnPage, ad);
      if (hit) {
        hits.push(hit);
      }
    }
  }
  const capped = totalPages !== null && totalPages > PAGE_CAP;
  const complete = failures.length === 0 && totalPages !== null && pages.length === Math.min(totalPages, PAGE_CAP) && !capped;
  return {
    mode,
    category,
    queryUrl: firstUrl,
    privateBusiness: mode,
    distanceKm: OLX_DISTANCE_KM,
    pages,
    totalPages,
    totalElements,
    adsSeen,
    sourceIds,
    tokens,
    tokenStringPages,
    input,
    failures,
    pageCap: PAGE_CAP,
    coverage: complete ? "complete" : "incomplete",
    hits,
  };
}

function detailCandidates(foundUrl: string | undefined): string[] {
  const guesses = [
    "https://www.olx.ua/d/uk/obyavlenie/ID11ohl4.html",
    "https://www.olx.ua/d/obyavlenie/ID11ohl4.html",
  ];
  return foundUrl ? [foundUrl, ...guesses.filter((url) => url !== foundUrl)] : guesses;
}

function offerRecord(state: unknown, sourceId: string | undefined, url: string): Record<string, unknown> | undefined {
  const candidates = [
    ...extractListingAdsFromPrerenderedState(state),
    ...collectOfferLikeObjects(state, 200),
  ];
  for (const raw of candidates) {
    const ad = asRecord(raw);
    if (!ad) {
      continue;
    }
    const id = rawId(ad);
    const token = tokenOf(rawUrl(ad)) ?? tokenOf(url);
    if ((sourceId !== undefined && id === sourceId) || sameToken(token)) {
      return ad;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "uk-UA" });
  const page = await context.newPage();
  await page.route("**/*", continueDocumentOnly);
  try {
    const catalogs = [];
    for (const mode of MODES) {
      for (const category of CATEGORIES) {
        catalogs.push(await walkCatalog(page, mode, category));
      }
    }
    const exactHits = catalogs.flatMap((catalog) =>
      catalog.hits.filter((hit) => sameToken(hit.token)),
    );
    const foundUrl = exactHits.find((hit) => hit.url)?.url;
    const sourceId = exactHits.find((hit) => hit.sourceId)?.sourceId;
    const detailAttempts = [];
    let detailHtml = "";
    let detailFinalUrl = "";
    let detailStatus = 0;
    for (const url of detailCandidates(foundUrl)) {
      try {
        const loaded = await readDocument(page, url);
        detailAttempts.push({
          url,
          status: loaded.status,
          finalUrl: loaded.finalUrl,
          input: loaded.input,
          prerendered: inspectPrerenderedState(loaded.html).present,
          tokenInHtml: loaded.tokenInHtml,
          tokenInFinalUrl: loaded.finalUrl.toLowerCase().includes(TOKEN),
        });
        detailHtml = loaded.html;
        detailFinalUrl = loaded.finalUrl;
        detailStatus = loaded.status;
        const state = inspectPrerenderedState(loaded.html);
        if (state.decoded && offerRecord(state.decoded, sourceId, loaded.finalUrl)) {
          break;
        }
      } catch (error) {
        detailAttempts.push({
          url,
          error: error instanceof Error ? error.message.slice(0, 240) : "navigation_failed",
        });
      }
    }
    const detailState = inspectPrerenderedState(detailHtml);
    const rawOffer = detailState.decoded
      ? offerRecord(detailState.decoded, sourceId, detailFinalUrl)
      : undefined;
    const resolvedSourceId = sourceId ?? (rawOffer ? rawId(rawOffer) : undefined);
    const platformInspection = detailHtml && resolvedSourceId
      ? inspectOlxOfferDetailHtml(detailHtml, resolvedSourceId)
      : undefined;
    const registrationYear = detailHtml ? extractOlxAccountRegistrationYear(detailHtml) : undefined;
    const profilePath = detailHtml ? findOlxPublicProfilePath(detailHtml) : undefined;
    let profile: Record<string, unknown> | undefined;
    if (profilePath) {
      try {
        const loaded = await readDocument(page, `https://www.olx.ua${profilePath}`);
        const state = inspectPrerenderedState(loaded.html);
        const snapshot = state.decoded ? parseOlxProfileInventory(state.decoded) : undefined;
        profile = {
          path: profilePath,
          status: loaded.status,
          finalUrl: loaded.finalUrl,
          ...(snapshot
            ? {
                acquired: snapshot.acquired,
                totalPages: snapshot.totalPages ?? null,
                totalElements: snapshot.totalElements ?? null,
                realEstateAds: snapshot.realEstateAds ?? null,
                preciseProperties: snapshot.precisePropertyKeys?.length ?? null,
                coarseLocations: snapshot.coarseLocationKeys?.length ?? null,
                pagesFetched: snapshot.pagesFetched ?? null,
              }
            : { acquired: false }),
        };
      } catch (error) {
        profile = {
          path: profilePath,
          error: error instanceof Error ? error.message.slice(0, 240) : "navigation_failed",
        };
      }
    }
    const normalizedRaw = rawOffer ? normalizeEmbeddedOlxAd(rawOffer) : undefined;
    const parsed = normalizedRaw ? parseOlxOffer(normalizedRaw) : undefined;
    const parseFailure = normalizedRaw && !parsed ? diagnoseOlxOfferParse(normalizedRaw) : undefined;
    const config = loadConfig({
      SELLER_POLICY: "reject_intermediaries",
      GEO_UNKNOWN_POLICY: "exclude",
      TARGET_RADIUS_KM: "15",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      PROPERTY_TYPES: "apartment,house",
      ENABLE_OLX_BROWSER: "true",
      ENABLE_OLX: "false",
      ENABLE_RIELTOR: "false",
    });
    const filtered = parsed ? applyListingFilters([parsed], config)[0] : undefined;
    const now = new Date();
    const freshnessNow = parsed?.publishedAt
      ? classifyListingFreshness(parsed, {
          maxPublicationAgeMinutes: 7 * 24 * 60,
          strictNewPublications: true,
          lateDiscoveryGraceMinutes: LATE_DISCOVERY_GRACE_MINUTES,
          now,
          monitoringStartedAt: new Date(now.getTime() - 10 * 60_000),
        })
      : undefined;
    const yearReject = sellerRegistrationYearRejectionReason(registrationYear);
    console.log(
      JSON.stringify(
        {
          token: TOKEN,
          investigatedAt: now.toISOString(),
          resolvedSourceId: resolvedSourceId ?? null,
          idMembership: catalogs.map((catalog) => ({
            mode: catalog.mode,
            category: catalog.category,
            coverage: catalog.coverage,
            pages: catalog.pages,
            totalPages: catalog.totalPages,
            totalElements: catalog.totalElements,
            adsSeen: catalog.adsSeen,
            tokenStringPages: catalog.tokenStringPages,
            tokenInAdUrls: catalog.tokens.some((item) => item.toLowerCase() === TOKEN),
            sourceIdInAds: resolvedSourceId ? catalog.sourceIds.includes(resolvedSourceId) : null,
          })),
          catalogs,
          exactHitCount: exactHits.length,
          detail: {
            attempts: detailAttempts,
            status: detailStatus,
            finalUrl: detailFinalUrl,
            offerFound: Boolean(rawOffer),
            platformInspection: platformInspection
              ? {
                  offerRecordFound: platformInspection.offerRecordFound,
                  matchedExpectedId: platformInspection.matchedExpectedId,
                  sourceId: platformInspection.sourceId ?? null,
                  url: platformInspection.url ?? null,
                  title: platformInspection.title ?? null,
                  sellerTypeField: platformInspection.sellerTypeField,
                  isBusinessField: platformInspection.isBusinessField,
                  companyNameField: platformInspection.companyNameField,
                  platformLabel: platformInspection.platformLabel,
                  accountType: platformInspection.accountType,
                  ownerEvidenceLevel: platformInspection.ownerEvidenceLevel,
                  sellerAuthoredSelfDeclared: platformInspection.sellerAuthoredSelfDeclared,
                  defaultOwnerGateWouldAccept: platformInspection.defaultOwnerGateWouldAccept,
                  notes: platformInspection.notes,
                }
              : null,
            registrationYear: registrationYear ?? null,
            yearReject: yearReject ?? null,
            profile: profile ?? null,
            raw: rawOffer
              ? {
                  sourceId: rawId(rawOffer) ?? null,
                  token: tokenOf(rawUrl(rawOffer)) ?? tokenOf(detailFinalUrl) ?? null,
                  url: rawUrl(rawOffer) ?? detailFinalUrl,
                  title: textOf(rawOffer.title) ?? null,
                  createdTime: textOf(rawOffer.createdTime) ?? textOf(rawOffer.created_time) ?? null,
                  lastRefreshTime:
                    textOf(rawOffer.lastRefreshTime) ?? textOf(rawOffer.last_refresh_time) ?? null,
                  isBusiness:
                    typeof rawOffer.isBusiness === "boolean"
                      ? rawOffer.isBusiness
                      : typeof rawOffer.business === "boolean"
                        ? rawOffer.business
                        : null,
                  sellerType: textOf(asRecord(rawOffer.user)?.sellerType) ?? null,
                  sellerName: textOf(asRecord(rawOffer.user)?.name) ?? null,
                  companyName: textOf(asRecord(rawOffer.user)?.company_name) ?? null,
                  cityName: textOf(asRecord(rawOffer.location)?.cityName) ?? null,
                  status: textOf(rawOffer.status) ?? null,
                }
              : null,
          },
          parser: parsed
            ? {
                sourceId: parsed.sourceId,
                url: parsed.url,
                title: parsed.title,
                propertyType: parsed.propertyType,
                city: parsed.location.city ?? null,
                latitude: parsed.location.latitude ?? null,
                longitude: parsed.location.longitude ?? null,
                publishedAt: parsed.publishedAt?.toISOString() ?? null,
                refreshedAt: parsed.refreshedAt?.toISOString() ?? null,
                sellerType: parsed.sellerType,
                ownerEvidenceLevel: parsed.metadata?.ownerEvidenceLevel ?? null,
                olxIsBusiness: parsed.metadata?.olxIsBusiness ?? null,
                urlToken: parsed.metadata?.urlToken ?? null,
              }
            : null,
          parseFailure: parseFailure ?? null,
          filters: filtered
            ? {
                accepted: filtered.accepted,
                locationMatched: filtered.locationMatched,
                locationReason: filtered.locationReason,
                distanceKm: filtered.distanceKm ?? null,
                sellerEligible: filtered.sellerEligible,
                sellerRejectionReason: filtered.sellerRejectionReason ?? (parsed ? sellerRejectionReason(parsed) : null) ?? null,
                propertyMatched: filtered.propertyMatched,
              }
            : null,
          freshnessIfBoundaryIsTenMinutesAgo: freshnessNow
            ? { kind: freshnessNow.kind, deliverable: freshnessNow.deliverable, reason: freshnessNow.reason }
            : null,
          inventoryLimitMin: SELLER_INVENTORY_LIMIT_MIN,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message.slice(0, 500) }));
  process.exit(1);
});
