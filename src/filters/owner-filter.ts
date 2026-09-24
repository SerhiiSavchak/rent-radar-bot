import type { SellerConfidence, SellerType } from "../domain/listing.ts";
import {
  classifySellerText,
  hasExplicitIntermediaryText,
  hasExplicitSelfDeclaredOwnerText,
  hasMisleadingOwnerSeekingText,
  hasOwnerText,
  type SellerTextLevel,
} from "../utils/text-evidence.ts";

export type OwnerEvidenceLevel =
  "platform_confirmed" | "self_declared" | "private_unknown" | "intermediary" | "conflict";

export type SellerPolicy = "reject_intermediaries" | "owner_only";

export type SellerEvidenceStrength = "strong" | "weak" | "context";

export type SellerEvidenceItem = {
  source: string;
  type: string;
  value: string;
  strength: SellerEvidenceStrength;
};

/**
 * Conceptual seller states. Delivery still follows `isSellerEligible`.
 * `likely_agent` is reserved for a weak intermediary hint that must stay sendable.
 * v1 does not emit it: OLX `isBusiness` and a LUN external site name stay `unknown`.
 * Evidence the existing gate already treats as an explicit intermediary is `confirmed_agent`.
 */
export type SellerAssessmentState =
  "confirmed_owner" | "likely_owner" | "unknown" | "likely_agent" | "confirmed_agent";

export type SellerAssessment = {
  state: SellerAssessmentState;
  confidence: SellerConfidence;
  evidence: SellerEvidenceItem[];
  /** Approved default policy (`reject_intermediaries`), not the legacy owner-only gate. */
  send: boolean;
};

export type OwnerClassification = {
  sellerType: SellerType;
  confidence: SellerConfidence;
  sellerEvidence: string[];
  evidenceItems: SellerEvidenceItem[];
  ownerEvidenceLevel: OwnerEvidenceLevel;
  /** True only for platform-confirmed owners. Never set from private-account or text. */
  filterConsidersPrivateOwner: boolean;
  /**
   * True for a clean self-declaration (explicit claim, no stronger intermediary evidence).
   * Display as a listing claim, never as platform verification.
   */
  filterConsidersSelfDeclaredOwner: boolean;
  /** Text layer only. Structured intermediary evidence stays on ownerEvidenceLevel. */
  sellerTextLevel: SellerTextLevel;
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
  items: SellerEvidenceItem[],
  extras: Partial<OwnerClassification> = {},
): OwnerClassification {
  return {
    sellerType,
    confidence:
      evidence.length > 0
        ? sellerType === "owner" || sellerType === "agent" || sellerType === "business"
          ? "high"
          : "low"
        : "unknown",
    sellerEvidence: evidence,
    evidenceItems: items,
    ownerEvidenceLevel: level,
    filterConsidersPrivateOwner: false,
    filterConsidersSelfDeclaredOwner: false,
    sellerTextLevel: "unknown",
    ...extras,
  };
}

/**
 * Owner detection is evidence-based.
 * Title/description phrases never promote sellerType to owner by themselves.
 * Generic business/private account flags are not agency or ownership proof.
 */
function pushItem(items: SellerEvidenceItem[], item: SellerEvidenceItem): void {
  items.push(item);
}

