/**
 * Inspect a public OLX offer detail HTML document for structured seller-role evidence.
 * Missing fields stay unknown. Seller-authored text never becomes a platform label.
 */

import { classifyOwner, isOwnerEligible, type OwnerEvidenceLevel } from "../../filters/owner-filter.ts";
import {
  hasExplicitSelfDeclaredOwnerText,
  hasMisleadingOwnerSeekingText,
} from "../../utils/text-evidence.ts";
import { adaptOracleCatalogAd, collectOfferLikeObjects, inspectPrerenderedState } from "./olx-browser.html-extract.ts";

export type ObservedField<T> =
  | { present: false }
  | { present: true; value: T };

export type OlxDetailPlatformLabel = "owner" | "agent" | "business" | "null" | "unknown";

export type OlxOfferDetailInspection = {
  prerenderedPresent: boolean;
  prerenderedComplete: boolean;
  prerenderedTruncated: boolean;
  offerRecordFound: boolean;
  matchedExpectedId: boolean;
  sourceId?: string;
  url?: string;
  title?: string;
  sellerTypeField: ObservedField<string | null>;
  isBusinessField: ObservedField<boolean>;
  companyNameField: ObservedField<string | null>;
  /** Structured platform seller role only. Text claims never fill this. */
  platformLabel: OlxDetailPlatformLabel;
  accountType: "private" | "business" | "unknown";
  sellerAuthoredSelfDeclared: boolean;
  sellerAuthoredMisleadingOwnerSeeking: boolean;
  ownerEvidenceLevel: OwnerEvidenceLevel | "unknown";
  strongerThanCatalogSelfDeclared: boolean;
  defaultOwnerGateWouldAccept: boolean;
  notes: string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function observedStringOrNull(record: Record<string, unknown> | undefined, key: string): ObservedField<string | null> {
  if (!record || !(key in record)) {
    return { present: false };
  }
  const value = record[key];
  if (value === null) {
    return { present: true, value: null };
  }
  if (typeof value === "string") {
    return { present: true, value };
  }
  return { present: false };
}

function observedBoolean(record: Record<string, unknown> | undefined, key: string): ObservedField<boolean> {
  if (!record || !(key in record)) {
    return { present: false };
  }
  const value = record[key];
  if (typeof value === "boolean") {
    return { present: true, value };
  }
  return { present: false };
}

function candidateId(raw: unknown): string | undefined {
  const id = asRecord(raw)?.id;
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  if (typeof id === "string" && id.trim()) {
    return id.trim();
  }
  return undefined;
}

function pickOfferRecord(state: unknown, expectedSourceId: string): Record<string, unknown> | undefined {
  const candidates = collectOfferLikeObjects(state, 40);
  const matched = candidates.find((item) => candidateId(item) === expectedSourceId);
  if (matched) {
    return asRecord(matched);
  }
  const adaptedDirect = adaptOracleCatalogAd(state);
  if (adaptedDirect && candidateId(adaptedDirect) === expectedSourceId) {
    return asRecord(state) ?? asRecord(adaptedDirect);
  }
  return undefined;
}

function platformLabelFromSellerType(field: ObservedField<string | null>): OlxDetailPlatformLabel {
  if (!field.present) {
    return "unknown";
  }
  if (field.value === null || field.value.trim() === "") {
    return "null";
  }
  const lower = field.value.trim().toLowerCase();
  if (lower === "owner") {
    return "owner";
  }
  if (lower === "agent" || lower === "agency" || lower === "intermediary") {
    return "agent";
  }
  if (lower === "business") {
    return "business";
  }
  return "unknown";
}

/**
 * Pure HTML inspection. Does not navigate and does not invent missing seller fields.
 */
export function inspectOlxOfferDetailHtml(
  html: string,
  expectedSourceId: string,
): OlxOfferDetailInspection {
  const notes: string[] = [];
  const inspection = inspectPrerenderedState(html);
  const offer = inspection.decoded ? pickOfferRecord(inspection.decoded, expectedSourceId) : undefined;
  const user = asRecord(offer?.user);
  const sellerTypeField = observedStringOrNull(user, "sellerType");
  const isBusinessField = observedBoolean(offer, "isBusiness");
  const businessAlias = observedBoolean(offer, "business");
  const businessField = isBusinessField.present ? isBusinessField : businessAlias;
  const companyNameField = observedStringOrNull(user, "company_name");
  const title = typeof offer?.title === "string" ? offer.title : undefined;
  const description = typeof offer?.description === "string" ? offer.description : undefined;
  const text = `${title ?? ""}\n${description ?? ""}`;
  const platformLabel = platformLabelFromSellerType(sellerTypeField);
  const accountType =
    businessField.present && businessField.value === true
      ? "business"
      : businessField.present && businessField.value === false
        ? "private"
        : "unknown";

  const extraEvidence: string[] = [];
  if (!sellerTypeField.present) {
    extraEvidence.push("detail HTML: user.sellerType field absent");
    notes.push("sellerType_field_absent");
  } else if (sellerTypeField.value === null) {
    extraEvidence.push("detail HTML: user.sellerType is null (does not establish ownership)");
    notes.push("sellerType_field_null");
  } else {
    extraEvidence.push(`detail HTML: user.sellerType = ${sellerTypeField.value}`);
  }
  if (!businessField.present) {
    extraEvidence.push("detail HTML: isBusiness/business field absent");
    notes.push("account_type_field_absent");
  }

  const owner = offer
    ? classifyOwner({
        platformOwner: platformLabel === "owner",
        platformAgent: platformLabel === "agent",
        platformBusiness: accountType === "business" || platformLabel === "business",
        platformPrivate: accountType === "private",
        isBusiness: accountType === "business",
        agencyName: companyNameField.present && companyNameField.value ? companyNameField.value : undefined,
        text,
        extraEvidence,
      })
    : undefined;

  const strongerThanCatalogSelfDeclared = owner?.ownerEvidenceLevel === "platform_confirmed";
  const defaultOwnerGateWouldAccept = owner
    ? isOwnerEligible({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      })
    : false;

  if (!inspection.present) {
    notes.push("prerendered_state_absent");
  }
  if (inspection.truncated) {
    notes.push("prerendered_state_truncated");
  }
  if (inspection.present && !offer) {
    notes.push("offer_record_not_found_for_expected_id");
  }

  const sourceId = offer ? candidateId(offer) : undefined;
  const offerUrl = typeof offer?.url === "string" ? offer.url : undefined;

  return {
    prerenderedPresent: inspection.present,
    prerenderedComplete: inspection.complete,
    prerenderedTruncated: inspection.truncated,
    offerRecordFound: Boolean(offer),
    matchedExpectedId: Boolean(offer && sourceId === expectedSourceId),
    ...(sourceId ? { sourceId } : {}),
    ...(offerUrl ? { url: offerUrl } : {}),
    ...(title ? { title } : {}),
    sellerTypeField,
    isBusinessField: businessField,
    companyNameField,
    platformLabel,
    accountType,
    sellerAuthoredSelfDeclared: hasExplicitSelfDeclaredOwnerText(text),
    sellerAuthoredMisleadingOwnerSeeking: hasMisleadingOwnerSeekingText(text),
    ownerEvidenceLevel: owner?.ownerEvidenceLevel ?? "unknown",
    strongerThanCatalogSelfDeclared,
    defaultOwnerGateWouldAccept,
    notes,
  };
}
