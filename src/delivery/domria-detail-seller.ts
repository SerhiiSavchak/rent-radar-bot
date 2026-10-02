import type { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import { sellerRejectionReason } from "../filters/owner-filter.ts";
import { extractInitialStateJson } from "../sources/domria/domria.parser.ts";
import {
  loadDomriaExactListing,
  type DomriaFetchResponse,
} from "../sources/domria/domria-newest.ts";
import { safeStoredError } from "../storage/source-health.ts";
import { httpGet } from "../utils/http.ts";
import {
  CONFIRMED_SELLER_CACHE_MS,
  decisionFromStored,
  readSellerVerification,
  TRANSIENT_SELLER_CACHE_MS,
  UNKNOWN_SELLER_CACHE_MS,
  writeSellerVerification,
  type LinkedSellerDecision,
  type StoredSellerVerdict,
} from "./rieltor-detail-seller.ts";

export const DOMRIA_DETAIL_GAP_MS = 800;

const LISTING_PATH = /^\/uk\/.+-(\d{6,})\.html$/i;

/**
 * Accept only an https DOM.RIA listing path and keep the canonical id from that path.
 * Query, hash, userinfo, and any other host are discarded. No property-level matching.
 */
export function canonicalDomriaDetailTarget(
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
  if (host !== "dom.ria.com" && host !== "www.dom.ria.com") {
    return undefined;
  }
  const match = LISTING_PATH.exec(parsed.pathname);
  const id = match?.[1];
  if (!id || !/^\d+$/.test(id)) {
    return undefined;
  }
  return { id, url: `https://dom.ria.com${parsed.pathname}` };
}

function listingEvidence(listing: Listing, fallback: string): string {
  const parts = (listing.sellerEvidence ?? []).map((item) => item.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : fallback;
}

function decisionFromListing(
  listing: Listing,
  externalId: string,
  requested: boolean,
  sameCycle: boolean,
): LinkedSellerDecision {
  const evidence = listingEvidence(
    listing,
    sameCycle ? "same-cycle DOM.RIA seller unresolved" : "DOM.RIA seller unresolved",
  );
  if (sellerRejectionReason(listing)) {
    return {
      outcome: sameCycle ? "same_cycle_confirmed_agent" : "detail_confirmed_agent",
      drop: true,
      requested,
      externalId,
      evidence,
    };
  }
  if (listing.sellerType === "owner") {
    return {
      outcome: sameCycle ? "same_cycle_resolved" : "detail_confirmed_owner",
      drop: false,
      requested,
      externalId,
      evidence,
    };
  }
  return {
    outcome: "detail_unknown",
    drop: false,
    requested,
    externalId,
    evidence,
  };
}

function verdictOf(decision: LinkedSellerDecision): StoredSellerVerdict {
  if (
    decision.outcome === "detail_confirmed_agent" ||
    decision.outcome === "same_cycle_confirmed_agent"
  ) {
    return "confirmed_intermediary";
  }
  if (decision.outcome === "detail_confirmed_owner" || decision.outcome === "same_cycle_resolved") {
    return "confirmed_owner";
  }
  if (decision.outcome === "detail_rate_limited") {
    return "rate_limited";
  }
  if (decision.outcome === "detail_parser_failure") {
    return "parser_failure";
  }
  if (decision.outcome === "detail_transport_failure") {
    return "transport_failure";
  }
  return "unknown";
}

function remember(
  db: DatabaseSync | undefined,
  target: { id: string; url: string },
  decision: LinkedSellerDecision,
  now: Date,
): void {
  if (!db) {
    return;
  }
  const verdict = verdictOf(decision);
  const ttl =
    verdict === "unknown"
      ? UNKNOWN_SELLER_CACHE_MS
      : verdict === "confirmed_owner" || verdict === "confirmed_intermediary"
        ? CONFIRMED_SELLER_CACHE_MS
        : TRANSIENT_SELLER_CACHE_MS;
  writeSellerVerification(db, {
    source: "domria",
    externalId: target.id,
    canonicalUrl: target.url,
    verdict,
    evidence: decision.evidence ?? verdict,
    now,
    ttlMs: ttl,
    ...(decision.httpStatus !== undefined ? { httpStatus: decision.httpStatus } : {}),
  });
}

async function fetchDomriaDetailPage(url: string, timeoutMs: number): Promise<DomriaFetchResponse> {
  const response = await httpGet(url, {
    timeoutMs,
    maxRetries: 0,
    retryOn: () => false,
  });
  return { status: response.status, url: response.url, bodyText: response.bodyText };
}

export function createCycleDomriaSellerVerifier(options: {
  db?: DatabaseSync | undefined;
  peers: Listing[];
  now: () => Date;
  timeoutMs: number;
  gapMs?: number;
  fetchPage?: ((url: string, timeoutMs: number) => Promise<DomriaFetchResponse>) | undefined;
}): (listing: Listing) => Promise<LinkedSellerDecision> {
  let haltedAfterRateLimit = false;
  let lastRequestAt = 0;
  const fetchPage = options.fetchPage ?? fetchDomriaDetailPage;
  const gapMs = options.gapMs ?? DOMRIA_DETAIL_GAP_MS;

  return async (listing) => {
    if (listing.source !== "lun") {
      return { outcome: "not_required", drop: false, requested: false };
    }
    const target = canonicalDomriaDetailTarget(
      typeof listing.metadata?.originalUrl === "string" ? listing.metadata.originalUrl : undefined,
    );
    if (!target) {
      return { outcome: "not_required", drop: false, requested: false };
    }
    const peer = options.peers.find(
      (item) => item.source === "domria" && item.sourceId === target.id,
    );
    if (peer) {
      return decisionFromListing(peer, target.id, false, true);
    }
    const now = options.now();
    if (options.db) {
      const cached = readSellerVerification(options.db, target.id, now, "domria");
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
    const loaded = await loadDomriaExactListing(
      target.id,
      (url) => fetchPage(url, options.timeoutMs),
      extractInitialStateJson,
      now,
    );
    if (!loaded.ok) {
      if (loaded.status === 429) {
        haltedAfterRateLimit = true;
        const decision: LinkedSellerDecision = {
          outcome: "detail_rate_limited",
          drop: false,
          requested: true,
          externalId: target.id,
          httpStatus: 429,
          evidence: "HTTP 429",
        };
        remember(options.db, target, decision, now);
        return decision;
      }
      if (loaded.parserFailure) {
        const decision: LinkedSellerDecision = {
          outcome: "detail_parser_failure",
          drop: false,
          requested: true,
          externalId: target.id,
          ...(loaded.status !== undefined ? { httpStatus: loaded.status } : {}),
          evidence: "DOM.RIA detail structure is unusable",
        };
        remember(options.db, target, decision, now);
        return decision;
      }
      const evidence =
        loaded.status !== undefined ? `HTTP ${loaded.status}` : "DOM.RIA detail transport failure";
      const decision: LinkedSellerDecision = {
        outcome: "detail_transport_failure",
        drop: false,
        requested: true,
        externalId: target.id,
        ...(loaded.status !== undefined ? { httpStatus: loaded.status } : {}),
        evidence: safeStoredError(evidence, "transport_failure") ?? "transport_failure",
      };
      remember(options.db, target, decision, now);
      return decision;
    }
    const decision = decisionFromListing(loaded.listing, target.id, true, false);
    remember(options.db, target, { ...decision, httpStatus: 200 }, now);
    return decision;
  };
}
