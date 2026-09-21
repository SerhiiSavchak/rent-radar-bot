/**
 * Recorded owner-detail candidate from the baab323 diagnostic capture.
 * Not from the 75f7384 live catalog extract (that run stored no self-declared samples).
 */
export const OLX_OWNER_DETAIL_CANDIDATE = {
  sourceId: "924128798",
  /** Canonical offer URL recorded on the salvaged house ad. */
  url: "https://www.olx.ua/d/uk/obyavlenie/zdatsya-v-orendu-budinok-vd-vlasnika-ID10xy7c.html",
  generatingCommit: "baab3230824bc4e976cae50c6ad2c9ded2e91467",
  captureId: "capture-1789666022490",
  captureCategory: "houses" as const,
  captureStartedAt: "2026-09-17T17:28:22.151Z",
  catalogIsBusiness: false,
  catalogUserSellerType: null,
  catalogOwnerEvidenceLevel: "self_declared" as const,
  selectionReason:
    "Private account (isBusiness=false) with an explicit title self-declaration «від власника» in the baab323 house salvage. Not a 75f7384 live listing.",
} as const;
