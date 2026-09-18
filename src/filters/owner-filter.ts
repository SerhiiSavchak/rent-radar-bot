import type { SellerConfidence, SellerType } from "../domain/listing.ts";
import {
  hasAgentText,
  hasExplicitSelfDeclaredOwnerText,
  hasMisleadingOwnerSeekingText,
  hasOwnerText,
} from "../utils/text-evidence.ts";

export type OwnerEvidenceLevel =
  | "platform_confirmed"
  | "self_declared"
  | "private_unknown"
  | "intermediary"
  | "conflict";

export type OwnerClassification = {
  sellerType: SellerType;
  confidence: SellerConfidence;
  sellerEvidence: string[];
  ownerEvidenceLevel: OwnerEvidenceLevel;
  /** True only for platform-confirmed owners. Never set from private-account or text. */
  filterConsidersPrivateOwner: boolean;
  /**
   * True for a clean self-declaration (private account + explicit claim, no agency).
   * The default OWNER_ONLY gate ignores this unless OWNER_ACCEPT_SELF_DECLARED=true.
   */
  filterConsidersSelfDeclaredOwner: boolean;
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

export type OwnerEligibilityOptions = {
  /** Default false — self-declared text never silently passes OWNER_ONLY. */
  acceptSelfDeclared?: boolean;
};

function hasAgencyMarker(signals: OwnerSignals): boolean {
  if (signals.agencyName) {
    return true;
  }
  const id = signals.agencyId;
  return id !== undefined && id !== null && id !== 0 && id !== "";
}

/**
 * Owner detection is evidence-based.
 * Title/description phrases never promote sellerType to owner by themselves.
 */
export function classifyOwner(signals: OwnerSignals): OwnerClassification {
  const evidence = [...(signals.extraEvidence ?? [])];
  const text = signals.text;

  if (signals.platformOwner === true) {
    evidence.push("platform seller type = owner");
  }
  if (signals.platformPrivate === true) {
    evidence.push("platform private account flag (not proof of property ownership)");
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
  if (text && hasMisleadingOwnerSeekingText(text)) {
    evidence.push("listing text seeks an owner / asks owners to contact (not a self-declaration)");
  }
  if (text && hasExplicitSelfDeclaredOwnerText(text)) {
    evidence.push("listing text contains an explicit self-declared owner claim");
  } else if (text && hasOwnerText(text)) {
    evidence.push("listing text contains owner/no-intermediary phrasing");
  }
  if (text && hasAgentText(text)) {
    evidence.push("listing text contains agency/realtor phrasing");
  }

  const uniqueEvidence = [...new Set(evidence)];
  const business = signals.platformBusiness === true || signals.isBusiness === true;
  const agency = hasAgencyMarker(signals);
  const agentCopy = Boolean(text && hasAgentText(text));
  const selfDeclared =
    hasExplicitSelfDeclaredOwnerText(text) &&
    signals.platformPrivate === true &&
    !business &&
    signals.platformAgent !== true &&
    !agentCopy &&
    !agency;

  if (business) {
    const conflict = hasExplicitSelfDeclaredOwnerText(text);
    return {
      sellerType: "business",
      confidence: "high",
      sellerEvidence: uniqueEvidence,
      ownerEvidenceLevel: conflict ? "conflict" : "intermediary",
      filterConsidersPrivateOwner: false,
      filterConsidersSelfDeclaredOwner: false,
    };
  }

  if (signals.platformOwner === true) {
    return {
      sellerType: "owner",
      confidence: "high",
      sellerEvidence: uniqueEvidence,
      ownerEvidenceLevel: "platform_confirmed",
      filterConsidersPrivateOwner: true,
      filterConsidersSelfDeclaredOwner: false,
    };
  }

  if (signals.platformAgent === true) {
    return {
      sellerType: "agent",
      confidence: "high",
      sellerEvidence: uniqueEvidence,
      ownerEvidenceLevel: hasExplicitSelfDeclaredOwnerText(text) ? "conflict" : "intermediary",
      filterConsidersPrivateOwner: false,
      filterConsidersSelfDeclaredOwner: false,
    };
  }

  if (selfDeclared) {
    return {
      sellerType: "unknown",
      confidence: "medium",
      sellerEvidence: uniqueEvidence,
      ownerEvidenceLevel: "self_declared",
      filterConsidersPrivateOwner: false,
      filterConsidersSelfDeclaredOwner: true,
    };
  }

  if (agency || agentCopy) {
    const conflict = hasExplicitSelfDeclaredOwnerText(text);
    return {
      sellerType: "unknown",
      confidence: uniqueEvidence.length > 0 ? "low" : "unknown",
      sellerEvidence: uniqueEvidence,
      ownerEvidenceLevel: conflict ? "conflict" : "intermediary",
      filterConsidersPrivateOwner: false,
      filterConsidersSelfDeclaredOwner: false,
    };
  }

  if (signals.platformPrivate === true) {
    return {
      sellerType: "unknown",
      confidence: uniqueEvidence.length > 0 ? "low" : "unknown",
      sellerEvidence: uniqueEvidence,
      ownerEvidenceLevel: "private_unknown",
      filterConsidersPrivateOwner: false,
      filterConsidersSelfDeclaredOwner: false,
    };
  }

  return {
    sellerType: "unknown",
    confidence: uniqueEvidence.length > 0 ? "low" : "unknown",
    sellerEvidence: uniqueEvidence,
    ownerEvidenceLevel: "private_unknown",
    filterConsidersPrivateOwner: false,
    filterConsidersSelfDeclaredOwner: false,
  };
}

export function isOwnerOnlyMatch(classification: Pick<OwnerClassification, "sellerType">): boolean {
  return classification.sellerType === "owner";
}

/**
 * Delivery gate. Default matches OWNER_ONLY + platform-confirmed owners only.
 * Self-declared listings pass only when acceptSelfDeclared is explicitly true.
 */
export function isOwnerEligible(
  listing: {
    sellerType: SellerType;
    metadata?: Record<string, unknown> | undefined;
  },
  options: OwnerEligibilityOptions = {},
): boolean {
  if (listing.sellerType === "owner") {
    return true;
  }
  if (options.acceptSelfDeclared === true && listing.metadata?.ownerEvidenceLevel === "self_declared") {
    return true;
  }
  return false;
}
