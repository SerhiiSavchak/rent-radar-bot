/**
 * Pure evidence helpers for the read-only Business coverage audit.
 * `isBusiness` is intentionally not an input: account type is not ownership.
 */
import { sellerRegistrationYearRejectionReason } from "../sources/olx/olx-account-registration.ts";
import { SELLER_INVENTORY_LIMIT_MIN } from "../delivery/seller-profile.ts";
import {
  classifySellerIdentityName,
  classifySellerText,
  hasExplicitIntermediaryText,
  hasExplicitSelfDeclaredOwnerText,
  hasMisleadingOwnerSeekingText,
} from "../utils/text-evidence.ts";

export type AuditOutcome =
  | "CONFIRMED_OWNER"
  | "SELF_DECLARED_OWNER"
  | "CONFIRMED_INTERMEDIARY"
  | "LIKELY_INTERMEDIARY"
  | "AMBIGUOUS"
  | "REJECT_REGISTRATION_YEAR_2026"
  | "REJECT_INVENTORY_LIMIT"
  | "DATA_UNAVAILABLE";

export type IdentityRow = {
  sourceId: string;
  token?: string;
  url?: string;
};

export function classifyBusinessCoverageEvidence(input: {
  sellerType?: string | null;
  companyName?: string;
  sellerName?: string;
  text: string;
  registrationYear?: number;
  preciseProperties?: number | null;
  detailUnavailable?: boolean;
}): { outcome: AuditOutcome; reasons: string[] } {
  const reasons: string[] = [];
  if (input.detailUnavailable === true) {
    return { outcome: "DATA_UNAVAILABLE", reasons: ["detail or profile evidence was not readable"] };
  }
  if (sellerRegistrationYearRejectionReason(input.registrationYear)) {
    reasons.push(`registration year ${input.registrationYear}`);
    return { outcome: "REJECT_REGISTRATION_YEAR_2026", reasons };
  }
  if ((input.preciseProperties ?? 0) >= SELLER_INVENTORY_LIMIT_MIN) {
    reasons.push(`precise properties ${input.preciseProperties}`);
    return { outcome: "REJECT_INVENTORY_LIMIT", reasons };
  }
  const sellerType = input.sellerType?.trim().toLowerCase();
  const identity = classifySellerIdentityName(input.companyName ?? input.sellerName);
  const text = classifySellerText(input.text);
  const explicitIntermediary = hasExplicitIntermediaryText(input.text);
  const selfDeclared = hasExplicitSelfDeclaredOwnerText(input.text);
  const seeksOwner = hasMisleadingOwnerSeekingText(input.text);
  const intermediary =
    sellerType === "agent" ||
    sellerType === "agency" ||
    sellerType === "intermediary" ||
    identity.level === "confirmed" ||
    explicitIntermediary ||
    text.level === "confirmed";
  if (sellerType === "owner" && intermediary) {
    reasons.push("platform sellerType=owner conflicts with intermediary evidence");
    return { outcome: "CONFIRMED_INTERMEDIARY", reasons };
  }
  if (sellerType === "owner") {
    reasons.push("platform user.sellerType=owner");
    return { outcome: "CONFIRMED_OWNER", reasons };
  }
  if (intermediary) {
    if (sellerType === "agent" || sellerType === "agency" || sellerType === "intermediary") {
      reasons.push(`platform user.sellerType=${sellerType}`);
    }
    if (identity.level === "confirmed") {
      reasons.push(`seller identity confirmed: ${identity.strongSignals.join(", ")}`);
    }
    if (explicitIntermediary) {
      reasons.push("explicit intermediary text");
    }
    if (text.level === "confirmed") {
      reasons.push(`seller text confirmed: ${text.strongSignals.join(", ")}`);
    }
    return { outcome: "CONFIRMED_INTERMEDIARY", reasons };
  }
  if (text.level === "likely") {
    reasons.push(`seller text likely: ${text.supportingFamilies.join("+")}`);
    return { outcome: "LIKELY_INTERMEDIARY", reasons };
  }
  if (selfDeclared && !seeksOwner) {
    reasons.push("explicit self-declared owner text");
    return { outcome: "SELF_DECLARED_OWNER", reasons };
  }
  if (seeksOwner) {
    reasons.push("text seeks an owner");
  }
  reasons.push("no platform owner marker and no non-business intermediary evidence");
  return { outcome: "AMBIGUOUS", reasons };
}

export function hasPositiveOwnerSignal(input: {
  sellerType?: string | null;
  text: string;
}): boolean {
  if (input.sellerType?.trim().toLowerCase() === "owner") {
    return true;
  }
  if (hasMisleadingOwnerSeekingText(input.text)) {
    return false;
  }
  if (hasExplicitSelfDeclaredOwnerText(input.text)) {
    return true;
  }
  return /(?:^|[^\p{L}\p{N}_])(?:власник|власниц|собственник|хозяин)(?![\p{L}\p{N}_])/iu.test(input.text);
}

export function crosscheckIdentities(privateRows: IdentityRow[], businessRows: IdentityRow[]) {
  const privateIds = new Set(privateRows.map((row) => row.sourceId));
  const businessIds = new Set(businessRows.map((row) => row.sourceId));
  const onlyPrivate: string[] = [];
  const onlyBusiness: string[] = [];
  const idOverlap: string[] = [];
  for (const id of privateIds) {
    if (businessIds.has(id)) {
      idOverlap.push(id);
    } else {
      onlyPrivate.push(id);
    }
  }
  for (const id of businessIds) {
    if (!privateIds.has(id)) {
      onlyBusiness.push(id);
    }
  }
  const privateTokens = new Map<string, string>();
  const businessTokens = new Map<string, string>();
  for (const row of privateRows) {
    if (row.token) {
      privateTokens.set(row.token.toLowerCase(), row.sourceId);
    }
  }
  for (const row of businessRows) {
    if (row.token) {
      businessTokens.set(row.token.toLowerCase(), row.sourceId);
    }
  }
  const tokenOverlap: string[] = [];
  for (const token of privateTokens.keys()) {
    if (businessTokens.has(token)) {
      tokenOverlap.push(token);
    }
  }
  const privateUrls = new Set(
    privateRows.map((row) => row.url?.split("?")[0]?.toLowerCase()).filter((url): url is string => Boolean(url)),
  );
  const urlOverlap = businessRows
    .map((row) => row.url?.split("?")[0]?.toLowerCase())
    .filter((url): url is string => Boolean(url && privateUrls.has(url)));
  return {
    onlyPrivate,
    onlyBusiness,
    idOverlap,
    tokenOverlap,
    urlOverlap: [...new Set(urlOverlap)],
  };
}
