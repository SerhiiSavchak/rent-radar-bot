import type { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import type { Listing } from "../domain/listing.ts";
import {
  sellerRejectionReason,
  classifyOwner,
  sellerAssessmentFromListing,
  type OwnerEvidenceLevel,
} from "../filters/owner-filter.ts";
import { safeStoredError } from "../storage/source-health.ts";
import { awaitWithTimeout } from "../utils/deadline.ts";
import { httpGet } from "../utils/http.ts";
import { extractOlxUrlToken } from "../sources/olx/olx.parser.ts";
import {
  adaptOracleCatalogAd,
  collectOfferLikeObjects,
  inspectPrerenderedState,
} from "../sources/olx/olx-browser.html-extract.ts";
import type {
  LinkedSellerDecision,
  RieltorDetailPage,
  StoredSellerVerdict,
} from "./rieltor-detail-seller.ts";
import {
  CONFIRMED_SELLER_CACHE_MS,
  TRANSIENT_SELLER_CACHE_MS,
  UNKNOWN_SELLER_CACHE_MS,
} from "./rieltor-detail-seller.ts";
import {
  shouldRejectSellerProfile,
  SELLER_INVENTORY_LIMIT_MIN,
  SELLER_INVENTORY_LIMIT_REASON,
  isPlatformConfirmedOwner,
  type SellerProfileDeliveryPolicy,
  type SellerProfilePolicies,
  DEFAULT_SELLER_PROFILE_POLICIES,
} from "./seller-profile.ts";
import {
  classifyOlxProfileInventory,
  resolveOlxInventoryProbeTarget,
  OLX_PROFILE_PROBE_BUDGET,
  type OlxProfileSnapshot,
} from "../sources/olx/olx-seller-profile.ts";
import { probeOlxSellerProfile } from "../sources/olx/olx-seller-profile.browser.ts";
import {
  OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
  extractOlxAccountRegistrationYear,
  sellerRegistrationYearRejectionReason,
} from "../sources/olx/olx-account-registration.ts";

export const OLX_DETAIL_GAP_MS = 800;
export const OLX_LINKED_DETAIL_CAP = 5;
/** At most one stock Playwright fallback per poll cycle for exact-linked OLX. */
export const OLX_LINKED_BROWSER_FALLBACK_CAP = 1;
export const OLX_LINKED_BROWSER_LAUNCH_MS = 15_000;
export const OLX_LINKED_BROWSER_NAV_MS = 20_000;
export const OLX_LINKED_BROWSER_BODY_MS = 15_000;
export const OLX_LINKED_BROWSER_CLOSE_MS = 2_000;

type CacheRow = {
  sellerVerdict: StoredSellerVerdict;
  sellerEvidence: string | null;
  expiresAt: string;
  lastHttpStatus: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Accept only https OLX listing URLs with an ID token. Rebuild the URL ourselves.
 */
export function canonicalOlxDetailTarget(
  raw: string | undefined,
): { token: string; url: string } | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    return undefined;
  }
  if (parsed.username || parsed.password) {
    return undefined;
  }
  if (parsed.port && parsed.port !== "443") {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "olx.ua" && host !== "www.olx.ua") {
    return undefined;
  }
  const token = extractOlxUrlToken(parsed.pathname + parsed.search);
  if (!token) {
    return undefined;
  }
  const pathMatch = parsed.pathname.match(/(\/d\/(?:uk\/)?obyavlenie\/[^/]*ID[A-Za-z0-9]+\.html)/i);
  const path = pathMatch?.[1] ?? `/d/obyavlenie/-ID${token}.html`;
  return { token, url: `https://www.olx.ua${path}` };
}

export function trustedOlxFinalUrl(finalUrl: string, requested: string): boolean {
  try {
    const final = new URL(finalUrl);
    const expected = new URL(requested);
    const finalToken = extractOlxUrlToken(final.pathname);
    const expectedToken = extractOlxUrlToken(expected.pathname);
    return Boolean(
      finalToken &&
        expectedToken &&
        finalToken.toLowerCase() === expectedToken.toLowerCase() &&
        (final.hostname === "olx.ua" || final.hostname === "www.olx.ua"),
    );
  } catch {
    return false;
  }
}

function offerMatchesToken(offer: Record<string, unknown>, token: string): boolean {
  const url = typeof offer.url === "string" ? offer.url : "";
  const path = typeof offer.urlPath === "string" ? offer.urlPath : "";
  const haystack = `${url}\n${path}`;
  return extractOlxUrlToken(haystack)?.toLowerCase() === token.toLowerCase();
}

type OlxHtmlSellerClassification = {
  verdict: StoredSellerVerdict;
  evidence: string;
  ownerEvidenceLevel?: OwnerEvidenceLevel;
  sellerType?: Listing["sellerType"];
};

