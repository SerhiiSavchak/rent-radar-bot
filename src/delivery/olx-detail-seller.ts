import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import { sellerRejectionReason, classifyOwner } from "../filters/owner-filter.ts";
import { safeStoredError } from "../storage/source-health.ts";
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
    sellerIdentityName: company || sellerName,
    text: `${title}\n${description}\n${sellerName ?? ""}`,
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

export function createCycleOlxSellerVerifier(options: {
  db?: DatabaseSync | undefined;
  peers: Listing[];
  now: () => Date;
  timeoutMs: number;
  gapMs?: number;
  maxRequests?: number;
  fetchPage?: ((url: string, timeoutMs: number) => Promise<RieltorDetailPage>) | undefined;
}): (listing: Listing) => Promise<LinkedSellerDecision> {
  let haltedAfterRateLimit = false;
  let lastRequestAt = 0;
  let requests = 0;
  const fetchPage = options.fetchPage ?? fetchOlxDetailPage;
  const gapMs = options.gapMs ?? OLX_DETAIL_GAP_MS;
  const maxRequests = options.maxRequests ?? OLX_LINKED_DETAIL_CAP;

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
      if (options.db) {
        writeOlxSellerVerification(options.db, {
          externalId: target.token,
          canonicalUrl: target.url,
          verdict: "transport_failure",
          evidence,
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
      };
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
    if (page.status === 403 || page.status >= 500 || page.status === 408) {
      if (options.db) {
        writeOlxSellerVerification(options.db, {
          externalId: target.token,
          canonicalUrl: target.url,
          verdict: "transport_failure",
          evidence: `HTTP ${page.status}`,
          httpStatus: page.status,
          now,
          ttlMs: TRANSIENT_SELLER_CACHE_MS,
        });
      }
      return {
        outcome: "detail_transport_failure",
        drop: false,
        requested: true,
        externalId: target.token,
        httpStatus: page.status,
        evidence: `HTTP ${page.status}`,
      };
    }
    if (page.status !== 200) {
      if (options.db) {
        writeOlxSellerVerification(options.db, {
          externalId: target.token,
          canonicalUrl: target.url,
          verdict: "transport_failure",
          evidence: `HTTP ${page.status}`,
          httpStatus: page.status,
          now,
          ttlMs: TRANSIENT_SELLER_CACHE_MS,
        });
      }
      return {
        outcome: "detail_transport_failure",
        drop: false,
        requested: true,
        externalId: target.token,
        httpStatus: page.status,
        evidence: `HTTP ${page.status}`,
      };
    }
    if (!trustedOlxFinalUrl(page.finalUrl, target.url)) {
      return {
        outcome: "detail_transport_failure",
        drop: false,
        requested: true,
        externalId: target.token,
        httpStatus: page.status,
        evidence: "final URL is not the requested OLX listing",
      };
    }
    const classified = classifyOlxLinkedSellerHtml(page.bodyText, target.token);
    const ttl =
      classified.verdict === "confirmed_intermediary" || classified.verdict === "confirmed_owner"
        ? CONFIRMED_SELLER_CACHE_MS
        : classified.verdict === "unknown"
          ? UNKNOWN_SELLER_CACHE_MS
          : TRANSIENT_SELLER_CACHE_MS;
    if (options.db) {
      writeOlxSellerVerification(options.db, {
        externalId: target.token,
        canonicalUrl: target.url,
        verdict: classified.verdict,
        evidence: classified.evidence,
        httpStatus: page.status,
        now,
        ttlMs: ttl,
      });
    }
    if (classified.verdict === "confirmed_intermediary") {
      return {
        outcome: "detail_confirmed_agent",
        drop: true,
        requested: true,
        externalId: target.token,
        httpStatus: page.status,
        evidence: classified.evidence,
      };
    }
    if (classified.verdict === "confirmed_owner") {
      return {
        outcome: "detail_confirmed_owner",
        drop: false,
        requested: true,
        externalId: target.token,
        httpStatus: page.status,
        evidence: classified.evidence,
      };
    }
    if (classified.verdict === "parser_failure") {
      return {
        outcome: "detail_parser_failure",
        drop: false,
        requested: true,
        externalId: target.token,
        httpStatus: page.status,
        evidence: classified.evidence,
      };
    }
    return {
      outcome: "detail_unknown",
      drop: false,
      requested: true,
      externalId: target.token,
      httpStatus: page.status,
      evidence: classified.evidence,
    };
  };
}
