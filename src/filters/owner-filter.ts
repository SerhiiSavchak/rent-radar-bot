import type { SellerConfidence, SellerType } from "../domain/listing.ts";
import { hasOwnerText } from "../utils/text-evidence.ts";

export type OwnerClassification = {
  sellerType: SellerType;
  confidence: SellerConfidence;
  sellerEvidence: string[];
  filterConsidersPrivateOwner: boolean;
};

export type OwnerSignals = {
  platformOwner?: boolean | undefined;
  platformAgent?: boolean | undefined;
  platformBusiness?: boolean | undefined;
  platformPrivate?: boolean | undefined;
  offerTypeLabel?: string | undefined;
  agencyId?: number | string | null | undefined;
  agencyName?: string | null | undefined;
  isBusiness?: boolean | undefined;
  withoutCommission?: boolean | undefined;
  text?: string | undefined;
  extraEvidence?: string[] | undefined;
};

/**
 * Owner detection is evidence-based.
 * Title/description phrases never promote sellerType to owner by themselves.
 */
export function classifyOwner(signals: OwnerSignals): OwnerClassification {
  const evidence = [...(signals.extraEvidence ?? [])];

  if (signals.platformOwner === true) {
    evidence.push("platform seller type = owner");
  }
  if (signals.platformPrivate === true) {
    evidence.push("platform seller type = private");
  }
  if (signals.platformAgent === true) {
    evidence.push("platform seller type = agent");
  }
  if (signals.platformBusiness === true || signals.isBusiness === true) {
    evidence.push("platform seller type = business");
  }
  if (signals.offerTypeLabel) {
    evidence.push(`platform offer type = ${signals.offerTypeLabel}`);
  }
  if (signals.agencyId !== undefined && signals.agencyId !== null && signals.agencyId !== 0 && signals.agencyId !== "") {
    evidence.push(`platform agency id = ${String(signals.agencyId)}`);
  }
  if (signals.agencyName) {
    evidence.push(`platform agency name = ${signals.agencyName}`);
  }
  if (signals.withoutCommission === true) {
    evidence.push("platform flag withoutCommission = true (not the same as owner)");
  }
  if (signals.text && hasOwnerText(signals.text)) {
    evidence.push("listing text contains owner/no-intermediary phrasing");
  }

  const uniqueEvidence = [...new Set(evidence)];

  if (signals.platformBusiness === true || signals.isBusiness === true) {
    return {
      sellerType: "business",
      confidence: "high",
      sellerEvidence: uniqueEvidence,
      filterConsidersPrivateOwner: false,
    };
  }

  if (
    signals.platformAgent === true ||
    (signals.agencyId !== undefined && signals.agencyId !== null && signals.agencyId !== 0 && signals.agencyId !== "")
  ) {
    return {
      sellerType: "agent",
      confidence: "high",
      sellerEvidence: uniqueEvidence,
      filterConsidersPrivateOwner: false,
    };
  }

  const strongOwner = signals.platformOwner === true || signals.platformPrivate === true;
  if (strongOwner) {
    return {
      sellerType: "owner",
      confidence: "high",
      sellerEvidence: uniqueEvidence,
      filterConsidersPrivateOwner: true,
    };
  }

  return {
    sellerType: "unknown",
    confidence: uniqueEvidence.length > 0 ? "low" : "unknown",
    sellerEvidence: uniqueEvidence,
    filterConsidersPrivateOwner: false,
  };
}

export function isOwnerOnlyMatch(classification: Pick<OwnerClassification, "sellerType">): boolean {
  return classification.sellerType === "owner";
}