export function classifyOlxLinkedSellerHtml(
  html: string,
  token: string,
): OlxHtmlSellerClassification {
  const inspection = inspectPrerenderedState(html);
  if (!inspection.present || !inspection.decoded) {
    return { verdict: "parser_failure", evidence: "prerendered state missing" };
  }
  const candidates = collectOfferLikeObjects(inspection.decoded, 40);
  let offer = candidates.map(asRecord).find((item) => item && offerMatchesToken(item, token));
  if (!offer) {
    const adapted = adaptOracleCatalogAd(inspection.decoded);
    const adaptedRecord = asRecord(adapted);
    if (adaptedRecord && offerMatchesToken(adaptedRecord, token)) {
      offer = adaptedRecord;
    }
  }
  if (!offer) {
    return { verdict: "parser_failure", evidence: "offer record not found for OLX token" };
  }
  const user = asRecord(offer.user);
  const company =
    typeof user?.company_name === "string" && user.company_name.trim()
      ? user.company_name.trim()
      : undefined;
  const sellerName = typeof user?.name === "string" && user.name.trim() ? user.name.trim() : undefined;
  const sellerType =
    typeof user?.sellerType === "string" && user.sellerType.trim() ? user.sellerType.trim() : undefined;
  const business =
    typeof offer.business === "boolean"
      ? offer.business
      : typeof offer.isBusiness === "boolean"
        ? offer.isBusiness
        : undefined;
  const title = typeof offer.title === "string" ? offer.title : "";
  const description = typeof offer.description === "string" ? offer.description : "";
  const lowerType = sellerType?.toLowerCase();
  const owner = classifyOwner({
    platformOwner: lowerType === "owner",
    platformAgent:
      lowerType === "agent" || lowerType === "agency" || lowerType === "intermediary",
    // Explicit user.sellerType=business only. offer.isBusiness is account type.
    platformBusiness: lowerType === "business",
    platformPrivate: business === false,
    isBusiness: business === true,
    agencyName: company,
    sellerIdentityName: sellerName,
    text: `${title}\n${description}`,
  });
  if (sellerRejectionReason({ sellerType: owner.sellerType, metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel } }) &&
    owner.ownerEvidenceLevel !== "business_ambiguous") {
    return {
      verdict: "confirmed_intermediary",
      evidence: owner.sellerEvidence.join("; ") || "linked OLX seller is intermediary",
    };
  }
  // Customer exclusion: exact platform registration year 2026 (not listing dates).
  // This stays stronger than a Business-account fail-closed and stronger than an owner claim.
  const registrationYear = extractOlxAccountRegistrationYear(html);
  if (sellerRegistrationYearRejectionReason(registrationYear)) {
    return {
      verdict: "seller_registration_year_2026",
      evidence: OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
    };
  }
  if (owner.ownerEvidenceLevel === "business_ambiguous") {
    return {
      // Cache enum has no separate verdict. The evidence prefix is the product reason.
      verdict: "confirmed_intermediary",
      evidence: `business_without_positive_owner_evidence; ${owner.sellerEvidence.join("; ")}`,
    };
  }
  // Contract: confirmed_owner requires both sellerType=owner AND platform_confirmed.
  // classifyOwner pairs them; AND documents that free text alone cannot clear.
  if (
    isPlatformConfirmedOwner({
      sellerType: owner.sellerType,
      metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
    })
  ) {
    return {
      verdict: "confirmed_owner" as const,
      evidence: owner.sellerEvidence.join("; ") || "linked OLX seller is owner",
      ownerEvidenceLevel: owner.ownerEvidenceLevel,
      sellerType: owner.sellerType,
    };
  }
  // A linked shop/storefront URL is not intermediary proof by itself. Inventory
  // and explicit agency/service text are classified through existing tiers.
  return {
    verdict: "unknown" as const,
    evidence: owner.sellerEvidence.join("; ") || "linked OLX seller unresolved",
    ownerEvidenceLevel: owner.ownerEvidenceLevel,
    sellerType: owner.sellerType,
  };
}

function catalogRejectionIsTerminal(listing: {
  sellerType: Listing["sellerType"];
  metadata?: Listing["metadata"];
}): boolean {
  const reason = sellerRejectionReason(listing);
  // Catalog Business ambiguity is not intermediary proof. A fresh card still
  // gets one detail read. Explicit roles and agency text stay terminal.
  return reason !== undefined && reason !== "business_without_positive_owner_evidence";
}

function businessDetailStillRequired(listing: Listing): boolean {
  const business =
    listing.metadata?.olxAccountType === "business" || listing.metadata?.olxIsBusiness === true;
  if (!business) {
    return false;
  }
  const level = listing.metadata?.ownerEvidenceLevel;
  return level !== "self_declared" && level !== "platform_confirmed";
}

function applyPositiveDetailOwner(
  listing: Listing,
  classified: { ownerEvidenceLevel?: string; sellerType?: Listing["sellerType"] } | undefined,
): void {
  const level = classified?.ownerEvidenceLevel;
  const business =
    listing.metadata?.olxAccountType === "business" || listing.metadata?.olxIsBusiness === true;
  if (!business || (level !== "self_declared" && level !== "platform_confirmed")) {
    return;
  }
  if (classified?.sellerType) {
    listing.sellerType = classified.sellerType;
  }
  listing.metadata = {
    ...(listing.metadata ?? {}),
    ownerEvidenceLevel: level,
    filterConsidersSelfDeclaredOwner: level === "self_declared",
  };
  listing.metadata = {
    ...listing.metadata,
    sellerAssessment: sellerAssessmentFromListing(listing),
  };
}

function readOlxSellerVerification(
  db: DatabaseSync,
  externalId: string,
  now: Date,
): CacheRow | undefined {
  const row = db
    .prepare(
      `SELECT seller_verdict AS sellerVerdict,
              seller_evidence AS sellerEvidence,
              expires_at AS expiresAt,
              last_http_status AS lastHttpStatus
       FROM external_seller_verifications
       WHERE source = 'olx' AND external_listing_id = ?`,
    )
    .get(externalId) as CacheRow | undefined;
  if (!row || Date.parse(row.expiresAt) <= now.getTime()) {
    return undefined;
  }
  return row;
}

function writeOlxSellerVerification(
  db: DatabaseSync,
  input: {
    externalId: string;
    canonicalUrl: string;
    verdict: StoredSellerVerdict;
    evidence: string;
    httpStatus?: number;
    now: Date;
    ttlMs: number;
  },
): void {
  const checkedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
  db.prepare(
    `INSERT INTO external_seller_verifications (
       source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
       checked_at, expires_at, last_http_status, last_error_safe
     ) VALUES ('olx', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, external_listing_id) DO UPDATE SET
       canonical_url = excluded.canonical_url,
       seller_verdict = excluded.seller_verdict,
       seller_evidence = excluded.seller_evidence,
       checked_at = excluded.checked_at,
       expires_at = excluded.expires_at,
       last_http_status = excluded.last_http_status,
       last_error_safe = excluded.last_error_safe`,
  ).run(
    input.externalId,
    input.canonicalUrl,
    input.verdict,
    safeStoredError(input.evidence, input.verdict),
    checkedAt,
    expiresAt,
    input.httpStatus ?? null,
    input.verdict === "confirmed_owner" ||
      input.verdict === "confirmed_intermediary" ||
      input.verdict === "profile_likely_intermediary" ||
      input.verdict === "seller_registration_year_2026" ||
      input.verdict === "seller_inventory_limit" ||
      input.verdict === "unknown"
      ? null
      : safeStoredError(input.evidence, input.verdict),
  );
}

