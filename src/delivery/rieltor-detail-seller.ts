import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import { classifyOwner, sellerRejectionReason } from "../filters/owner-filter.ts";
import { safeStoredError } from "../storage/source-health.ts";
import { httpGet } from "../utils/http.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RIELTOR_DETAIL_GAP_MS = 800;
export const CONFIRMED_SELLER_CACHE_MS = 30 * DAY_MS;
export const UNKNOWN_SELLER_CACHE_MS = DAY_MS;
export const TRANSIENT_SELLER_CACHE_MS = 6 * 60 * 60 * 1000;

const OWNER_LABEL = /^власник$/i;
const REALTOR_LABEL = /^рієлтор$/i;
const DETAIL_PATH = /^\/([a-z0-9-]+)\/(flats-rent|houses-rent)\/view\/(\d+)\/?$/i;

export type StoredSellerVerdict =
  | "confirmed_owner"
  | "confirmed_intermediary"
  | "unknown"
  | "rate_limited"
  | "transport_failure"
  | "parser_failure";

export type LinkedSellerOutcome =
  | "same_cycle_confirmed_agent"
  | "same_cycle_resolved"
  | "cache_confirmed_agent"
  | "cache_confirmed_owner"
  | "cache_unknown"
  | "detail_confirmed_agent"
  | "detail_confirmed_owner"
  | "detail_unknown"
  | "detail_rate_limited"
  | "detail_transport_failure"
  | "detail_parser_failure"
  | "skipped_after_rate_limit"
  | "not_required";

export type LinkedSellerDecision = {
  outcome: LinkedSellerOutcome;
  drop: boolean;
  /** True only when this call performed a detail HTTP request. */
  requested: boolean;
  externalId?: string;
  evidence?: string;
  httpStatus?: number;
};

export type RieltorDetailPage = {
  status: number;
  finalUrl: string;
  bodyText: string;
};

export type LinkedSellerVerificationCounts = {
  sameCycleConfirmedAgent: number;
  sameCycleResolved: number;
  cacheConfirmedAgent: number;
  cacheConfirmedOwner: number;
  cacheUnknown: number;
  detailConfirmedAgent: number;
  detailConfirmedOwner: number;
  detailUnknown: number;
  detailRateLimited: number;
  detailTransportFailure: number;
  detailParserFailure: number;
  skippedAfterRateLimit: number;
  notRequired: number;
  detailRequests: number;
};

export function emptyLinkedSellerVerification(): LinkedSellerVerificationCounts {
  return {
    sameCycleConfirmedAgent: 0,
    sameCycleResolved: 0,
    cacheConfirmedAgent: 0,
    cacheConfirmedOwner: 0,
    cacheUnknown: 0,
    detailConfirmedAgent: 0,
    detailConfirmedOwner: 0,
    detailUnknown: 0,
    detailRateLimited: 0,
    detailTransportFailure: 0,
    detailParserFailure: 0,
    skippedAfterRateLimit: 0,
    notRequired: 0,
    detailRequests: 0,
  };
}

/**
 * Accept only an https RIELTOR rent-detail path and rebuild the URL ourselves.
 * Query, hash, userinfo, and any other host are discarded.
 */
export function canonicalRieltorDetailTarget(
  raw: string | undefined,
): { id: string; url: string } | undefined {
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
  if (host !== "rieltor.ua" && host !== "www.rieltor.ua") {
    return undefined;
  }
  const match = DETAIL_PATH.exec(parsed.pathname);
  if (!match?.[1] || !match[2] || !match[3] || !/^\d+$/.test(match[3])) {
    return undefined;
  }
  const locality = match[1].toLowerCase();
  const category = match[2].toLowerCase();
  const id = match[3];
  return {
    id,
    url: `https://rieltor.ua/${locality}/${category}/view/${id}/`,
  };
}

export function classifyRieltorDetailSeller(html: string): {
  verdict: "confirmed_owner" | "confirmed_intermediary" | "unknown" | "parser_failure";
  evidence: string;
} {
  const position = elementText(html, "offer-view-rieltor-position");
  const agency = elementText(html, "offer-view-rieltor-agency-link");
  if (!position && !agency) {
    return { verdict: "parser_failure", evidence: "rieltor detail seller markers missing" };
  }
  const classification = classifyOwner({
    platformOwner: position !== undefined && OWNER_LABEL.test(position),
    platformAgent: position !== undefined && REALTOR_LABEL.test(position),
    ...(position ? { offerTypeLabel: position } : {}),
    ...(agency ? { agencyName: agency } : {}),
    extraEvidence: [
      ...(position ? [`RIELTOR detail role = ${position}`] : []),
      ...(agency ? [`RIELTOR detail agency = ${agency}`] : []),
    ],
  });
  if (
    sellerRejectionReason({
      sellerType: classification.sellerType,
      metadata: { ownerEvidenceLevel: classification.ownerEvidenceLevel },
    })
  ) {
    const evidence = [
      position ? `role=${position}` : undefined,
      agency ? `agency=${agency}` : undefined,
    ]
      .filter((item): item is string => Boolean(item))
      .join("; ");
    return { verdict: "confirmed_intermediary", evidence: evidence || "confirmed intermediary" };
  }
  if (classification.sellerType === "owner") {
    return {
      verdict: "confirmed_owner",
      evidence: position ? `role=${position}` : "confirmed owner",
    };
  }
  return {
    verdict: "unknown",
    evidence: position ? `role=${position}` : "rieltor detail role unresolved",
  };
}

