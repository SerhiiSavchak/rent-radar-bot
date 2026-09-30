import { describe, expect, it } from "vitest";
import { summarizeOlxPrivateSellerAudit } from "../src/sources/olx/olx-seller-audit.ts";
import type { OlxProfileSnapshot } from "../src/sources/olx/olx-seller-profile.ts";

function snap(precise: string[], coarse: string[] = []): OlxProfileSnapshot {
  return {
    acquired: true,
    totalPages: 1,
    totalElements: precise.length + coarse.length,
    visibleAds: precise.length + coarse.length,
    realEstateAds: precise.length + coarse.length,
    precisePropertyKeys: precise,
    coarseLocationKeys: coarse,
    propertyKeys: precise.length > 0 ? precise : coarse,
    pagesFetched: 1,
  };
}

describe("OLX private seller audit", () => {
  it("buckets precise inventory and keeps threshold 5", () => {
    const report = summarizeOlxPrivateSellerAudit([
      { sellerId: "a", snapshot: snap(["p1"]), evidenceFamilies: [] },
      { sellerId: "b", snapshot: snap(["p1", "p2"]) },
      { sellerId: "c", snapshot: snap(["p1", "p2", "p3"], ["c1"]), evidenceFamilies: ["inventory"] },
      { sellerId: "d", snapshot: snap(["p1", "p2", "p3", "p4"]) },
      { sellerId: "e", snapshot: snap(["p1", "p2", "p3", "p4", "p5"]) },
      { sellerId: "f", snapshot: snap(["1", "2", "3", "4", "5", "6", "7", "8"]) },
      { sellerId: "g", snapshot: snap([], ["c1", "c2", "c3"]) },
    ]);
    expect(report.threshold).toBe(5);
    expect(report.thresholdChanged).toBe(false);
    expect(report.buckets).toEqual({ "0-1": 2, "2": 1, "3": 1, "4": 1, "5-7": 1, "8+": 1 });
    const byId = Object.fromEntries(report.sellers.map((row) => [row.sellerId, row]));
    expect(byId.c?.decision).toBe("unknown");
    expect(byId.c?.hardRejectReason).toBeNull();
    expect(byId.c?.precisePropertyCount).toBe(3);
    expect(byId.c?.evidenceFamilies).toEqual(["inventory"]);
    expect(byId.d?.decision).toBe("unknown");
    expect(byId.e?.decision).toBe("seller_inventory_limit");
    expect(byId.e?.hardRejectReason).toBe("seller_inventory_limit");
    expect(byId.g?.precisePropertyCount).toBe(0);
    expect(byId.g?.coarseLocationCount).toBe(3);
    expect(byId.g?.decision).toBe("unknown");
    expect(byId.g?.hardRejectReason).toBeNull();
  });
});