function decisionFromStored(
  row: CacheRow,
  token: string,
  profilePolicies: SellerProfilePolicies,
): LinkedSellerDecision {
  if (
    row.sellerVerdict === "confirmed_intermediary" &&
    (row.sellerEvidence ?? "").includes("business_without_positive_owner_evidence")
  ) {
    return {
      outcome: "business_without_positive_owner_evidence",
      drop: true,
      requested: false,
      externalId: token,
      evidence: row.sellerEvidence ?? "business_without_positive_owner_evidence",
    };
  }
  if (row.sellerVerdict === "confirmed_intermediary") {
    return {
      outcome: "cache_confirmed_agent",
      drop: true,
      requested: false,
      externalId: token,
      evidence: row.sellerEvidence ?? "cached OLX intermediary",
    };
  }
  if (row.sellerVerdict === "seller_registration_year_2026") {
    return {
      outcome: "cache_registration_year_excluded",
      drop: true,
      requested: false,
      externalId: token,
      evidence: row.sellerEvidence ?? OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
    };
  }
  if (row.sellerVerdict === "seller_inventory_limit") {
    return {
      outcome: "cache_inventory_limit",
      drop: true,
      requested: false,
      externalId: token,
      evidence: row.sellerEvidence ?? SELLER_INVENTORY_LIMIT_REASON,
    };
  }
  if (row.sellerVerdict === "profile_likely_intermediary") {
    const drop = shouldRejectSellerProfile("profile_likely_intermediary", profilePolicies);
    return {
      outcome: "detail_profile_likely",
      drop,
      requested: false,
      externalId: token,
      evidence: row.sellerEvidence ?? "cached OLX profile_likely_intermediary",
    };
  }
  if (row.sellerVerdict === "confirmed_owner") {
    return {
      outcome: "cache_confirmed_owner",
      drop: false,
      requested: false,
      externalId: token,
      evidence: row.sellerEvidence ?? "cached OLX owner",
    };
  }
  if (
    row.sellerVerdict === "rate_limited" ||
    row.sellerVerdict === "transport_failure" ||
    row.sellerVerdict === "parser_failure"
  ) {
    return {
      outcome:
        row.sellerVerdict === "rate_limited"
          ? "detail_rate_limited"
          : row.sellerVerdict === "parser_failure"
            ? "detail_parser_failure"
            : "detail_transport_failure",
      drop: false,
      requested: false,
      externalId: token,
      evidence: row.sellerEvidence ?? row.sellerVerdict,
      ...(row.lastHttpStatus !== null ? { httpStatus: row.lastHttpStatus } : {}),
    };
  }
  return {
    outcome: "cache_unknown",
    drop: false,
    requested: false,
    externalId: token,
    evidence: row.sellerEvidence ?? "cached OLX unknown",
  };
}

function peerToken(listing: Listing): string | undefined {
  return extractOlxUrlToken(listing.url) ?? (typeof listing.metadata?.urlToken === "string"
    ? listing.metadata.urlToken
    : undefined);
}

export async function fetchOlxDetailPage(
  url: string,
  timeoutMs: number,
): Promise<RieltorDetailPage> {
  const response = await httpGet(url, {
    timeoutMs,
    maxRetries: 0,
    retryOn: () => false,
  });
  return { status: response.status, finalUrl: response.url, bodyText: response.bodyText };
}

export type OlxLinkedBrowserDetailPage = RieltorDetailPage & {
  browserClosed: boolean;
  browserCloseTimedOut: boolean;
  pageCloseTimedOut: boolean;
  contextCloseTimedOut: boolean;
  bodyContentFallbackTimedOut: boolean;
  timedOut: boolean;
  notes: string[];
};

/** Minimal Playwright surface for exact-listing fallback + test doubles. */
export type OlxLinkedBrowserPage = {
  goto: (
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ) => Promise<OlxLinkedBrowserResponse | null>;
  url: () => string;
  content: () => Promise<string>;
  close: () => Promise<void>;
};

export type OlxLinkedBrowserResponse = {
  status: () => number;
  text: () => Promise<string>;
};

export type OlxLinkedBrowserContext = {
  newPage: () => Promise<OlxLinkedBrowserPage>;
  close: () => Promise<void>;
};

export type OlxLinkedBrowser = {
  newContext: (options?: { locale?: string }) => Promise<OlxLinkedBrowserContext>;
  close: () => Promise<void>;
};

export type OlxLinkedBrowserFetchDeps = {
  launch?: () => Promise<OlxLinkedBrowser>;
  /** Cleanup budget for page/context/browser.close. Defaults to OLX_LINKED_BROWSER_CLOSE_MS. */
  closeBudgetMs?: number;
  bodyBudgetMs?: number;
  launchBudgetMs?: number;
  navigationBudgetMs?: number;
};

/** Raw HTTP statuses where stock Playwright may still open the exact listing. */
export function olxRawTransportNeedsBrowserFallback(status: number): boolean {
  return status === 403 || status === 408 || status >= 500;
}

/**
 * One stock Chromium launch for the exact canonical OLX listing URL only.
 * No profile crawl, no pagination, no stealth. Every await is wall-clock bounded.
 */
export async function fetchOlxLinkedDetailViaBrowser(
  url: string,
  timeoutMs: number,
  deps: OlxLinkedBrowserFetchDeps = {},
): Promise<OlxLinkedBrowserDetailPage> {
  const notes: string[] = ["transport=stock_playwright_exact_listing"];
  const launchMs = Math.min(deps.launchBudgetMs ?? OLX_LINKED_BROWSER_LAUNCH_MS, timeoutMs);
  const navMs = Math.min(deps.navigationBudgetMs ?? OLX_LINKED_BROWSER_NAV_MS, timeoutMs);
  const bodyMs = Math.min(deps.bodyBudgetMs ?? OLX_LINKED_BROWSER_BODY_MS, timeoutMs);
  const closeMs = Math.min(deps.closeBudgetMs ?? OLX_LINKED_BROWSER_CLOSE_MS, timeoutMs);
  const launch = deps.launch ?? (() => chromium.launch({ headless: true }) as Promise<OlxLinkedBrowser>);
  const pendingLaunch = launch();
  let browser: OlxLinkedBrowser | undefined;
  let browserCloseTimedOut = false;
  let pageCloseTimedOut = false;
  let contextCloseTimedOut = false;
  let bodyContentFallbackTimedOut = false;
  let timedOut = false;
  let status = 0;
  let finalUrl = url;
  let bodyText = "";

  const closeOwned = async (
    close: () => Promise<void>,
    label: string,
  ): Promise<"ok" | "timeout"> => {
    try {
      await awaitWithTimeout(close(), closeMs, label);
      return "ok";
    } catch {
      notes.push(`${label}_timeout`);
      // Detached best-effort; must not delay the poll cycle.
      void close().catch(() => undefined);
      return "timeout";
    }
  };

  try {
    browser = await awaitWithTimeout(pendingLaunch, launchMs, "olx.linked.chromium.launch");
    const context = await awaitWithTimeout(
      browser.newContext({ locale: "uk-UA" }),
      launchMs,
      "olx.linked.chromium.newContext",
    );
    try {
      const page = await awaitWithTimeout(
        context.newPage(),
        launchMs,
        "olx.linked.chromium.newPage",
      );
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: navMs,
        });
        if (!response) {
          timedOut = true;
          notes.push("navigation_empty_response");
        } else {
          status = response.status();
          finalUrl = page.url();
          try {
            bodyText = await awaitWithTimeout(
              response.text(),
              bodyMs,
              "olx.linked.response.text",
            );
          } catch {
            notes.push("body_read_timeout");
            try {
              bodyText = await awaitWithTimeout(
                page.content(),
                bodyMs,
                "olx.linked.page.content",
              );
              notes.push("body_content_fallback_used");
            } catch {
              bodyContentFallbackTimedOut = true;
              timedOut = true;
              bodyText = "";
              notes.push("body_content_fallback_timeout");
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timeout/i.test(message)) {
          timedOut = true;
          notes.push("navigation_timeout");
        } else {
          notes.push(`navigation_error:${message.slice(0, 120)}`);
        }
        try {
          finalUrl = page.url();
        } catch {
          // ignore
        }
      } finally {
        if ((await closeOwned(() => page.close(), "olx.linked.page.close")) === "timeout") {
          pageCloseTimedOut = true;
        }
      }
    } finally {
      if ((await closeOwned(() => context.close(), "olx.linked.context.close")) === "timeout") {
        contextCloseTimedOut = true;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      timedOut = true;
    }
    notes.push(`browser_failed:${message.slice(0, 120)}`);
    // Late launch must not delay the cycle; fire-and-forget close only.
    void pendingLaunch
      .then((opened) => {
        void opened.close().catch(() => undefined);
      })
      .catch(() => undefined);
  } finally {
    if (browser) {
      if ((await closeOwned(() => browser!.close(), "olx.linked.chromium.close")) === "timeout") {
        browserCloseTimedOut = true;
      }
    }
  }

  const cleanupTimedOut =
    pageCloseTimedOut || contextCloseTimedOut || browserCloseTimedOut;
  return {
    status: status || (timedOut ? 408 : 0),
    finalUrl,
    bodyText,
    browserClosed: !cleanupTimedOut,
    browserCloseTimedOut,
    pageCloseTimedOut,
    contextCloseTimedOut,
    bodyContentFallbackTimedOut,
    timedOut,
    notes,
  };
}

