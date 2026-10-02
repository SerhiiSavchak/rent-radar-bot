/**
 * Read-only OLX Business catalog audit for Lviv long-term rent.
 * Uses stock Playwright. Does not write SQLite, Telegram, or production state.
 *
 * Business account type alone is recorded and is not an audit intermediary verdict.
 */
import { chromium, type Browser, type Page } from "playwright";
import { sellerRejectionReason, classifyOwner } from "../filters/owner-filter.ts";
import { extractOlxAccountRegistrationYear } from "../sources/olx/olx-account-registration.ts";
import {
  OLX_BROWSER_APARTMENTS_PATH,
  OLX_BROWSER_HOUSES_PATH,
  OLX_PRIVATE_CATALOG_PAGE_CAP,
  type OlxBrowserCategoryName,
} from "../sources/olx/olx-browser.coverage.ts";
import { OLX_DISTANCE_KM } from "../sources/olx/olx.source.ts";
import { inspectOlxOfferDetailHtml } from "../sources/olx/olx-browser.detail-inspect.ts";
import {
  extractListingAdsFromPrerenderedState,
  inspectPrerenderedState,
  readOlxStructuredCatalogPage,
} from "../sources/olx/olx-browser.html-extract.ts";
import { extractOlxUrlToken } from "../sources/olx/olx.parser.ts";
import {
  findOlxPublicProfilePath,
  parseOlxProfileInventory,
  resolveOlxInventoryProbeTarget,
} from "../sources/olx/olx-seller-profile.ts";
import { SELLER_INVENTORY_LIMIT_MIN } from "../delivery/seller-profile.ts";
import {
  classifySellerIdentityName,
  classifySellerText,
  hasExplicitIntermediaryText,
  hasExplicitSelfDeclaredOwnerText,
  hasMisleadingOwnerSeekingText,
} from "../utils/text-evidence.ts";

const DETAIL_CAP = Math.max(1, Number(process.env.OLX_BUSINESS_AUDIT_DETAIL_CAP ?? "60") || 60);
const CATALOG_ONLY = process.env.OLX_BUSINESS_AUDIT_CATALOG_ONLY === "true";
const PAGE_CAP = Math.max(
  1,
  Number(process.env.OLX_BUSINESS_AUDIT_PAGE_CAP ?? String(OLX_PRIVATE_CATALOG_PAGE_CAP)) ||
    OLX_PRIVATE_CATALOG_PAGE_CAP,
);

type AuditBucket =
  | "CONFIRMED_INTERMEDIARY"
  | "LIKELY_INTERMEDIARY"
  | "CONFIRMED_OWNER"
  | "POSSIBLE_OWNER"
  | "AMBIGUOUS";

type CatalogRow = {
  category: OlxBrowserCategoryName;
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
  userId?: string;
};

function businessCatalogUrl(category: OlxBrowserCategoryName, page: number): string {
  const path = category === "apartments" ? OLX_BROWSER_APARTMENTS_PATH : OLX_BROWSER_HOUSES_PATH;
  const params = new URLSearchParams();
  params.set("search[dist]", String(OLX_DISTANCE_KM));
  params.set("search[private_business]", "business");
  if (page > 1) {
    params.set("page", String(page));
  }
  return `https://www.olx.ua${path}?${params.toString()}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rowFromAd(category: OlxBrowserCategoryName, raw: unknown): CatalogRow | undefined {
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
  const url = textOf(ad.url) ?? (typeof ad.urlPath === "string" ? `https://www.olx.ua${ad.urlPath}` : undefined);
  const business =
    typeof ad.isBusiness === "boolean"
      ? ad.isBusiness
      : typeof ad.business === "boolean"
        ? ad.business
        : undefined;
  const token = url ? extractOlxUrlToken(url) : undefined;
  const title = textOf(ad.title);
  const createdTime = textOf(ad.createdTime) ?? textOf(ad.created_time);
  const lastRefreshTime = textOf(ad.lastRefreshTime) ?? textOf(ad.last_refresh_time);
  const sellerName = textOf(user?.name);
  const companyName = textOf(user?.company_name);
  const description = textOf(ad.description);
  const sellerType =
    user && "sellerType" in user ? (textOf(user.sellerType) ?? null) : undefined;
  return {
    category,
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
    ...(user?.id !== undefined ? { userId: String(user.id) } : {}),
  };
}

