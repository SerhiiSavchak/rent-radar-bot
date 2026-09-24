import type { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import type { Listing } from "../domain/listing.ts";
import { sellerRejectionReason, classifyOwner } from "../filters/owner-filter.ts";
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

export function classifyOlxLinkedSellerHtml(
  html: string,
  token: string,
): { verdict: StoredSellerVerdict; evidence: string } {
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
    platformBusiness: lowerType === "business",
    platformPrivate: business === false,
    isBusiness: business === true,
    agencyName: company,
    sellerIdentityName: sellerName,
    text: `${title}\n${description}`,
  });
  if (sellerRejectionReason({ sellerType: owner.sellerType, metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel } })) {
    return {
      verdict: "confirmed_intermediary",
      evidence: owner.sellerEvidence.join("; ") || "linked OLX seller is intermediary",
    };
  }
  if (owner.sellerType === "owner" || owner.ownerEvidenceLevel === "platform_confirmed") {
    return {
      verdict: "confirmed_owner",
      evidence: owner.sellerEvidence.join("; ") || "linked OLX seller is owner",
    };
  }
  return {
    verdict: "unknown",
    evidence: owner.sellerEvidence.join("; ") || "linked OLX seller unresolved",
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
      input.verdict === "unknown"
      ? null
      : safeStoredError(input.evidence, input.verdict),
  );
}

function decisionFromStored(row: CacheRow, token: string): LinkedSellerDecision {
  if (row.sellerVerdict === "confirmed_intermediary") {
    return {
      outcome: "cache_confirmed_agent",
      drop: true,
      requested: false,
      externalId: token,
      evidence: row.sellerEvidence ?? "cached OLX intermediary",
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
  timedOut: boolean;
  notes: string[];
};

/** Raw HTTP statuses where stock Playwright may still open the exact listing. */
export function olxRawTransportNeedsBrowserFallback(status: number): boolean {
  return status === 403 || status === 408 || status >= 500;
}

/**
 * One stock Chromium launch for the exact canonical OLX listing URL only.
 * No profile crawl, no pagination, no stealth.
 */
export async function fetchOlxLinkedDetailViaBrowser(
  url: string,
  timeoutMs: number,
): Promise<OlxLinkedBrowserDetailPage> {
  const notes: string[] = ["transport=stock_playwright_exact_listing"];
  const launchMs = Math.min(OLX_LINKED_BROWSER_LAUNCH_MS, timeoutMs);
  const navMs = Math.min(OLX_LINKED_BROWSER_NAV_MS, timeoutMs);
  const bodyMs = Math.min(OLX_LINKED_BROWSER_BODY_MS, timeoutMs);
  const pendingLaunch = chromium.launch({ headless: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserClosed = true;
  let browserCloseTimedOut = false;
  let timedOut = false;
  let status = 0;
  let finalUrl = url;
  let bodyText = "";
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
            timedOut = true;
            notes.push("body_read_timeout");
            bodyText = await page.content().catch(() => "");
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
        finalUrl = page.url();
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      timedOut = true;
    }
    notes.push(`browser_failed:${message.slice(0, 120)}`);
    void pendingLaunch.then((opened) => opened.close()).catch(() => undefined);
  } finally {
    if (browser) {
      try {
        await awaitWithTimeout(browser.close(), OLX_LINKED_BROWSER_CLOSE_MS, "olx.linked.chromium.close");
        browserClosed = true;
      } catch {
        browserCloseTimedOut = true;
        browserClosed = false;
        notes.push("browser_close_timeout");
        void browser.close().catch(() => undefined);
      }
    }
  }
  return {
    status: status || (timedOut ? 408 : 0),
    finalUrl,
    bodyText,
    browserClosed,
    browserCloseTimedOut,
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
): LinkedSellerDecision {
  const evidence = evidencePrefix
    ? `${evidencePrefix}; ${classified.evidence}`
    : classified.evidence;
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
    classified.verdict === "confirmed_intermediary" || classified.verdict === "confirmed_owner"
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
  fetchPage?: ((url: string, timeoutMs: number) => Promise<RieltorDetailPage>) | undefined;
  fetchViaBrowser?:
    | ((url: string, timeoutMs: number) => Promise<OlxLinkedBrowserDetailPage>)
    | undefined;
}): (listing: Listing) => Promise<LinkedSellerDecision> {
  let haltedAfterRateLimit = false;
  let lastRequestAt = 0;
  let requests = 0;
  let browserFallbacks = 0;
  const fetchPage = options.fetchPage ?? fetchOlxDetailPage;
  const fetchViaBrowser = options.fetchViaBrowser ?? fetchOlxLinkedDetailViaBrowser;
  const gapMs = options.gapMs ?? OLX_DETAIL_GAP_MS;
  const maxRequests = options.maxRequests ?? OLX_LINKED_DETAIL_CAP;
  const maxBrowserFallbacks = options.maxBrowserFallbacks ?? OLX_LINKED_BROWSER_FALLBACK_CAP;

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
      return rememberTransport(
        target,
        `${rawEvidence}; browser fallback cap ${maxBrowserFallbacks} reached`,
        rawStatus,
        now,
      );
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
    if (browserPage.timedOut || browserPage.status === 0 || browserPage.status >= 400) {
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
    rememberVerdict(options.db, target, classified, browserPage.status, now);
    return decisionFromClassified(
      classified,
      target.token,
      browserPage.status,
      true,
      `browser fallback after ${rawEvidence}`,
    );
  };

  return async (listing) => {
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
    if (peer) {
      if (sellerRejectionReason(peer)) {
        return {
          outcome: "same_cycle_confirmed_agent",
          drop: true,
          requested: false,
          externalId: target.token,
          evidence: "same-cycle OLX listing is a confirmed intermediary",
        };
      }
      return {
        outcome: "same_cycle_resolved",
        drop: false,
        requested: false,
        externalId: target.token,
        evidence: "same-cycle OLX listing already available; no strong intermediary",
      };
    }
    const now = options.now();
    if (options.db) {
      const cached = readOlxSellerVerification(options.db, target.token, now);
      if (cached) {
        return decisionFromStored(cached, target.token);
      }
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
        outcome: "detail_transport_failure",
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
    rememberVerdict(options.db, target, classified, page.status, now);
    return decisionFromClassified(classified, target.token, page.status, true);
  };
}