function decisionFromClassified(
  classified: { verdict: StoredSellerVerdict; evidence: string },
  token: string,
  httpStatus: number,
  requested: boolean,
  evidencePrefix?: string,
  profilePolicies: SellerProfilePolicies = DEFAULT_SELLER_PROFILE_POLICIES,
): LinkedSellerDecision {
  const evidence = evidencePrefix
    ? `${evidencePrefix}; ${classified.evidence}`
    : classified.evidence;
  if (evidence.includes("business_without_positive_owner_evidence")) {
    return {
      outcome: "business_without_positive_owner_evidence",
      drop: true,
      requested,
      externalId: token,
      httpStatus,
      evidence,
    };
  }
  if (classified.verdict === "confirmed_intermediary") {
    return {
      outcome: "detail_confirmed_agent",
      drop: true,
      requested,
      externalId: token,
      httpStatus,
      evidence,
    };
  }
  if (classified.verdict === "seller_registration_year_2026") {
    return {
      outcome: "detail_registration_year_excluded",
      drop: true,
      requested,
      externalId: token,
      httpStatus,
      evidence,
    };
  }
  if (classified.verdict === "seller_inventory_limit") {
    return {
      outcome: "detail_inventory_limit",
      drop: true,
      requested,
      externalId: token,
      httpStatus,
      evidence,
    };
  }
  if (classified.verdict === "profile_likely_intermediary") {
    return {
      outcome: "detail_profile_likely",
      drop: shouldRejectSellerProfile("profile_likely_intermediary", profilePolicies),
      requested,
      externalId: token,
      httpStatus,
      evidence,
    };
  }
  if (classified.verdict === "confirmed_owner") {
    return {
      outcome: "detail_confirmed_owner",
      drop: false,
      requested,
      externalId: token,
      httpStatus,
      evidence,
    };
  }
  if (classified.verdict === "parser_failure") {
    return {
      outcome: "detail_parser_failure",
      drop: false,
      requested,
      externalId: token,
      httpStatus,
      evidence,
    };
  }
  return {
    outcome: "detail_unknown",
    drop: false,
    requested,
    externalId: token,
    httpStatus,
    evidence,
  };
}

/** True only after a completed profile read that did not prove an exclusion or an unread remainder. */
function profileInventoryClearedForOwner(decision: { verdict: string; evidence: string }): boolean {
  if (
    decision.verdict === "seller_inventory_limit" ||
    decision.verdict === "profile_likely_intermediary"
  ) {
    return false;
  }
  return !decision.evidence.includes("olx_inventory_incomplete=");
}

function rememberVerdict(
  db: DatabaseSync | undefined,
  target: { token: string; url: string },
  classified: { verdict: StoredSellerVerdict; evidence: string },
  httpStatus: number | undefined,
  now: Date,
): void {
  if (!db) {
    return;
  }
  const ttl =
    classified.verdict === "confirmed_intermediary" ||
    classified.verdict === "confirmed_owner" ||
    classified.verdict === "profile_likely_intermediary" ||
    classified.verdict === "seller_registration_year_2026" ||
    classified.verdict === "seller_inventory_limit"
      ? CONFIRMED_SELLER_CACHE_MS
      : classified.verdict === "unknown"
        ? UNKNOWN_SELLER_CACHE_MS
        : TRANSIENT_SELLER_CACHE_MS;
  writeOlxSellerVerification(db, {
    externalId: target.token,
    canonicalUrl: target.url,
    verdict: classified.verdict,
    evidence: classified.evidence,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    now,
    ttlMs: ttl,
  });
}