async function readDocument(page: Page, url: string): Promise<{ status: number; html: string; finalUrl: string }> {
  const response = await page.goto(url, { waitUntil: "commit", timeout: 45_000 });
  const html = (await response?.text()) ?? "";
  return { status: response?.status() ?? 0, html, finalUrl: page.url() };
}

async function walkCategory(page: Page, category: OlxBrowserCategoryName) {
  const rows: CatalogRow[] = [];
  const seen = new Set<string>();
  let totalElements: number | null = null;
  let totalPages: number | null = null;
  const pages: number[] = [];
  const failures: string[] = [];
  for (let pageNumber = 1; pageNumber <= PAGE_CAP; pageNumber += 1) {
    if (totalPages !== null && pageNumber > totalPages) {
      break;
    }
    const url = businessCatalogUrl(category, pageNumber);
    let loaded: { status: number; html: string; finalUrl: string };
    try {
      loaded = await readDocument(page, url);
    } catch (error) {
      failures.push(
        `${category} page ${pageNumber}: ${error instanceof Error ? error.message : "navigation_failed"}`.slice(
          0,
          240,
        ),
      );
      break;
    }
    const state = inspectPrerenderedState(loaded.html);
    const structured = state.decoded ? readOlxStructuredCatalogPage(state.decoded) : undefined;
    if (!structured || !state.complete) {
      failures.push(
        `${category} page ${pageNumber}: status=${loaded.status} structured=${structured ? "yes" : "no"} complete=${state.complete}`,
      );
      break;
    }
    if (structured.pageNumber !== pageNumber) {
      failures.push(
        `${category} page ${pageNumber}: structured pageNumber=${structured.pageNumber}`,
      );
      break;
    }
    totalElements = structured.totalElements;
    totalPages = structured.totalPages;
    pages.push(pageNumber);
    for (const ad of extractListingAdsFromPrerenderedState(state.decoded)) {
      const row = rowFromAd(category, ad);
      if (!row || seen.has(row.sourceId)) {
        continue;
      }
      seen.add(row.sourceId);
      rows.push(row);
    }
    if (!CATALOG_ONLY && category === "apartments" && rows.length >= DETAIL_CAP) {
      break;
    }
  }
  return { rows, totalElements, totalPages, pages, failures };
}

function descriptionFromDetail(html: string, sourceId: string): string | undefined {
  const state = inspectPrerenderedState(html).decoded;
  const stack: unknown[] = [state];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (String(record.id ?? "") === sourceId && typeof record.description === "string") {
      return record.description;
    }
    stack.push(...Object.values(record));
  }
  return undefined;
}

function publicText(row: CatalogRow, description?: string): string {
  return [row.title, description ?? row.description, row.sellerName, row.companyName]
    .filter(Boolean)
    .join("\n");
}

function auditBucket(input: {
  sellerType?: string | null;
  companyName?: string;
  sellerName?: string;
  text: string;
  preciseProperties?: number;
}): { bucket: AuditBucket; reasons: string[] } {
  const reasons: string[] = [];
  const sellerType = input.sellerType?.toLowerCase();
  const identity = classifySellerIdentityName(input.companyName ?? input.sellerName);
  const text = classifySellerText(input.text);
  const explicitIntermediary = hasExplicitIntermediaryText(input.text);
  const selfDeclared = hasExplicitSelfDeclaredOwnerText(input.text);
  const seeksOwner = hasMisleadingOwnerSeekingText(input.text);
  if (sellerType === "owner") {
    reasons.push("platform user.sellerType=owner");
    return { bucket: "CONFIRMED_OWNER", reasons };
  }
  if (sellerType === "agent" || sellerType === "agency" || sellerType === "intermediary") {
    reasons.push(`platform user.sellerType=${sellerType}`);
    return { bucket: "CONFIRMED_INTERMEDIARY", reasons };
  }
  if (identity.level === "confirmed") {
    reasons.push(`seller identity confirmed: ${identity.strongSignals.join(", ")}`);
    return { bucket: "CONFIRMED_INTERMEDIARY", reasons };
  }
  if (explicitIntermediary || text.level === "confirmed") {
    reasons.push(
      explicitIntermediary
        ? "explicit intermediary text"
        : `seller text confirmed: ${text.strongSignals.join(", ")}`,
    );
    return { bucket: "CONFIRMED_INTERMEDIARY", reasons };
  }
  if ((input.preciseProperties ?? 0) >= SELLER_INVENTORY_LIMIT_MIN) {
    reasons.push(`precise profile properties=${input.preciseProperties}`);
    return { bucket: "LIKELY_INTERMEDIARY", reasons };
  }
  if (text.level === "likely") {
    reasons.push(`seller text likely: ${text.supportingFamilies.join("+")}`);
    return { bucket: "LIKELY_INTERMEDIARY", reasons };
  }
  if (selfDeclared && !seeksOwner) {
    reasons.push("explicit self-declared owner text, not a platform owner marker");
    return { bucket: "POSSIBLE_OWNER", reasons };
  }
  if (seeksOwner) {
    reasons.push("text seeks an owner");
  }
  reasons.push("no platform owner marker and no non-business intermediary evidence");
  return { bucket: "AMBIGUOUS", reasons };
}