export function classifyOwner(signals: OwnerSignals): OwnerClassification {
  const evidence = [...(signals.extraEvidence ?? [])];
  const items: SellerEvidenceItem[] = [];
  for (const note of signals.extraEvidence ?? []) {
    pushItem(items, { source: "adapter", type: "note", value: note, strength: "context" });
  }
  const text = signals.text;

  if (signals.platformOwner === true) {
    evidence.push("platform seller type = owner");
    pushItem(items, { source: "platform", type: "owner_flag", value: "owner", strength: "strong" });
  }
  if (signals.platformPrivate === true) {
    evidence.push("platform private account flag (not proof of property ownership)");
    pushItem(items, {
      source: "account",
      type: "private_flag",
      value: "true",
      strength: "context",
    });
  }
  if (signals.platformAgent === true) {
    evidence.push("platform seller type = agent");
    pushItem(items, {
      source: "platform",
      type: "seller_role",
      value: "agent",
      strength: "strong",
    });
  }
  if (signals.platformBusiness === true) {
    evidence.push("platform seller type = business");
    pushItem(items, {
      source: "platform",
      type: "seller_role",
      value: "business",
      strength: "strong",
    });
  }
  if (signals.isBusiness === true) {
    evidence.push("platform account type = business (not proof of agency/realtor status)");
    pushItem(items, {
      source: "account",
      type: "business_flag",
      value: "true",
      strength: "weak",
    });
  }
  if (signals.offerTypeLabel) {
    evidence.push(`platform offer type = ${signals.offerTypeLabel}`);
    pushItem(items, {
      source: "platform",
      type: "offer_label",
      value: signals.offerTypeLabel,
      strength: "context",
    });
  }
  if (
    signals.agencyId !== undefined &&
    signals.agencyId !== null &&
    signals.agencyId !== 0 &&
    signals.agencyId !== ""
  ) {
    evidence.push(`platform agency id = ${String(signals.agencyId)}`);
    pushItem(items, {
      source: "platform",
      type: "agency_id",
      value: String(signals.agencyId),
      strength: "strong",
    });
  }
  if (signals.agencyName && signals.agencyName.trim()) {
    evidence.push(`platform agency name = ${signals.agencyName}`);
    pushItem(items, {
      source: "platform",
      type: "agency_name",
      value: signals.agencyName.trim(),
      strength: "strong",
    });
  }
  if (signals.withoutCommission === true) {
    evidence.push("platform flag withoutCommission = true (not the same as owner)");
    pushItem(items, {
      source: "platform",
      type: "without_commission",
      value: "true",
      strength: "context",
    });
  }
  if (text && hasMisleadingOwnerSeekingText(text)) {
    evidence.push("listing text seeks an owner / asks owners to contact (not a self-declaration)");
    pushItem(items, {
      source: "listing_text",
      type: "owner_seeking",
      value: "seeks_owner",
      strength: "context",
    });
  }
  if (text && hasExplicitSelfDeclaredOwnerText(text)) {
    evidence.push("listing text contains an explicit self-declared owner claim");
    pushItem(items, {
      source: "listing_text",
      type: "self_declared_owner",
      value: "explicit_owner_claim",
      strength: "weak",
    });
  } else if (text && hasOwnerText(text)) {
    evidence.push("listing text contains owner/no-intermediary phrasing");
    pushItem(items, {
      source: "listing_text",
      type: "owner_phrasing",
      value: "weak_owner_phrasing",
      strength: "weak",
    });
  }
  if (text && hasExplicitIntermediaryText(text)) {
    evidence.push(
      "listing text contains explicit agency/realtor self-description or commission offer",
    );
    pushItem(items, {
      source: "listing_text",
      type: "intermediary_self_description",
      value: "explicit_intermediary",
      strength: "strong",
    });
  }

  const judged = classifySellerText(text);
  if (judged.level === "confirmed") {
    evidence.push(`seller text confirmed: ${judged.strongSignals.join(", ")}`);
  } else if (judged.level === "likely") {
    evidence.push(`seller text likely: ${judged.supportingFamilies.join("+")}`);
  }
  for (const context of judged.ownerContextSignals) {
    evidence.push(`seller text owner-context: ${context}`);
  }
  const uniqueEvidence = [...new Set(evidence)];
  const agency = hasAgencyMarker(signals);
  const agentCopy = judged.level === "confirmed";
  const explicitIntermediaryRole =
    signals.platformAgent === true || signals.platformBusiness === true || agency || agentCopy;
  const ownerClaim = hasExplicitSelfDeclaredOwnerText(text);
  const selfDeclared = ownerClaim && !explicitIntermediaryRole && judged.level !== "likely";
  const textLevel =
    judged.level === "likely" && !explicitIntermediaryRole ? "likely" : judged.level;
  if (signals.platformOwner === true && explicitIntermediaryRole) {
    uniqueEvidence.push("platform-confirmed owner overrides intermediary evidence");
  }

  if (signals.platformOwner === true) {
    return emptyClassification("owner", "platform_confirmed", uniqueEvidence, items, {
      confidence: "high",
      filterConsidersPrivateOwner: true,
      sellerTextLevel: "unknown",
    });
  }

  if (signals.platformAgent === true) {
    return emptyClassification(
      "agent",
      ownerClaim ? "conflict" : "intermediary",
      uniqueEvidence,
      items,
      {
        confidence: "high",
      },
    );
  }

  if (signals.platformBusiness === true) {
    return emptyClassification(
      "business",
      ownerClaim ? "conflict" : "intermediary",
      uniqueEvidence,
      items,
      {
        confidence: "high",
      },
    );
  }

  if (agency || agentCopy) {
    return emptyClassification(
      "unknown",
      ownerClaim ? "conflict" : "intermediary",
      uniqueEvidence,
      items,
      { sellerTextLevel: "confirmed" },
    );
  }

  if (selfDeclared) {
    return emptyClassification("unknown", "self_declared", uniqueEvidence, items, {
      confidence: "medium",
      filterConsidersSelfDeclaredOwner: true,
    });
  }

  if (signals.platformPrivate === true) {
    return emptyClassification("unknown", "private_unknown", uniqueEvidence, items, {
      sellerTextLevel: textLevel === "likely" ? "likely" : "unknown",
    });
  }

  return emptyClassification("unknown", "private_unknown", uniqueEvidence, items, {
    sellerTextLevel: textLevel === "likely" ? "likely" : "unknown",
  });
}