export function createCycleOlxSellerVerifier(options: {
  db?: DatabaseSync | undefined;
  peers: Listing[];
  now: () => Date;
  timeoutMs: number;
  gapMs?: number;
  maxRequests?: number;
  maxBrowserFallbacks?: number;
  maxProfileProbes?: number;
  profileLikelyPolicy?: SellerProfileDeliveryPolicy;
  fetchPage?: ((url: string, timeoutMs: number) => Promise<RieltorDetailPage>) | undefined;
  fetchViaBrowser?:
    | ((url: string, timeoutMs: number) => Promise<OlxLinkedBrowserDetailPage>)
    | undefined;
  /** Test double / production Playwright profile inventory. */
  probeProfile?:
    | ((input: {
        listingUrl: string;
        listingHtml?: string;
        profilePath?: string;
        timeoutMs: number;
      }) => Promise<OlxProfileSnapshot>)
    | undefined;
}): (listing: Listing) => Promise<LinkedSellerDecision> {
  let haltedAfterRateLimit = false;
  let lastRequestAt = 0;
  let requests = 0;
  let browserFallbacks = 0;
  let profileProbes = 0;
  const fetchPage = options.fetchPage ?? fetchOlxDetailPage;
  const fetchViaBrowser = options.fetchViaBrowser ?? fetchOlxLinkedDetailViaBrowser;
  const probeProfile = options.probeProfile ?? probeOlxSellerProfile;
  const gapMs = options.gapMs ?? OLX_DETAIL_GAP_MS;
  const maxRequests = options.maxRequests ?? OLX_LINKED_DETAIL_CAP;
  const maxBrowserFallbacks = options.maxBrowserFallbacks ?? OLX_LINKED_BROWSER_FALLBACK_CAP;
  const maxProfileProbes = options.maxProfileProbes ?? OLX_PROFILE_PROBE_BUDGET;
  const profilePolicies: SellerProfilePolicies = {
    ...DEFAULT_SELLER_PROFILE_POLICIES,
    ...(options.profileLikelyPolicy ? { likelyPolicy: options.profileLikelyPolicy } : {}),
  };

  const profileReadFailure = (
    target: { token: string; url: string },
    at: Date,
    kind: "transport" | "parser",
    httpStatus?: number,
    requested = false,
  ): LinkedSellerDecision => {
    const evidence = kind === "transport" ? "olx_profile_probe_threw" : "olx_profile_unreadable";
    rememberVerdict(
      options.db,
      target,
      {
        verdict: kind === "transport" ? "transport_failure" : "parser_failure",
        evidence,
      },
      httpStatus,
      at,
    );
    return {
      outcome: kind === "transport" ? "detail_transport_failure" : "detail_parser_failure",
      drop: false,
      requested,
      externalId: target.token,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      evidence,
    };
  };

  const applyProfileInventory = async (
    target: { token: string; url: string },
    classified: { verdict: StoredSellerVerdict; evidence: string },
    html: string | undefined,
    httpStatus: number,
    requested: boolean,
    now: Date,
    evidencePrefix?: string,
  ): Promise<LinkedSellerDecision> => {
    const ownerAwaitingInventory = classified.verdict === "confirmed_owner";
    // Intermediary, registration year, parser failure, and an already-known
    // inventory limit stay terminal. A platform owner must not skip the probe.
    if (classified.verdict !== "unknown" && !ownerAwaitingInventory) {
      rememberVerdict(options.db, target, classified, httpStatus, now);
      return decisionFromClassified(
        classified,
        target.token,
        httpStatus,
        requested,
        evidencePrefix,
        profilePolicies,
      );
    }
    const probeTarget = html ? resolveOlxInventoryProbeTarget(html) : undefined;
    if (!ownerAwaitingInventory && !probeTarget && !html) {
      rememberVerdict(options.db, target, classified, httpStatus, now);
      return decisionFromClassified(
        classified,
        target.token,
        httpStatus,
        requested,
        evidencePrefix,
        profilePolicies,
      );
    }
    if (profileProbes >= maxProfileProbes) {
      if (ownerAwaitingInventory) {
        return {
          outcome: "detail_capacity_deferred",
          drop: false,
          requested,
          externalId: target.token,
          httpStatus,
          evidence: `${classified.evidence}; olx_profile_probe_cap=${maxProfileProbes}`,
        };
      }
      const capped: { verdict: StoredSellerVerdict; evidence: string } = {
        verdict: "unknown",
        evidence: `${classified.evidence}; olx_profile_probe_cap=${maxProfileProbes}`,
      };
      rememberVerdict(options.db, target, capped, httpStatus, now);
      return decisionFromClassified(
        capped,
        target.token,
        httpStatus,
        requested,
        evidencePrefix,
        profilePolicies,
      );
    }
    profileProbes += 1;
    let snapshot: OlxProfileSnapshot;
    try {
      snapshot = await probeProfile({
        listingUrl: target.url,
        ...(html ? { listingHtml: html } : {}),
        ...(probeTarget ? { profilePath: probeTarget } : {}),
        timeoutMs: options.timeoutMs,
      });
    } catch {
      return profileReadFailure(target, now, "transport", httpStatus, requested);
    }
    if (!snapshot.acquired) {
      return profileReadFailure(target, now, "parser", httpStatus, requested);
    }
    const profileDecision = classifyOlxProfileInventory(snapshot, now);
    if (
      profileDecision.verdict === "seller_inventory_limit" ||
      profileDecision.verdict === "profile_likely_intermediary"
    ) {
      const enriched: { verdict: StoredSellerVerdict; evidence: string } = {
        verdict: profileDecision.verdict,
        evidence: `${classified.evidence}; ${profileDecision.evidence}`,
      };
      rememberVerdict(options.db, target, enriched, httpStatus, now);
      return decisionFromClassified(
        enriched,
        target.token,
        httpStatus,
        requested,
        evidencePrefix,
        profilePolicies,
      );
    }
    if (ownerAwaitingInventory && profileInventoryClearedForOwner(profileDecision)) {
      const cleared: { verdict: StoredSellerVerdict; evidence: string } = {
        verdict: "confirmed_owner",
        evidence: `${classified.evidence}; ${profileDecision.evidence}`,
      };
      rememberVerdict(options.db, target, cleared, httpStatus, now);
      return decisionFromClassified(
        cleared,
        target.token,
        httpStatus,
        requested,
        evidencePrefix,
        profilePolicies,
      );
    }
    const merged: { verdict: StoredSellerVerdict; evidence: string } = {
      verdict: "unknown",
      evidence: `${classified.evidence}; ${profileDecision.evidence}`,
    };
    rememberVerdict(options.db, target, merged, httpStatus, now);
    return decisionFromClassified(
      merged,
      target.token,
      httpStatus,
      requested,
      evidencePrefix,
      profilePolicies,
    );
  };

  const rememberTransport = (
    target: { token: string; url: string },
    evidence: string,
    httpStatus: number | undefined,
    now: Date,
  ): LinkedSellerDecision => {
    if (options.db) {
      writeOlxSellerVerification(options.db, {
        externalId: target.token,
        canonicalUrl: target.url,
        verdict: "transport_failure",
        evidence,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        now,
        ttlMs: TRANSIENT_SELLER_CACHE_MS,
      });
    }
    return {
      outcome: "detail_transport_failure",
      drop: false,
      requested: true,
      externalId: target.token,
      evidence,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  };

  const tryBrowserFallback = async (
    target: { token: string; url: string },
    now: Date,
    rawStatus: number | undefined,
    rawEvidence: string,
  ): Promise<LinkedSellerDecision> => {
    if (browserFallbacks >= maxBrowserFallbacks) {
      return {
        outcome: "detail_capacity_deferred",
        drop: false,
        requested: true,
        externalId: target.token,
        evidence: `${rawEvidence}; browser fallback cap ${maxBrowserFallbacks} reached`,
        ...(rawStatus !== undefined ? { httpStatus: rawStatus } : {}),
      };
    }
    browserFallbacks += 1;
    let browserPage: OlxLinkedBrowserDetailPage;
    try {
      browserPage = await fetchViaBrowser(target.url, options.timeoutMs);
    } catch (error) {
      const evidence = error instanceof Error ? error.message : "browser network error";
      return rememberTransport(
        target,
        `${rawEvidence}; browser fallback failed: ${evidence}`,
        rawStatus,
        now,
      );
    }
    if (
      browserPage.status === 0 ||
      browserPage.status >= 400 ||
      !browserPage.bodyText.trim()
    ) {
      return rememberTransport(
        target,
        `${rawEvidence}; browser fallback status=${browserPage.status} timedOut=${browserPage.timedOut} notes=${browserPage.notes.join(",")}`,
        browserPage.status || rawStatus,
        now,
      );
    }
    if (!trustedOlxFinalUrl(browserPage.finalUrl, target.url)) {
      return rememberTransport(
        target,
        `${rawEvidence}; browser final URL is not the requested OLX listing`,
        browserPage.status,
        now,
      );
    }
    const classified = classifyOlxLinkedSellerHtml(browserPage.bodyText, target.token);
    return applyProfileInventory(
      target,
      classified,
      browserPage.bodyText,
      browserPage.status,
      true,
      now,
      `browser fallback after ${rawEvidence}`,
    );
  };

  return async (listing) => {
    // Direct OLX: listing HTML classification + bounded profile probe.
    // Unknown / incomplete / transport / parser states must NOT become not_required.
    if (listing.source === "olx") {
      const target = canonicalOlxDetailTarget(listing.url);
      if (!target) {
        if (businessDetailStillRequired(listing)) {
          return {
            outcome: "business_without_positive_owner_evidence",
            drop: true,
            requested: false,
            evidence: "business_without_positive_owner_evidence",
          };
        }
        return { outcome: "not_required", drop: false, requested: false };
      }
      // A persisted hold stores the previous card. The fresh same-cycle card can
      // already be an explicit intermediary, and that must win before any probe.
      const sameCycleAgent = options.peers.find(
        (item) =>
          item.source === "olx" &&
          peerToken(item)?.toLowerCase() === target.token.toLowerCase() &&
          catalogRejectionIsTerminal(item),
      );
      if (sameCycleAgent) {
        return {
          outcome: "same_cycle_confirmed_agent",
          drop: true,
          requested: false,
          externalId: target.token,
          evidence: "same-cycle OLX listing is a confirmed intermediary",
        };
      }
      const nowDirect = options.now();
      const yearMetaRaw = listing.metadata?.accountRegistrationYear;
      const yearMeta =
        typeof yearMetaRaw === "number"
          ? yearMetaRaw
          : typeof yearMetaRaw === "string"
            ? Number(yearMetaRaw)
            : undefined;
      if (sellerRegistrationYearRejectionReason(yearMeta)) {
        rememberVerdict(
          options.db,
          target,
          {
            verdict: "seller_registration_year_2026",
            evidence: OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
          },
          undefined,
          nowDirect,
        );
        return {
          outcome: "detail_registration_year_excluded",
          drop: true,
          requested: false,
          externalId: target.token,
          evidence: OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
        };
      }
      let cachedOwnerDecision: LinkedSellerDecision | undefined;
      if (options.db) {
        const cached = readOlxSellerVerification(options.db, target.token, nowDirect);
        if (cached) {
          const fromCache = decisionFromStored(cached, target.token, profilePolicies);
          if (
            fromCache.outcome !== "cache_unknown" &&
            fromCache.outcome !== "cache_confirmed_owner"
          ) {
            return fromCache;
          }
          if (profileProbes >= maxProfileProbes) {
            if (fromCache.outcome === "cache_confirmed_owner") {
              return {
                outcome: "detail_capacity_deferred",
                drop: false,
                requested: false,
                externalId: target.token,
                evidence: `olx_profile_probe_cap=${maxProfileProbes}`,
              };
            }
            return fromCache;
          }
          if (fromCache.outcome === "cache_confirmed_owner") {
            cachedOwnerDecision = fromCache;
          }
        }
      }
      const inventoryRaw = listing.metadata?.distinctPreciseRealEstateProperties;
      const inventoryCount =
        typeof inventoryRaw === "number"
          ? inventoryRaw
          : typeof inventoryRaw === "string"
            ? Number(inventoryRaw)
            : undefined;
      if (
        typeof inventoryCount === "number" &&
        Number.isInteger(inventoryCount) &&
        inventoryCount >= SELLER_INVENTORY_LIMIT_MIN
      ) {
        rememberVerdict(
          options.db,
          target,
          {
            verdict: "seller_inventory_limit",
            evidence: `${SELLER_INVENTORY_LIMIT_REASON};distinct_precise_properties=${inventoryCount}`,
          },
          undefined,
          nowDirect,
        );
        return {
          outcome: "detail_inventory_limit",
          drop: true,
          requested: false,
          externalId: target.token,
          evidence: SELLER_INVENTORY_LIMIT_REASON,
        };
      }
      if (profileProbes >= maxProfileProbes) {
        const businessAccount =
          listing.metadata?.olxAccountType === "business" || listing.metadata?.olxIsBusiness === true;
        // Private keeps the existing evaluated-unknown path. A Business account
        // must not be sent when the profile budget is already spent.
        if (businessAccount) {
          return {
            outcome: "detail_capacity_deferred",
            drop: false,
            requested: false,
            externalId: target.token,
            evidence: `olx_profile_probe_cap=${maxProfileProbes}`,
          };
        }
        const capped: { verdict: StoredSellerVerdict; evidence: string } = {
          verdict: "unknown",
          evidence: `olx_profile_probe_cap=${maxProfileProbes}`,
        };
        rememberVerdict(options.db, target, capped, undefined, nowDirect);
        return {
          outcome: "detail_unknown",
          drop: false,
          requested: false,
          externalId: target.token,
          evidence: capped.evidence,
        };
      }
      profileProbes += 1;
      let snapshot: OlxProfileSnapshot;
      try {
        snapshot = await probeProfile({
          listingUrl: target.url,
          timeoutMs: options.timeoutMs,
        });
      } catch {
        return profileReadFailure(target, nowDirect, "transport");
      }

      let listingClassified: OlxHtmlSellerClassification | undefined;
      if (snapshot.listingHtml) {
        listingClassified = classifyOlxLinkedSellerHtml(snapshot.listingHtml, target.token);
        if (
          listingClassified.verdict === "confirmed_intermediary" ||
          listingClassified.verdict === "seller_registration_year_2026" ||
          listingClassified.verdict === "parser_failure"
        ) {
          rememberVerdict(options.db, target, listingClassified, 200, nowDirect);
          return decisionFromClassified(
            listingClassified,
            target.token,
            200,
            false,
            undefined,
            profilePolicies,
          );
        }
      }
      if (!snapshot.acquired) {
        return profileReadFailure(target, nowDirect, "parser");
      }

      const profileDecision = classifyOlxProfileInventory(snapshot, nowDirect);
      if (
        profileDecision.verdict === "seller_inventory_limit" ||
        profileDecision.verdict === "profile_likely_intermediary"
      ) {
        const enriched: { verdict: StoredSellerVerdict; evidence: string } = {
          verdict: profileDecision.verdict,
          evidence: listingClassified
            ? `${listingClassified.evidence}; ${profileDecision.evidence}`
            : profileDecision.evidence,
        };
        rememberVerdict(options.db, target, enriched, undefined, nowDirect);
        return decisionFromClassified(
          enriched,
          target.token,
          200,
          false,
          undefined,
          profilePolicies,
        );
      }

      if (
        listingClassified?.verdict === "confirmed_owner" &&
        profileInventoryClearedForOwner(profileDecision)
      ) {
        applyPositiveDetailOwner(listing, listingClassified);
        rememberVerdict(options.db, target, listingClassified, 200, nowDirect);
        return decisionFromClassified(
          listingClassified,
          target.token,
          200,
          false,
          undefined,
          profilePolicies,
        );
      }

      if (cachedOwnerDecision && profileInventoryClearedForOwner(profileDecision)) {
        rememberVerdict(
          options.db,
          target,
          {
            verdict: "confirmed_owner",
            evidence: cachedOwnerDecision.evidence ?? "cached OLX owner",
          },
          undefined,
          nowDirect,
        );
        return cachedOwnerDecision;
      }

      const unresolved: { verdict: StoredSellerVerdict; evidence: string } = {
        verdict: "unknown",
        evidence: listingClassified
          ? `${listingClassified.evidence}; ${profileDecision.evidence}`
          : profileDecision.evidence,
      };
      rememberVerdict(options.db, target, unresolved, undefined, nowDirect);
      applyPositiveDetailOwner(listing, listingClassified);
      if (businessDetailStillRequired(listing)) {
        const failClosed = {
          verdict: "confirmed_intermediary" as const,
          evidence: "business_without_positive_owner_evidence",
        };
        rememberVerdict(options.db, target, failClosed, undefined, nowDirect);
        return decisionFromClassified(
          failClosed,
          target.token,
          200,
          false,
          undefined,
          profilePolicies,
        );
      }
      return {
        outcome: "detail_unknown",
        drop: false,
        requested: false,
        externalId: target.token,
        evidence: unresolved.evidence,
      };
    }

    if (listing.source !== "lun") {
      return { outcome: "not_required", drop: false, requested: false };
    }
    const target = canonicalOlxDetailTarget(
      typeof listing.metadata?.originalUrl === "string" ? listing.metadata.originalUrl : undefined,
    );
    if (!target) {
      return { outcome: "not_required", drop: false, requested: false };
    }
    const peer = options.peers.find(
      (item) => item.source === "olx" && peerToken(item)?.toLowerCase() === target.token.toLowerCase(),
    );
    let peerInventoryEvaluatedBelowLimit = false;
    if (peer) {
      if (catalogRejectionIsTerminal(peer)) {
        return {
          outcome: "same_cycle_confirmed_agent",
          drop: true,
          requested: false,
          externalId: target.token,
          evidence: "same-cycle OLX listing is a confirmed intermediary",
        };
      }
      const peerYearRaw = peer.metadata?.accountRegistrationYear;
      const peerYear =
        typeof peerYearRaw === "number"
          ? peerYearRaw
          : typeof peerYearRaw === "string"
            ? Number(peerYearRaw)
            : undefined;
      if (
        typeof peerYear === "number" &&
        Number.isInteger(peerYear) &&
        !Number.isNaN(peerYear) &&
        sellerRegistrationYearRejectionReason(peerYear)
      ) {
        const nowPeer = options.now();
        rememberVerdict(
          options.db,
          target,
          {
            verdict: "seller_registration_year_2026",
            evidence: OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
          },
          undefined,
          nowPeer,
        );
        return {
          outcome: "same_cycle_registration_year_excluded",
          drop: true,
          requested: false,
          externalId: target.token,
          evidence: OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
        };
      }
      const peerInventoryRaw = peer.metadata?.distinctPreciseRealEstateProperties;
      const peerInventory =
        typeof peerInventoryRaw === "number"
          ? peerInventoryRaw
          : typeof peerInventoryRaw === "string"
            ? Number(peerInventoryRaw)
            : undefined;
      if (
        typeof peerInventory === "number" &&
        Number.isInteger(peerInventory) &&
        peerInventory >= SELLER_INVENTORY_LIMIT_MIN
      ) {
        const nowPeer = options.now();
        rememberVerdict(
          options.db,
          target,
          {
            verdict: "seller_inventory_limit",
            evidence: `${SELLER_INVENTORY_LIMIT_REASON};distinct_precise_properties=${peerInventory}`,
          },
          undefined,
          nowPeer,
        );
        return {
          outcome: "same_cycle_inventory_limit",
          drop: true,
          requested: false,
          externalId: target.token,
          evidence: SELLER_INVENTORY_LIMIT_REASON,
        };
      }
      if (
        typeof peerInventory === "number" &&
        Number.isInteger(peerInventory) &&
        peerInventory >= 0 &&
        peerInventory < SELLER_INVENTORY_LIMIT_MIN
      ) {
        peerInventoryEvaluatedBelowLimit = true;
      }
      // A missing inventory count is not clearance. Owner peers are resolved
      // only after this count is known to be below the exclusion.
    }
    const now = options.now();
    if (options.db) {
      const cached = readOlxSellerVerification(options.db, target.token, now);
      if (cached) {
        const fromCache = decisionFromStored(cached, target.token, profilePolicies);
        const cachedOwner = fromCache.outcome === "cache_confirmed_owner";
        // Cached unknown and cached owner both need a bounded inventory probe.
        // Intermediary, registration year, and inventory-limit rows stay terminal.
        if (fromCache.outcome !== "cache_unknown" && !cachedOwner) {
          return fromCache;
        }
        if (cachedOwner && profileProbes >= maxProfileProbes) {
          return {
            outcome: "detail_capacity_deferred",
            drop: false,
            requested: false,
            externalId: target.token,
            evidence: `olx_profile_probe_cap=${maxProfileProbes}`,
          };
        }
        if (profileProbes < maxProfileProbes) {
          profileProbes += 1;
          let snapshot: OlxProfileSnapshot;
          try {
            snapshot = await probeProfile({
              listingUrl: target.url,
              timeoutMs: options.timeoutMs,
            });
          } catch {
            return profileReadFailure(target, now, "transport", cached.lastHttpStatus ?? undefined);
          }
          let listingClassified: OlxHtmlSellerClassification | undefined;
          if (snapshot.listingHtml) {
            listingClassified = classifyOlxLinkedSellerHtml(snapshot.listingHtml, target.token);
            if (
              listingClassified.verdict === "confirmed_intermediary" ||
              listingClassified.verdict === "seller_registration_year_2026" ||
              listingClassified.verdict === "parser_failure"
            ) {
              rememberVerdict(
                options.db,
                target,
                listingClassified,
                cached.lastHttpStatus ?? 200,
                now,
              );
              return decisionFromClassified(
                listingClassified,
                target.token,
                cached.lastHttpStatus ?? 200,
                false,
                undefined,
                profilePolicies,
              );
            }
          }
          if (!snapshot.acquired) {
            return profileReadFailure(target, now, "parser", cached.lastHttpStatus ?? undefined);
          }
          const profileDecision = classifyOlxProfileInventory(snapshot, now);
          if (
            profileDecision.verdict === "seller_inventory_limit" ||
            profileDecision.verdict === "profile_likely_intermediary"
          ) {
            const enriched: { verdict: StoredSellerVerdict; evidence: string } = {
              verdict: profileDecision.verdict,
              evidence: `${fromCache.evidence ?? "cached OLX unknown"}; ${profileDecision.evidence}`,
            };
            rememberVerdict(options.db, target, enriched, cached.lastHttpStatus ?? 200, now);
            return decisionFromClassified(
              enriched,
              target.token,
              cached.lastHttpStatus ?? 200,
              false,
              undefined,
              profilePolicies,
            );
          }
          if (
            (listingClassified?.verdict === "confirmed_owner" || cachedOwner) &&
            profileInventoryClearedForOwner(profileDecision)
          ) {
            if (listingClassified?.verdict === "confirmed_owner") {
              rememberVerdict(
                options.db,
                target,
                listingClassified,
                cached.lastHttpStatus ?? 200,
                now,
              );
              return decisionFromClassified(
                listingClassified,
                target.token,
                cached.lastHttpStatus ?? 200,
                false,
                undefined,
                profilePolicies,
              );
            }
            rememberVerdict(
              options.db,
              target,
              {
                verdict: "confirmed_owner",
                evidence: fromCache.evidence ?? "cached OLX owner",
              },
              cached.lastHttpStatus ?? 200,
              now,
            );
            return fromCache;
          }
          const mergedEvidence = `${fromCache.evidence ?? "cached OLX unknown"}; ${
            listingClassified ? `${listingClassified.evidence}; ` : ""
          }${profileDecision.evidence}`;
          rememberVerdict(
            options.db,
            target,
            { verdict: "unknown", evidence: mergedEvidence },
            cached.lastHttpStatus ?? 200,
            now,
          );
          return {
            outcome: "detail_unknown",
            drop: false,
            requested: false,
            externalId: target.token,
            evidence: mergedEvidence,
            ...(cached.lastHttpStatus !== null ? { httpStatus: cached.lastHttpStatus } : {}),
          };
        }
        return fromCache;
      }
    }
    // Same-cycle positive clearance only when the peer is a platform-confirmed
    // owner AND inventory was already counted below the exclusion.
    // Owner evidence alone must not skip the profile probe.
    if (peer && isPlatformConfirmedOwner(peer) && peerInventoryEvaluatedBelowLimit) {
      return {
        outcome: "same_cycle_resolved",
        drop: false,
        requested: false,
        externalId: target.token,
        evidence: "same-cycle OLX peer is platform-confirmed owner",
      };
    }
    if (haltedAfterRateLimit) {
      return {
        outcome: "skipped_after_rate_limit",
        drop: false,
        requested: false,
        externalId: target.token,
        evidence: "detail verification skipped after HTTP 429 in this cycle",
      };
    }
    if (requests >= maxRequests) {
      return {
        outcome: "detail_capacity_deferred",
        drop: false,
        requested: false,
        externalId: target.token,
        evidence: `OLX linked detail cap ${maxRequests} reached`,
      };
    }
    const waited = Date.now() - lastRequestAt;
    if (lastRequestAt > 0 && waited < gapMs) {
      await new Promise((resolve) => setTimeout(resolve, gapMs - waited));
    }
    lastRequestAt = Date.now();
    requests += 1;
    let page: RieltorDetailPage;
    try {
      page = await fetchPage(target.url, options.timeoutMs);
    } catch (error) {
      const evidence = error instanceof Error ? error.message : "network error";
      return tryBrowserFallback(target, now, undefined, evidence);
    }
    if (page.status === 429) {
      haltedAfterRateLimit = true;
      if (options.db) {
        writeOlxSellerVerification(options.db, {
          externalId: target.token,
          canonicalUrl: target.url,
          verdict: "rate_limited",
          evidence: "HTTP 429",
          httpStatus: 429,
          now,
          ttlMs: TRANSIENT_SELLER_CACHE_MS,
        });
      }
      return {
        outcome: "detail_rate_limited",
        drop: false,
        requested: true,
        externalId: target.token,
        httpStatus: 429,
        evidence: "HTTP 429",
      };
    }
    if (olxRawTransportNeedsBrowserFallback(page.status)) {
      return tryBrowserFallback(target, now, page.status, `HTTP ${page.status}`);
    }
    if (page.status !== 200) {
      return rememberTransport(target, `HTTP ${page.status}`, page.status, now);
    }
    if (!trustedOlxFinalUrl(page.finalUrl, target.url)) {
      return rememberTransport(target, "final URL is not the requested OLX listing", page.status, now);
    }
    const classified = classifyOlxLinkedSellerHtml(page.bodyText, target.token);
    return applyProfileInventory(target, classified, page.bodyText, page.status, true, now);
  };
}
