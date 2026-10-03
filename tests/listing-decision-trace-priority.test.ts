import { describe, expect, it } from "vitest";
import {
  LISTING_DECISION_TRACE_CYCLE_CAP,
  selectListingDecisionTraceRows,
  type ListingDecisionRecord,
  type ListingDecisionStage,
} from "../src/delivery/listing-decision-trace.ts";

function row(
  source: string,
  sourceId: string,
  stage: ListingDecisionStage,
  reasonCode: string,
): ListingDecisionRecord {
  return { cycleId: 7, source, sourceId, stage, reasonCode };
}

describe("listing decision trace priority", () => {
  it("keeps rare post-dedupe rows when bulk rejects exceed the cap", () => {
    const sources = ["domria", "lun", "olx", "rieltor"] as const;
    const rows: ListingDecisionRecord[] = [];
    for (const source of sources) {
      for (let i = 0; i < 900; i += 1) {
        rows.push(row(source, `${source}-seller-${i}`, "rejected_seller", "intermediary"));
        rows.push(row(source, `${source}-geo-${i}`, "rejected_geo", "outside_radius"));
      }
      for (let i = 0; i < 200; i += 1) {
        rows.push(row(source, `${source}-other-${i}`, "rejected_other", "filter"));
        rows.push(row(source, `${source}-collected-${i}`, "collected", "source_fetch"));
        rows.push(row(source, `${source}-collected-${i}`, "normalized", "listing_object"));
      }
    }
    rows.push(row("olx", "936671739", "suppressed_freshness", "late_discovered"));
    rows.push(row("lun", "hold-1", "held", "detail_transport_failure"));
    rows.push(row("domria", "dup-1", "deduped", "confirmed_duplicate"));
    rows.push(row("rieltor", "fail-1", "delivery_failed", "send_error"));
    rows.push(row("olx", "linked-1", "rejected_seller", "cache_confirmed_agent"));

    expect(rows.length).toBeGreaterThan(LISTING_DECISION_TRACE_CYCLE_CAP);
    const selected = selectListingDecisionTraceRows(rows, LISTING_DECISION_TRACE_CYCLE_CAP);
    expect(selected.kept).toHaveLength(LISTING_DECISION_TRACE_CYCLE_CAP);
    expect(selected.dropped).toBe(rows.length - LISTING_DECISION_TRACE_CYCLE_CAP);

    const keptKey = (source: string, sourceId: string, stage: ListingDecisionStage) =>
      selected.kept.some(
        (item) => item.source === source && item.sourceId === sourceId && item.stage === stage,
      );
    expect(keptKey("olx", "936671739", "suppressed_freshness")).toBe(true);
    expect(keptKey("lun", "hold-1", "held")).toBe(true);
    expect(keptKey("domria", "dup-1", "deduped")).toBe(true);
    expect(keptKey("rieltor", "fail-1", "delivery_failed")).toBe(true);
    expect(keptKey("olx", "linked-1", "rejected_seller")).toBe(true);

    const bulkBySource = new Map<string, number>();
    for (const item of selected.kept) {
      const bulk =
        item.reasonCode === "intermediary" ||
        item.stage === "rejected_geo" ||
        item.stage === "rejected_other";
      if (!bulk) {
        continue;
      }
      bulkBySource.set(item.source, (bulkBySource.get(item.source) ?? 0) + 1);
    }
    const counts = sources.map((source) => bulkBySource.get(source) ?? 0);
    expect(Math.min(...counts)).toBeGreaterThan(50);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});
