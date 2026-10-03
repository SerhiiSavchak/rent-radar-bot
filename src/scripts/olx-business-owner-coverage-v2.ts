/**
 * Read-only Private vs Business OLX coverage audit.
 * Does not write SQLite, Telegram, or production state.
 *
 * Required: OLX_BUSINESS_COVERAGE_AUDIT=true
 * Optional: OLX_BUSINESS_COVERAGE_PAGE_CAP (default 40)
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page, type Route } from "playwright";
import { loadConfig } from "../config/env.ts";
import { classifyListingFreshness, LATE_DISCOVERY_GRACE_MINUTES } from "../delivery/listing-freshness.ts";
import { SELLER_INVENTORY_LIMIT_MIN } from "../delivery/seller-profile.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { classifyOwner, sellerRejectionReason } from "../filters/owner-filter.ts";
import { extractOlxAccountRegistrationYear } from "../sources/olx/olx-account-registration.ts";
import {
  OLX_BROWSER_APARTMENTS_PATH,
  OLX_BROWSER_HOUSES_PATH,
  buildOlxBrowserCategoryUrl,
  type OlxBrowserCategoryName,
} from "../sources/olx/olx-browser.coverage.ts";
import { inspectOlxOfferDetailHtml } from "../sources/olx/olx-browser.detail-inspect.ts";
import {
  collectOfferLikeObjects,
  extractListingAdsFromPrerenderedState,
  inspectPrerenderedState,
  normalizeEmbeddedOlxAd,
  readOlxStructuredCatalogPage,
} from "../sources/olx/olx-browser.html-extract.ts";
import { OLX_DISTANCE_KM } from "../sources/olx/olx.source.ts";
import { diagnoseOlxOfferParse, extractOlxUrlToken, parseOlxOffer } from "../sources/olx/olx.parser.ts";
import {
  findOlxPublicProfilePath,
  parseOlxProfileInventory,
  resolveOlxInventoryProbeTarget,
} from "../sources/olx/olx-seller-profile.ts";
import {
  classifyBusinessCoverageEvidence,
  crosscheckIdentities,
  hasPositiveOwnerSignal,
  type AuditOutcome,
} from "./olx-business-coverage-evidence.ts";

const PAGE_CAP = Math.max(1, Number(process.env.OLX_BUSINESS_COVERAGE_PAGE_CAP ?? "40") || 40);
const MODES = (process.env.OLX_BUSINESS_COVERAGE_MODES ?? "private,business")
  .split(",")
  .map((item) => item.trim())
  .filter((item): item is Mode => item === "private" || item === "business");
const CATEGORIES = (process.env.OLX_BUSINESS_COVERAGE_CATEGORIES ?? "apartments,houses")
  .split(",")
  .map((item) => item.trim())
  .filter((item): item is OlxBrowserCategoryName => item === "apartments" || item === "houses");
const OUT = process.env.OLX_BUSINESS_COVERAGE_OUT ?? join(tmpdir(), "olx-business-coverage-v2.json");

if (process.env.OLX_BUSINESS_COVERAGE_AUDIT !== "true") {
  console.error(JSON.stringify({ ok: false, error: "Set OLX_BUSINESS_COVERAGE_AUDIT=true" }));
  process.exit(2);
}

type Mode = "private" | "business";

type CatalogRow = {
  mode: Mode;
  category: OlxBrowserCategoryName;
  page: number;
  sourceId: string;
  token?: string;
  url?: string;
  title?: string;
  createdTime?: string;
  lastRefreshTime?: string;
  isBusiness?: boolean;
  sellerType?: string | null;
  sellerName?: string;
  companyName?: string;
  description?: string;
  city?: string;
  district?: string;
  latitude?: number;
  longitude?: number;
  categoryId?: number;
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

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function catalogUrl(mode: Mode, category: OlxBrowserCategoryName, page: number): string {
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

function rowFromAd(mode: Mode, category: OlxBrowserCategoryName, page: number, raw: unknown): CatalogRow | undefined {
  const ad = asRecord(raw);
  if (!ad) {
    return undefined;
  }
  const id = ad.id;
  const sourceId =
    typeof id === "number" && Number.isFinite(id)
      ? String(id)
      : typeof id === "string" && id.trim()
        ? id.trim()
        : undefined;
  if (!sourceId) {
    return undefined;
  }
  const user = asRecord(ad.user);
  const location = asRecord(ad.location);
  const map = asRecord(ad.map);
  const url = textOf(ad.url) ?? (typeof ad.urlPath === "string" ? `https://www.olx.ua${ad.urlPath}` : undefined);
  const token = url ? extractOlxUrlToken(url) : undefined;
  const business =
    typeof ad.isBusiness === "boolean" ? ad.isBusiness : typeof ad.business === "boolean" ? ad.business : undefined;
  const sellerType = user && "sellerType" in user ? (textOf(user.sellerType) ?? null) : undefined;
  const categoryId = numberOf(asRecord(ad.category)?.id);
  const latitude = numberOf(map?.lat);
  const longitude = numberOf(map?.lon);
  const title = textOf(ad.title);
  const createdTime = textOf(ad.createdTime) ?? textOf(ad.created_time);
  const lastRefreshTime = textOf(ad.lastRefreshTime) ?? textOf(ad.last_refresh_time);
  const sellerName = textOf(user?.name);
  const companyName = textOf(user?.company_name);
  const description = textOf(ad.description);
  const city = textOf(location?.cityName);
  const district = textOf(location?.districtName);
  return {
    mode,
    category,
    page,
    sourceId,
    ...(token ? { token } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(createdTime ? { createdTime } : {}),
    ...(lastRefreshTime ? { lastRefreshTime } : {}),
    ...(business !== undefined ? { isBusiness: business } : {}),
    ...(sellerType !== undefined ? { sellerType } : {}),
    ...(sellerName ? { sellerName } : {}),
    ...(companyName ? { companyName } : {}),
    ...(description ? { description } : {}),
    ...(city ? { city } : {}),
    ...(district ? { district } : {}),
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
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

async function readDocument(page: Page, url: string): Promise<{ status: number; html: string; finalUrl: string }> {
  const response = await page.goto(url, { waitUntil: "commit", timeout: 45_000 });
  let html = (await response?.text()) ?? "";
  if (!inspectPrerenderedState(html).decoded) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    html = await page.content();
  }
  return { status: response?.status() ?? 0, html, finalUrl: page.url() };
}

async function walk(page: Page, mode: Mode, category: OlxBrowserCategoryName) {
  const started = Date.now();
  const rows: CatalogRow[] = [];
  const seen = new Set<string>();
  const pages: number[] = [];
  const failures: string[] = [];
  let totalPages: number | null = null;
  let totalElements: number | null = null;
  let rawAds = 0;
  const tokens = new Set<string>();
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
    const state = inspectPrerenderedState(loaded.html);
    const structured = state.decoded ? readOlxStructuredCatalogPage(state.decoded) : undefined;
    if (!structured || !state.complete || !state.decoded) {
      failures.push(
        `page ${pageNumber}: status=${loaded.status} structured=${structured ? "yes" : "no"} complete=${state.complete}`,
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
    const ads = extractListingAdsFromPrerenderedState(state.decoded);
    rawAds += ads.length;
    for (const ad of ads) {
      const row = rowFromAd(mode, category, pageNumber, ad);
      if (!row || seen.has(row.sourceId)) {
        continue;
      }
      seen.add(row.sourceId);
      if (row.token) {
        tokens.add(row.token.toLowerCase());
      }
      rows.push(row);
    }
  }
  const capped = totalPages !== null && totalPages > PAGE_CAP;
  const complete =
    failures.length === 0 && totalPages !== null && pages.length === Math.min(totalPages, PAGE_CAP) && !capped;
  return {
    mode,
    category,
    queryUrl: catalogUrl(mode, category, 1),
    pagesDeclared: totalPages,
    pagesFetched: pages,
    totalElements,
    rawAds,
    uniqueIds: rows.length,
    uniqueTokens: tokens.size,
    failures,
    coverage: complete ? "complete" : "incomplete",
    elapsedMs: Date.now() - started,
    rows,
  };
}

function publicText(row: CatalogRow, description?: string): string {
  return [row.title, description ?? row.description, row.sellerName, row.companyName].filter(Boolean).join("\n");
}

function offerById(state: unknown, sourceId: string): Record<string, unknown> | undefined {
  for (const raw of collectOfferLikeObjects(state, 200)) {
    const ad = asRecord(raw);
    if (ad && String(ad.id ?? "") === sourceId) {
      return ad;
    }
  }
  return undefined;
}

type Evaluated = CatalogRow & {
  parseFailure?: string;
  propertyMatched?: boolean;
  geoReason?: string;
  distanceKm?: number | null;
  freshnessKind?: string;
  freshnessDeliverable?: boolean;
  ageHours?: number | null;
  catalogOutcome: AuditOutcome;
  catalogReasons: string[];
  positiveOwner: boolean;
};

function evaluate(row: CatalogRow, now: Date): Evaluated {
  const text = publicText(row);
  const catalog = classifyBusinessCoverageEvidence({
    text,
    ...(row.sellerType !== undefined ? { sellerType: row.sellerType } : {}),
    ...(row.companyName ? { companyName: row.companyName } : {}),
    ...(row.sellerName ? { sellerName: row.sellerName } : {}),
  });
  const normalized = normalizeEmbeddedOlxAd(rowToRaw(row));
  const listing = parseOlxOffer(normalized, now);
  if (!listing) {
    return {
      ...row,
      parseFailure: diagnoseOlxOfferParse(normalized, now),
      catalogOutcome: catalog.outcome,
      catalogReasons: catalog.reasons,
      positiveOwner: hasPositiveOwnerSignal({
        text,
        ...(row.sellerType !== undefined ? { sellerType: row.sellerType } : {}),
      }),
    };
  }
  const config = loadConfig({
    SELLER_POLICY: "reject_intermediaries",
    GEO_UNKNOWN_POLICY: "exclude",
    TARGET_RADIUS_KM: "15",
    TARGET_LAT: "49.8397",
    TARGET_LNG: "24.0297",
    PROPERTY_TYPES: "apartment,house",
  });
  const filtered = applyListingFilters([listing], config)[0];
  const freshness = classifyListingFreshness(listing, {
    maxPublicationAgeMinutes: 7 * 24 * 60,
    strictNewPublications: true,
    lateDiscoveryGraceMinutes: LATE_DISCOVERY_GRACE_MINUTES,
    now,
    monitoringStartedAt: new Date(now.getTime() - 10 * 60_000),
  });
  const ageHours = listing.publishedAt ? (now.getTime() - listing.publishedAt.getTime()) / 3_600_000 : null;
  return {
    ...row,
    propertyMatched: filtered?.propertyMatched === true,
    ...(filtered ? { geoReason: filtered.locationReason, distanceKm: filtered.distanceKm ?? null } : {}),
    freshnessKind: freshness.kind,
    freshnessDeliverable: freshness.deliverable,
    ageHours,
    catalogOutcome: catalog.outcome,
    catalogReasons: catalog.reasons,
    positiveOwner: hasPositiveOwnerSignal({
      text,
      ...(row.sellerType !== undefined ? { sellerType: row.sellerType } : {}),
    }),
  };
}

function rowToRaw(row: CatalogRow): Record<string, unknown> {
  return {
    id: Number(row.sourceId),
    ...(row.title ? { title: row.title } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.createdTime ? { createdTime: row.createdTime } : {}),
    ...(row.lastRefreshTime ? { lastRefreshTime: row.lastRefreshTime } : {}),
    ...(row.isBusiness !== undefined ? { isBusiness: row.isBusiness } : {}),
    ...(row.categoryId !== undefined ? { category: { id: row.categoryId } } : {}),
    ...(row.city || row.latitude !== undefined
      ? {
          location: {
            ...(row.city ? { cityName: row.city } : {}),
            ...(row.district ? { districtName: row.district } : {}),
          },
          ...(row.latitude !== undefined && row.longitude !== undefined
            ? { map: { lat: row.latitude, lon: row.longitude } }
            : {}),
        }
      : {}),
    user: {
      ...(row.userId ? { id: Number(row.userId) || row.userId } : {}),
      ...(row.sellerName ? { name: row.sellerName } : {}),
      company_name: row.companyName ?? null,
      sellerType: row.sellerType ?? null,
    },
  };
}

function productionClassifier(row: CatalogRow, text: string, accountBusiness: boolean) {
  const sellerType = row.sellerType?.toLowerCase();
  const owner = classifyOwner({
    platformOwner: sellerType === "owner",
    platformAgent: sellerType === "agent" || sellerType === "agency" || sellerType === "intermediary",
    platformBusiness: sellerType === "business" || accountBusiness,
    isBusiness: accountBusiness,
    ...(row.companyName ? { agencyName: row.companyName } : {}),
    ...(row.sellerName ? { sellerIdentityName: row.sellerName } : {}),
    text,
  });
  return {
    sellerType: owner.sellerType,
    ownerEvidenceLevel: owner.ownerEvidenceLevel,
    rejection:
      sellerRejectionReason({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      }) ?? null,
  };
}

async function main(): Promise<void> {
  const now = new Date();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "uk-UA" });
  const page = await context.newPage();
  await page.route("**/*", continueDocumentOnly);
  try {
    const walks = [];
    for (const mode of MODES) {
      for (const category of CATEGORIES) {
        walks.push(await walk(page, mode, category));
      }
    }
    const privateRows = walks.filter((item) => item.mode === "private").flatMap((item) => item.rows);
    const businessRows = walks.filter((item) => item.mode === "business").flatMap((item) => item.rows);
    const overlap = crosscheckIdentities(privateRows, businessRows);
    const privateIdSet = new Set(privateRows.map((row) => row.sourceId));
    const businessOnly = businessRows.filter((row) => !privateIdSet.has(row.sourceId));
    const evaluated = businessOnly.map((row) => evaluate(row, now));
    const ownerTargets = evaluated.filter((row) => row.positiveOwner);
    const freshTargets = evaluated.filter(
      (row) =>
        row.propertyMatched === true &&
        (row.ageHours ?? Number.POSITIVE_INFINITY) <= 24 &&
        (row.geoReason === "within-radius" || row.geoReason === "no-coordinates") &&
        row.catalogOutcome !== "CONFIRMED_INTERMEDIARY" &&
        row.catalogOutcome !== "LIKELY_INTERMEDIARY",
    );
    const intermediaries = evaluated.filter((row) => row.catalogOutcome === "CONFIRMED_INTERMEDIARY");
    const control: Evaluated[] = [];
    const usedUsers = new Set<string>();
    const usedPages = new Set<string>();
    for (const row of intermediaries) {
      const user = row.userId ?? row.sourceId;
      const pageKey = `${row.category}:${row.page}`;
      if (usedUsers.has(user) || usedPages.has(pageKey)) {
        continue;
      }
      usedUsers.add(user);
      usedPages.add(pageKey);
      control.push(row);
    }
    for (const row of intermediaries) {
      if (control.length >= 24) {
        break;
      }
      const user = row.userId ?? row.sourceId;
      if (usedUsers.has(user)) {
        continue;
      }
      usedUsers.add(user);
      control.push(row);
    }
    control.splice(24);
    const detailIds = new Set<string>([
      ...ownerTargets.map((row) => row.sourceId),
      ...freshTargets.map((row) => row.sourceId),
      ...control.map((row) => row.sourceId),
    ]);
    const details = new Map<string, Record<string, unknown>>();
    const profiles = new Map<string, { precise: number | null; visible: number | null; totalPages: number | null }>();
    let detailIndex = 0;
    for (const row of evaluated) {
      if (!detailIds.has(row.sourceId) || !row.url) {
        continue;
      }
      detailIndex += 1;
      console.error(`detail ${detailIndex}/${detailIds.size} ${row.sourceId}`);
      let html = "";
      let status = 0;
      try {
        const loaded = await readDocument(page, row.url);
        html = loaded.html;
        status = loaded.status;
      } catch (error) {
        details.set(row.sourceId, {
          detailStatus: 0,
          error: error instanceof Error ? error.message.slice(0, 180) : "detail_failed",
        });
        continue;
      }
      const state = inspectPrerenderedState(html).decoded;
      const offer = state ? offerById(state, row.sourceId) : undefined;
      const inspection = inspectOlxOfferDetailHtml(html, row.sourceId);
      const description =
        (typeof offer?.description === "string" ? offer.description : undefined) ?? row.description;
      const year = extractOlxAccountRegistrationYear(html);
      const probe = resolveOlxInventoryProbeTarget(html);
      let precise: number | null = null;
      let visible: number | null = null;
      let profilePages: number | null = null;
      if (probe) {
        const cached = profiles.get(probe);
        if (cached) {
          precise = cached.precise;
          visible = cached.visible;
          profilePages = cached.totalPages;
        } else {
          try {
            const profile = await readDocument(page, new URL(probe, "https://www.olx.ua").toString());
            const snapshot = parseOlxProfileInventory(inspectPrerenderedState(profile.html).decoded);
            precise = snapshot.precisePropertyKeys?.length ?? null;
            visible = snapshot.visibleAds ?? snapshot.realEstateAds ?? null;
            profilePages = snapshot.totalPages ?? null;
            profiles.set(probe, { precise, visible, totalPages: profilePages });
          } catch {
            profiles.set(probe, { precise: null, visible: null, totalPages: null });
          }
        }
      }
      const text = publicText(row, description);
      const detailSellerType = inspection.sellerTypeField.present
        ? inspection.sellerTypeField.value
        : row.sellerType;
      const detailCompany = inspection.companyNameField.present
        ? (inspection.companyNameField.value ?? undefined)
        : row.companyName;
      const judged = classifyBusinessCoverageEvidence({
        text,
        ...(detailSellerType !== undefined ? { sellerType: detailSellerType } : {}),
        ...(detailCompany ? { companyName: detailCompany } : {}),
        ...(row.sellerName ? { sellerName: row.sellerName } : {}),
        ...(year !== undefined ? { registrationYear: year } : {}),
        ...(precise !== null ? { preciseProperties: precise } : {}),
      });
      const current = productionClassifier(row, text, inspection.accountType === "business" || row.isBusiness === true);
      const withoutAccountFlag = productionClassifier(
        {
          ...row,
          ...(detailSellerType !== undefined ? { sellerType: detailSellerType } : {}),
          ...(detailCompany ? { companyName: detailCompany } : {}),
        },
        text,
        false,
      );
      details.set(row.sourceId, {
        detailStatus: status,
        title: row.title ?? inspection.title ?? null,
        createdTime: row.createdTime ?? null,
        category: row.category,
        city: row.city ?? null,
        district: row.district ?? null,
        isBusiness: row.isBusiness ?? null,
        sellerType: inspection.sellerTypeField,
        accountType: inspection.accountType,
        registrationYear: year ?? null,
        profilePath: probe ?? findOlxPublicProfilePath(html) ?? null,
        preciseProperties: precise,
        visibleInventory: visible,
        profilePages,
        inventoryLimitMin: SELLER_INVENTORY_LIMIT_MIN,
        auditOutcome: judged.outcome,
        auditReasons: judged.reasons,
        currentClassifier: current,
        classifierIgnoringAccountFlag: withoutAccountFlag,
        positiveOwner: hasPositiveOwnerSignal({
          text,
          ...(detailSellerType !== undefined ? { sellerType: detailSellerType } : {}),
        }),
      });
    }
    console.error("repeat business apartments page 1");
    let repeat: Awaited<ReturnType<typeof readDocument>> | undefined;
    let repeatError: string | undefined;
    for (let attempt = 1; attempt <= 2 && !repeat; attempt += 1) {
      try {
        repeat = await readDocument(page, catalogUrl("business", "apartments", 1));
      } catch (error) {
        repeatError = error instanceof Error ? error.message.slice(0, 240) : "repeat_failed";
        await page.waitForTimeout(500);
      }
    }
    if (repeat) {
      repeatError = undefined;
    }
    const repeatState = repeat ? inspectPrerenderedState(repeat.html) : undefined;
    const repeatStructured = repeatState?.decoded ? readOlxStructuredCatalogPage(repeatState.decoded) : undefined;
    const repeatAds = repeatState?.decoded ? extractListingAdsFromPrerenderedState(repeatState.decoded) : [];
    const repeatBusiness = repeatAds.filter((ad) => asRecord(ad)?.isBusiness === true).length;
    const report = {
      checkedAt: now.toISOString(),
      pageCap: PAGE_CAP,
      walks: walks.map(({ rows: _rows, ...rest }) => rest),
      crosscheck: {
        privateUnique: new Set(privateRows.map((row) => row.sourceId)).size,
        businessUnique: new Set(businessRows.map((row) => row.sourceId)).size,
        onlyPrivate: overlap.onlyPrivate.length,
        onlyBusiness: overlap.onlyBusiness.length,
        idOverlap: overlap.idOverlap,
        tokenOverlap: overlap.tokenOverlap,
        urlOverlapCount: overlap.urlOverlap.length,
      },
      funnel: funnel(evaluated),
      detailCount: details.size,
      profilesProbed: profiles.size,
      ownerLike: ownerTargets.map((row) => publicCard(row, details.get(row.sourceId))),
      fresh24h: freshTargets.map((row) => publicCard(row, details.get(row.sourceId))),
      negativeControl: control.map((row) => publicCard(row, details.get(row.sourceId))),
      repeatBusinessApartmentsPage1: {
        status: repeat?.status ?? 0,
        structured: Boolean(repeatStructured),
        totalPages: repeatStructured?.totalPages ?? null,
        totalElements: repeatStructured?.totalElements ?? null,
        ads: repeatAds.length,
        isBusinessTrue: repeatBusiness,
        completeState: repeatState?.complete ?? false,
        ...(repeatError ? { error: repeatError } : {}),
      },
    };
    writeFileSync(OUT, JSON.stringify(report));
    const outcomeCounts = (cards: Array<{ detail: Record<string, unknown> | null; catalogOutcome: string }>) => {
      const counts: Record<string, number> = {};
      for (const card of cards) {
        const outcome =
          (card.detail && typeof card.detail.auditOutcome === "string"
            ? card.detail.auditOutcome
            : card.catalogOutcome) ?? "DATA_UNAVAILABLE";
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }
      return counts;
    };
    console.log(
      JSON.stringify(
        {
          out: OUT,
          walks: report.walks,
          crosscheck: report.crosscheck,
          funnel: report.funnel,
          detailCount: report.detailCount,
          profilesProbed: report.profilesProbed,
          ownerLike: report.ownerLike.length,
          ownerLikeOutcomes: outcomeCounts(report.ownerLike),
          fresh24h: report.fresh24h.length,
          fresh24hOutcomes: outcomeCounts(report.fresh24h),
          negativeControl: report.negativeControl.length,
          negativeControlOutcomes: outcomeCounts(report.negativeControl),
          repeatBusinessApartmentsPage1: report.repeatBusinessApartmentsPage1,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

function funnel(rows: Evaluated[]) {
  const property = rows.filter((row) => row.propertyMatched === true);
  const geo = property.filter((row) => row.geoReason === "within-radius");
  const geoReject = property.filter((row) => row.geoReason === "outside-radius");
  const geoUnavailable = property.filter(
    (row) => row.geoReason === "no-coordinates" || row.geoReason === "invalid-coordinates" || row.parseFailure,
  );
  const fresh = geo.filter((row) => row.freshnessDeliverable === true);
  const parserFailures = rows.filter((row) => row.parseFailure).length;
  return {
    raw: rows.length,
    unique: rows.length,
    propertyPass: property.length,
    propertyReject: rows.filter((row) => row.parseFailure === undefined && row.propertyMatched === false).length,
    geoPass: geo.length,
    geoReject: geoReject.length,
    geoUnavailable: geoUnavailable.length,
    freshPass: fresh.length,
    sellerCandidates: fresh.length,
    parserFailures,
    fresh24hPropertyGeo: rows.filter(
      (row) =>
        row.propertyMatched === true &&
        row.geoReason === "within-radius" &&
        (row.ageHours ?? Number.POSITIVE_INFINITY) <= 24,
    ).length,
  };
}

function publicCard(row: Evaluated, detail: Record<string, unknown> | undefined) {
  return {
    sourceId: row.sourceId,
    token: row.token ?? null,
    url: row.url ?? null,
    title: row.title ?? null,
    publishedAt: row.createdTime ?? null,
    category: row.category,
    page: row.page,
    city: row.city ?? null,
    userId: row.userId ?? null,
    sellerName: row.sellerName ?? null,
    companyName: row.companyName ?? null,
    isBusiness: row.isBusiness ?? null,
    sellerType: row.sellerType ?? null,
    propertyMatched: row.propertyMatched ?? null,
    geoReason: row.geoReason ?? null,
    distanceKm: row.distanceKm ?? null,
    freshnessKind: row.freshnessKind ?? null,
    freshnessDeliverable: row.freshnessDeliverable ?? null,
    ageHours: row.ageHours ?? null,
    catalogOutcome: row.catalogOutcome,
    catalogReasons: row.catalogReasons,
    parseFailure: row.parseFailure ?? null,
    detail: detail ?? null,
  };
}

await main();