/**
 * Seller markers are trusted only when the response is still the same canonical
 * RIELTOR detail listing. www and a stripped query are the same listing; another
 * id, the homepage, or another host is not.
 */
export function trustedRieltorFinalUrl(finalUrl: string, requestedUrl: string): boolean {
  const expected = canonicalRieltorDetailTarget(requestedUrl);
  const actual = canonicalRieltorDetailTarget(finalUrl);
  if (!expected || !actual) {
    return false;
  }
  return actual.url === expected.url;
}

type CacheRow = {
  sellerVerdict: StoredSellerVerdict;
  sellerEvidence: string | null;
  expiresAt: string;
  lastHttpStatus: number | null;
};

export function readSellerVerification(
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
       WHERE source = 'rieltor' AND external_listing_id = ?`,
    )
    .get(externalId) as CacheRow | undefined;
  if (!row) {
    return undefined;
  }
  if (Date.parse(row.expiresAt) <= now.getTime()) {
    return undefined;
  }
  return row;
}

export function writeSellerVerification(
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
     ) VALUES ('rieltor', ?, ?, ?, ?, ?, ?, ?, ?)
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

export function deleteExpiredSellerVerifications(db: DatabaseSync, now: Date): number {
  const result = db
    .prepare("DELETE FROM external_seller_verifications WHERE expires_at < ?")
    .run(now.toISOString());
  return Number(result.changes);
}

export async function fetchRieltorDetailPage(
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

export function createCycleRieltorSellerVerifier(options: {
  db?: DatabaseSync | undefined;
  peers: Listing[];
  now: () => Date;
  timeoutMs: number;
  gapMs?: number;
  fetchPage?: ((url: string, timeoutMs: number) => Promise<RieltorDetailPage>) | undefined;
}): (listing: Listing) => Promise<LinkedSellerDecision> {
  let haltedAfterRateLimit = false;
  let lastRequestAt = 0;
  const fetchPage = options.fetchPage ?? fetchRieltorDetailPage;
  const gapMs = options.gapMs ?? RIELTOR_DETAIL_GAP_MS;

  return async (listing) => {
    if (listing.source !== "lun") {
      return { outcome: "not_required", drop: false, requested: false };
    }
    const target = canonicalRieltorDetailTarget(
      typeof listing.metadata?.originalUrl === "string" ? listing.metadata.originalUrl : undefined,
    );
    if (!target) {
      return { outcome: "not_required", drop: false, requested: false };
    }
    const peer = options.peers.find(
      (item) => item.source === "rieltor" && item.sourceId === target.id,
    );
    if (peer) {
      if (sellerRejectionReason(peer)) {
        return {
          outcome: "same_cycle_confirmed_agent",
          drop: true,
          requested: false,
          externalId: target.id,
          evidence: "same-cycle RIELTOR listing is a confirmed intermediary",
        };
      }
      if (peer.sellerType === "owner") {
        return {
          outcome: "same_cycle_resolved",
          drop: false,
          requested: false,
          externalId: target.id,
          evidence: "same-cycle RIELTOR listing is a confirmed owner",
        };
      }
    }
    const now = options.now();
    if (options.db) {
      const cached = readSellerVerification(options.db, target.id, now);
      if (cached) {
        return decisionFromStored(cached, target.id);
      }
    }
    if (haltedAfterRateLimit) {
      return {
        outcome: "skipped_after_rate_limit",
        drop: false,
        requested: false,
        externalId: target.id,
        evidence: "detail verification skipped after HTTP 429 in this cycle",
      };
    }
    const waited = Date.now() - lastRequestAt;
    if (lastRequestAt > 0 && waited < gapMs) {
      await new Promise((resolve) => setTimeout(resolve, gapMs - waited));
    }
    lastRequestAt = Date.now();
    let page: RieltorDetailPage;
    try {
      page = await fetchPage(target.url, options.timeoutMs);
    } catch (error) {
      const evidence = error instanceof Error ? error.message : "network error";
      remember(
        options.db,
        target,
        "transport_failure",
        evidence,
        undefined,
        now,
        TRANSIENT_SELLER_CACHE_MS,
      );
      return {
        outcome: "detail_transport_failure",
        drop: false,
        requested: true,
        externalId: target.id,
        evidence: safeStoredError(evidence, "transport_failure") ?? "transport_failure",
      };
    }
    if (page.status === 429) {
      haltedAfterRateLimit = true;
      remember(options.db, target, "rate_limited", "HTTP 429", 429, now, TRANSIENT_SELLER_CACHE_MS);
      return {
        outcome: "detail_rate_limited",
        drop: false,
        requested: true,
        externalId: target.id,
        httpStatus: 429,
        evidence: "HTTP 429",
      };
    }
    if (page.status === 403 || page.status >= 500 || page.status === 408) {
      remember(
        options.db,
        target,
        "transport_failure",
        `HTTP ${page.status}`,
        page.status,
        now,
        TRANSIENT_SELLER_CACHE_MS,
      );
      return {
        outcome: "detail_transport_failure",
        drop: false,
        requested: true,
        externalId: target.id,
        httpStatus: page.status,
        evidence: `HTTP ${page.status}`,
      };
    }
    if (page.status !== 200) {
      remember(
        options.db,
        target,
        "transport_failure",
        `HTTP ${page.status}`,
        page.status,
        now,
        TRANSIENT_SELLER_CACHE_MS,
      );
      return {
        outcome: "detail_transport_failure",
        drop: false,
        requested: true,
        externalId: target.id,
        httpStatus: page.status,
        evidence: `HTTP ${page.status}`,
      };
    }
    if (!trustedRieltorFinalUrl(page.finalUrl, target.url)) {
      remember(
        options.db,
        target,
        "transport_failure",
        "final URL is not the requested RIELTOR listing",
        page.status,
        now,
        TRANSIENT_SELLER_CACHE_MS,
      );
      return {
        outcome: "detail_transport_failure",
        drop: false,
        requested: true,
        externalId: target.id,
        httpStatus: page.status,
        evidence: "final URL is not the requested RIELTOR listing",
      };
    }
    const classified = classifyRieltorDetailSeller(page.bodyText);
    if (classified.verdict === "parser_failure") {
      remember(
        options.db,
        target,
        "parser_failure",
        classified.evidence,
        200,
        now,
        TRANSIENT_SELLER_CACHE_MS,
      );
      return {
        outcome: "detail_parser_failure",
        drop: false,
        requested: true,
        externalId: target.id,
        httpStatus: 200,
        evidence: classified.evidence,
      };
    }
    const ttl =
      classified.verdict === "unknown" ? UNKNOWN_SELLER_CACHE_MS : CONFIRMED_SELLER_CACHE_MS;
    remember(options.db, target, classified.verdict, classified.evidence, 200, now, ttl);
    if (classified.verdict === "confirmed_intermediary") {
      return {
        outcome: "detail_confirmed_agent",
        drop: true,
        requested: true,
        externalId: target.id,
        httpStatus: 200,
        evidence: classified.evidence,
      };
    }
    if (classified.verdict === "confirmed_owner") {
      return {
        outcome: "detail_confirmed_owner",
        drop: false,
        requested: true,
        externalId: target.id,
        httpStatus: 200,
        evidence: classified.evidence,
      };
    }
    return {
      outcome: "detail_unknown",
      drop: false,
      requested: true,
      externalId: target.id,
      httpStatus: 200,
      evidence: classified.evidence,
    };
  };
}

function decisionFromStored(row: CacheRow, externalId: string): LinkedSellerDecision {
  if (row.sellerVerdict === "confirmed_intermediary") {
    return {
      outcome: "cache_confirmed_agent",
      drop: true,
      requested: false,
      externalId,
      ...(row.sellerEvidence ? { evidence: row.sellerEvidence } : {}),
    };
  }
  if (row.sellerVerdict === "confirmed_owner") {
    return {
      outcome: "cache_confirmed_owner",
      drop: false,
      requested: false,
      externalId,
      ...(row.sellerEvidence ? { evidence: row.sellerEvidence } : {}),
    };
  }
  if (row.sellerVerdict === "unknown") {
    return { outcome: "cache_unknown", drop: false, requested: false, externalId };
  }
  if (row.sellerVerdict === "rate_limited") {
    return {
      outcome: "detail_rate_limited",
      drop: false,
      requested: false,
      externalId,
      ...(row.lastHttpStatus !== null ? { httpStatus: row.lastHttpStatus } : {}),
      evidence: "cached HTTP 429",
    };
  }
  if (row.sellerVerdict === "parser_failure") {
    return {
      outcome: "detail_parser_failure",
      drop: false,
      requested: false,
      externalId,
      evidence: "cached parser failure",
    };
  }
  return {
    outcome: "detail_transport_failure",
    drop: false,
    requested: false,
    externalId,
    evidence: "cached transport failure",
  };
}

function remember(
  db: DatabaseSync | undefined,
  target: { id: string; url: string },
  verdict: StoredSellerVerdict,
  evidence: string,
  httpStatus: number | undefined,
  now: Date,
  ttlMs: number,
): void {
  if (!db) {
    return;
  }
  writeSellerVerification(db, {
    externalId: target.id,
    canonicalUrl: target.url,
    verdict,
    evidence,
    now,
    ttlMs,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  });
}

function elementText(html: string, className: string): string | undefined {
  const pattern = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</`, "i");
  const raw = pattern.exec(html)?.[1];
  if (!raw) {
    return undefined;
  }
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}