async function main() {
  const started = Date.now();
  const browser: Browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "uk-UA" });
  const catalog = {
    apartments: await walkCategory(page, "apartments"),
    houses: await walkCategory(page, "houses"),
  };
  const byId = new Map<string, CatalogRow>();
  for (const row of [...catalog.apartments.rows, ...catalog.houses.rows]) {
    if (!byId.has(row.sourceId)) {
      byId.set(row.sourceId, row);
    }
  }
  if (CATALOG_ONLY) {
    const counts = {
      CONFIRMED_INTERMEDIARY: 0,
      LIKELY_INTERMEDIARY: 0,
      CONFIRMED_OWNER: 0,
      POSSIBLE_OWNER: 0,
      AMBIGUOUS: 0,
    };
    const samples = [...byId.values()].map((row) => {
      const judged = auditBucket({
        text: publicText(row),
        ...(row.sellerType !== undefined ? { sellerType: row.sellerType } : {}),
        ...(row.companyName ? { companyName: row.companyName } : {}),
        ...(row.sellerName ? { sellerName: row.sellerName } : {}),
      });
      counts[judged.bucket] += 1;
      return {
        sourceId: row.sourceId,
        token: row.token ?? null,
        url: row.url ?? null,
        category: row.category,
        isBusiness: row.isBusiness === true,
        sellerType: row.sellerType ?? null,
        sellerName: row.sellerName ?? null,
        companyName: row.companyName ?? null,
        title: row.title ?? null,
        bucket: judged.bucket,
        reasons: judged.reasons,
      };
    });
    await browser.close();
    const memory = process.memoryUsage();
    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          mode: "catalog_only",
          query: "search[private_business]=business&search[dist]=15",
          elapsedMs: Date.now() - started,
          memory: { rss: memory.rss, heapUsed: memory.heapUsed },
          catalog: {
            apartments: {
              totalElements: catalog.apartments.totalElements,
              totalPages: catalog.apartments.totalPages,
              pages: catalog.apartments.pages,
              rows: catalog.apartments.rows.length,
              failures: catalog.apartments.failures,
            },
            houses: {
              totalElements: catalog.houses.totalElements,
              totalPages: catalog.houses.totalPages,
              pages: catalog.houses.pages,
              rows: catalog.houses.rows.length,
              failures: catalog.houses.failures,
            },
          },
          uniqueCatalogIds: byId.size,
          counts,
          samples,
        },
        null,
        2,
      ),
    );
    return;
  }
  const priority = [...byId.values()].sort((a, b) => {
    const score = (row: CatalogRow) => {
      const text = publicText(row);
      if (row.sellerType?.toLowerCase() === "owner") {
        return 0;
      }
      if (hasExplicitSelfDeclaredOwnerText(text)) {
        return 1;
      }
      if (!row.companyName) {
        return 2;
      }
      return 3;
    };
    return score(a) - score(b);
  });
  const detailed = priority.slice(0, DETAIL_CAP);
  const profiles = new Map<string, { precise: number | null; visible: number | null; path?: string }>();
  const samples = [];
  for (const row of detailed) {
    if (!row.url) {
      continue;
    }
    let detailHtml: string;
    let detailStatus: number;
    try {
      const loaded = await readDocument(page, row.url);
      detailHtml = loaded.html;
      detailStatus = loaded.status;
    } catch (error) {
      samples.push({
        ...row,
        detailStatus: 0,
        detailError: error instanceof Error ? error.message.slice(0, 180) : "detail_failed",
        bucket: "AMBIGUOUS" as const,
        reasons: ["detail navigation failed"],
      });
      continue;
    }
    const inspection = inspectOlxOfferDetailHtml(detailHtml, row.sourceId);
    const description = descriptionFromDetail(detailHtml, row.sourceId) ?? row.description;
    const sellerType = inspection.sellerTypeField.present
      ? inspection.sellerTypeField.value
      : row.sellerType;
    const companyName = inspection.companyNameField.present
      ? (inspection.companyNameField.value ?? undefined)
      : row.companyName;
    const year = extractOlxAccountRegistrationYear(detailHtml);
    const profilePath = findOlxPublicProfilePath(detailHtml);
    const probeTarget = resolveOlxInventoryProbeTarget(detailHtml);
    let precise: number | null = null;
    let visible: number | null = null;
    if (probeTarget && !profiles.has(probeTarget)) {
      try {
        const profile = await readDocument(page, new URL(probeTarget, "https://www.olx.ua").toString());
        const parsed = parseOlxProfileInventory(inspectPrerenderedState(profile.html).decoded);
        precise = parsed.precisePropertyKeys?.length ?? null;
        visible = parsed.visibleAds ?? parsed.realEstateAds ?? null;
        profiles.set(probeTarget, {
          precise,
          visible,
          ...(profilePath ? { path: profilePath } : {}),
        });
      } catch {
        profiles.set(probeTarget, { precise: null, visible: null, ...(profilePath ? { path: profilePath } : {}) });
      }
    } else if (probeTarget && profiles.has(probeTarget)) {
      precise = profiles.get(probeTarget)?.precise ?? null;
      visible = profiles.get(probeTarget)?.visible ?? null;
    }
    const text = publicText(
      {
        ...row,
        ...(row.sellerName ? { sellerName: row.sellerName } : {}),
        ...(companyName ? { companyName } : {}),
      },
      description,
    );
    const judged = auditBucket({
      text,
      ...(sellerType !== undefined ? { sellerType } : {}),
      ...(companyName ? { companyName } : {}),
      ...(row.sellerName ? { sellerName: row.sellerName } : {}),
      ...(precise !== null ? { preciseProperties: precise } : {}),
    });
    const existing = classifyOwner({
      platformOwner: sellerType?.toLowerCase() === "owner",
      platformAgent:
        sellerType?.toLowerCase() === "agent" ||
        sellerType?.toLowerCase() === "agency" ||
        sellerType?.toLowerCase() === "intermediary",
      platformBusiness: sellerType?.toLowerCase() === "business" || inspection.accountType === "business",
      isBusiness: inspection.accountType === "business" || row.isBusiness === true,
      agencyName: companyName,
      sellerIdentityName: row.sellerName,
      text,
    });
    samples.push({
      sourceId: row.sourceId,
      token: row.token ?? null,
      url: row.url,
      category: row.category,
      createdTime: row.createdTime ?? null,
      lastRefreshTime: row.lastRefreshTime ?? null,
      isBusiness: inspection.accountType === "business" || row.isBusiness === true,
      sellerType: sellerType ?? null,
      sellerName: row.sellerName ?? null,
      companyName: companyName ?? null,
      registrationYear: year ?? null,
      profilePath: profilePath ?? probeTarget ?? null,
      preciseProperties: precise,
      visibleAds: visible,
      detailStatus,
      platformLabel: inspection.platformLabel,
      existingSellerType: existing.sellerType,
      existingEvidenceLevel: existing.ownerEvidenceLevel,
      existingRejection: sellerRejectionReason({
        sellerType: existing.sellerType,
        metadata: { ownerEvidenceLevel: existing.ownerEvidenceLevel },
      }) ?? null,
      bucket: judged.bucket,
      reasons: judged.reasons,
      title: row.title ?? null,
    });
  }
  await browser.close();
  const counts = {
    CONFIRMED_INTERMEDIARY: 0,
    LIKELY_INTERMEDIARY: 0,
    CONFIRMED_OWNER: 0,
    POSSIBLE_OWNER: 0,
    AMBIGUOUS: 0,
  };
  for (const sample of samples) {
    if ("bucket" in sample && sample.bucket in counts) {
      counts[sample.bucket as AuditBucket] += 1;
    }
  }
  const memory = process.memoryUsage();
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        query: "search[private_business]=business&search[dist]=15",
        elapsedMs: Date.now() - started,
        memory: { rss: memory.rss, heapUsed: memory.heapUsed },
        catalog,
        uniqueCatalogIds: byId.size,
        detailed: samples.length,
        profilesProbed: profiles.size,
        counts,
        samples,
      },
      null,
      2,
    ),
  );
}

await main();
