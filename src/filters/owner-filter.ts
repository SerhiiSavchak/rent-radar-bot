import type { SellerConfidence, SellerType } from "../domain/listing.ts";
import {
  hasExplicitIntermediaryText,
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

export type SellerPolicy = "reject_intermediaries" | "owner_only";

export type OwnerClassification = {
  sellerType: SellerType;
  confidence: SellerConfidence;
  sellerEvidence: string[];
  ownerEvidenceLevel: OwnerEvidenceLevel;
  /** True only for platform-confirmed owners. Never set from private-account or text. */
  filterConsidersPrivateOwner: boolean;
  /**
   * True for a clean self-declaration (explicit claim, no stronger intermediary evidence).
   * Display as a listing claim, never as platform verification.
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
  /** Used only by the legacy owner_only policy. */
  acceptSelfDeclared?: boolean;
};

export type SellerEligibilityOptions = {
  policy?: SellerPolicy;
  /** Used only when policy is owner_only. */
  acceptSelfDeclared?: boolean;
};

function hasAgencyMarker(signals: OwnerSignals): boolean {
  if (signals.agencyName && signals.agencyName.trim()) {
    return true;
  }
  const id = signals.agencyId;
  return id !== undefined && id !== null && id !== 0 && id !== "";
}

function emptyClassification(
  sellerType: SellerType,
  level: OwnerEvidenceLevel,
  evidence: string[],
  extras: Partial<OwnerClassification> = {},
): OwnerClassification {
  return {
    sellerType,
    confidence: evidence.length > 0 ? (sellerType === "owner" || sellerType === "agent" || sellerType === "business" ? "high" : "low") : "unknown",
    sellerEvidence: evidence,
    ownerEvidenceLevel: level,
    filterConsidersPrivateOwner: false,
    filterConsidersSelfDeclaredOwner: false,
    ...extras,
  };
}

/**
 * Owner detection is evidence-based.
 * Title/description phrases never promote sellerType to owner by themselves.
 * Generic business/private account flags are not agency or ownership proof.
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
  if (signals.platformBusiness === true) {
    evidence.push("platform seller type = business");
  }
  if (signals.isBusiness === true) {
    evidence.push("platform account type = business (not proof of agency/realtor status)");
  }
  if (signals.offerTypeLabel) {
    evidence.push(`platform offer type = ${signals.offerTypeLabel}`);
  }
  if (signals.agencyId !== undefined && signals.agencyId !== null && signals.agencyId !== 0 && signals.agencyId !== "") {
    evidence.push(`platform agency id = ${String(signals.agencyId)}`);
  }
  if (signals.agencyName && signals.agencyName.trim()) {
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
  if (text && hasExplicitIntermediaryText(text)) {
    evidence.push("listing text contains explicit agency/realtor self-description or commission offer");
  }

  const uniqueEvidence = [...new Set(evidence)];
  const agency = hasAgencyMarker(signals);
  const agentCopy = Boolean(text && hasExplicitIntermediaryText(text));
  const explicitIntermediaryRole =
    signals.platformAgent === true || signals.platformBusiness === true || agency || agentCopy;
  const ownerClaim = hasExplicitSelfDeclaredOwnerText(text);
  const selfDeclared = ownerClaim && !explicitIntermediaryRole;

  if (signals.platformAgent === true) {
    return emptyClassification("agent", ownerClaim ? "conflict" : "intermediary", uniqueEvidence, {
      confidence: "high",
    });
  }

  if (signals.platformBusiness === true) {
    return emptyClassification("business", ownerClaim ? "conflict" : "intermediary", uniqueEvidence, {
      confidence: "high",
    });
  }

  if (signals.platformOwner === true) {
    return emptyClassification("owner", "platform_confirmed", uniqueEvidence, {
      confidence: "high",
      filterConsidersPrivateOwner: true,
    });
  }

  if (agency || agentCopy) {
    return emptyClassification("unknown", ownerClaim ? "conflict" : "intermediary", uniqueEvidence);
  }

  if (selfDeclared) {
    return emptyClassification("unknown", "self_declared", uniqueEvidence, {
      confidence: "medium",
      filterConsidersSelfDeclaredOwner: true,
    });
  }

  if (signals.platformPrivate === true) {
    return emptyClassification("unknown", "private_unknown", uniqueEvidence);
  }

  return emptyClassification("unknown", "private_unknown", uniqueEvidence);
}

export function isOwnerOnlyMatch(classification: Pick<OwnerClassification, "sellerType">): boolean {
  return classification.sellerType === "owner";
}

/**
 * Legacy OWNER_ONLY gate: platform-confirmed owners only.
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

export function sellerRejectionReason(listing: {
  sellerType: SellerType;
  metadata?: Record<string, unknown> | undefined;
}): string | undefined {
  const level = listing.metadata?.ownerEvidenceLevel;
  if (level === "conflict") {
    return "explicit_intermediary_conflicts_with_owner_claim";
  }
  if (level === "intermediary") {
    return "explicit_intermediary";
  }
  if (listing.sellerType === "agent") {
    return "platform_agent";
  }
  if (listing.sellerType === "business") {
    return "platform_business_role";
  }
  return undefined;
}

/**
 * Approved delivery gate: allow confirmed owners, self-declared claims, and unknown
 * sellers; reject only explicit realtor/agency/intermediary evidence.
 * Legacy owner_only remains available but is never the default.
 */
export function isSellerEligible(
  listing: {
    sellerType: SellerType;
    metadata?: Record<string, unknown> | undefined;
  },
  options: SellerEligibilityOptions = {},
): boolean {
  const policy = options.policy ?? "reject_intermediaries";
  if (policy === "owner_only") {
    return isOwnerEligible(listing, { acceptSelfDeclared: options.acceptSelfDeclared === true });
  }
  return sellerRejectionReason(listing) === undefined;
}

export type SellerDecisionBucket = "owner" | "self_declared" | "unknown" | "intermediary";

export function sellerDecisionBucket(listing: {
  sellerType: SellerType;
  metadata?: Record<string, unknown> | undefined;
}): SellerDecisionBucket {
  if (sellerRejectionReason(listing)) {
    return "intermediary";
  }
  if (listing.sellerType === "owner") {
    return "owner";
  }
  if (listing.metadata?.ownerEvidenceLevel === "self_declared") {
    return "self_declared";
  }
  return "unknown";
}
