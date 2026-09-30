import { SELLER_INVENTORY_LIMIT_MIN } from "../../delivery/seller-profile.ts";
import {
  classifyOlxProfileInventory,
  type OlxProfileSnapshot,
} from "./olx-seller-profile.ts";

export const OLX_PRECISE_AUDIT_BUCKETS = ["0-1", "2", "3", "4", "5-7", "8+"] as const;

export type OlxPreciseAuditBucket = (typeof OLX_PRECISE_AUDIT_BUCKETS)[number];

export type OlxSellerAuditInput = {
  sellerId: string;
  snapshot: OlxProfileSnapshot;
  evidenceFamilies?: string[];
};

export type OlxSellerAuditRow = {
  sellerId: string;
  listingCount: number;
  precisePropertyCount: number;
  coarseLocationCount: number;
  evidenceFamilies: string[];
  decision: string;
  hardRejectReason: string | null;
};

export type OlxPrivateSellerAuditReport = {
  threshold: number;
  thresholdChanged: false;
  buckets: Record<OlxPreciseAuditBucket, number>;
  sellers: OlxSellerAuditRow[];
};

export function preciseInventoryBucket(count: number): OlxPreciseAuditBucket {
  if (count <= 1) {
    return "0-1";
  }
  if (count === 2) {
    return "2";
  }
  if (count === 3) {
    return "3";
  }
  if (count === 4) {
    return "4";
  }
  if (count <= 7) {
    return "5-7";
  }
  return "8+";
}

function hardRejectReason(verdict: string): string | null {
  if (
    verdict === "seller_inventory_limit" ||
    verdict === "seller_registration_year_2026" ||
    verdict === "confirmed_intermediary"
  ) {
    return verdict;
  }
  return null;
}

/**
 * Local distribution of already-collected public profile snapshots.
 * Does not fetch OLX and does not change the precise-property threshold.
 */
export function summarizeOlxPrivateSellerAudit(
  rows: OlxSellerAuditInput[],
): OlxPrivateSellerAuditReport {
  const buckets = Object.fromEntries(OLX_PRECISE_AUDIT_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    OlxPreciseAuditBucket,
    number
  >;
  const sellers = rows.map((row) => {
    const decision = classifyOlxProfileInventory(row.snapshot);
    const precisePropertyCount = row.snapshot.precisePropertyKeys?.length ?? 0;
    const bucket = preciseInventoryBucket(precisePropertyCount);
    buckets[bucket] += 1;
    return {
      sellerId: row.sellerId,
      listingCount: row.snapshot.realEstateAds ?? row.snapshot.visibleAds ?? 0,
      precisePropertyCount,
      coarseLocationCount: row.snapshot.coarseLocationKeys?.length ?? 0,
      evidenceFamilies: row.evidenceFamilies ?? [],
      decision: decision.verdict,
      hardRejectReason: hardRejectReason(decision.verdict),
    };
  });
  return {
    threshold: SELLER_INVENTORY_LIMIT_MIN,
    thresholdChanged: false,
    buckets,
    sellers,
  };
}