const ASSESSMENT_STATES = new Set<SellerAssessmentState>([
  "confirmed_owner",
  "likely_owner",
  "unknown",
  "likely_agent",
  "confirmed_agent",
]);

export function sellerAssessmentFromClassification(
  classification: OwnerClassification,
): SellerAssessment {
  let state: SellerAssessmentState;
  if (classification.sellerType === "owner") {
    state = "confirmed_owner";
  } else if (classification.sellerType === "agent" || classification.sellerType === "business") {
    state = "confirmed_agent";
  } else if (
    classification.ownerEvidenceLevel === "intermediary" ||
    classification.ownerEvidenceLevel === "conflict"
  ) {
    state = "confirmed_agent";
  } else if (classification.ownerEvidenceLevel === "self_declared") {
    state = "likely_owner";
  } else {
    state = "unknown";
  }
  const send = state !== "confirmed_agent";
  return {
    state,
    confidence: classification.confidence,
    evidence: classification.evidenceItems,
    send,
  };
}

export function sellerAnnotation(classification: OwnerClassification): {
  sellerAssessment: SellerAssessment;
  sellerTextLevel?: "likely";
} {
  return {
    sellerAssessment: sellerAssessmentFromClassification(classification),
    ...(classification.sellerTextLevel === "likely" ? { sellerTextLevel: "likely" as const } : {}),
  };
}

function isEvidenceItem(value: unknown): value is SellerEvidenceItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<SellerEvidenceItem>;
  return (
    typeof item.source === "string" &&
    typeof item.type === "string" &&
    typeof item.value === "string" &&
    (item.strength === "strong" || item.strength === "weak" || item.strength === "context")
  );
}

export function sellerAssessmentFromListing(listing: {
  sellerType: SellerType;
  sellerConfidence?: SellerConfidence | undefined;
  sellerEvidence?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}): SellerAssessment {
  const stored = listing.metadata?.sellerAssessment;
  if (stored && typeof stored === "object") {
    const record = stored as Partial<SellerAssessment>;
    if (record.state && ASSESSMENT_STATES.has(record.state) && typeof record.send === "boolean") {
      const evidence = Array.isArray(record.evidence) ? record.evidence.filter(isEvidenceItem) : [];
      return {
        state: record.state,
        confidence:
          record.confidence === "high" ||
          record.confidence === "medium" ||
          record.confidence === "low" ||
          record.confidence === "unknown"
            ? record.confidence
            : "unknown",
        evidence,
        send: record.send,
      };
    }
  }
  const level = listing.metadata?.ownerEvidenceLevel;
  const ownerEvidenceLevel: OwnerEvidenceLevel =
    level === "platform_confirmed" ||
    level === "self_declared" ||
    level === "private_unknown" ||
    level === "intermediary" ||
    level === "conflict"
      ? level
      : "private_unknown";
  const assessment = sellerAssessmentFromClassification({
    sellerType: listing.sellerType,
    confidence: listing.sellerConfidence ?? "unknown",
    sellerEvidence: listing.sellerEvidence ?? [],
    evidenceItems: [],
    ownerEvidenceLevel,
    filterConsidersPrivateOwner: listing.metadata?.filterConsidersPrivateOwner === true,
    filterConsidersSelfDeclaredOwner: listing.metadata?.filterConsidersSelfDeclaredOwner === true,
    sellerTextLevel: listing.metadata?.sellerTextLevel === "likely" ? "likely" : "unknown",
  });
  if (
    assessment.evidence.length === 0 &&
    listing.sellerEvidence &&
    listing.sellerEvidence.length > 0
  ) {
    return {
      ...assessment,
      evidence: listing.sellerEvidence.map((value) => ({
        source: "listing",
        type: "recorded_signal",
        value,
        strength: "context" as const,
      })),
    };
  }
  return assessment;
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
  if (
    options.acceptSelfDeclared === true &&
    listing.metadata?.ownerEvidenceLevel === "self_declared"
  ) {
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
