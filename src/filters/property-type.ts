import type { PropertyType } from "../domain/listing.ts";

const BOUNDARY_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const BOUNDARY_AFTER = String.raw`(?![\p{L}\p{N}_])`;

const SHORT_TERM = new RegExp(
  `${BOUNDARY_BEFORE}(?:подобов\\p{L}*|посуточ\\p{L}*|посутков\\p{L}*|погодин\\p{L}*|short[\\s-]*term|daily(?:\\s+rent)?)${BOUNDARY_AFTER}`,
  "iu",
);
const SALE = new RegExp(
  `${BOUNDARY_BEFORE}(?:продаж\\p{L}*|продаю|for\\s+sale)${BOUNDARY_AFTER}`,
  "iu",
);
const ROOM_UNIT = new RegExp(
  `${BOUNDARY_BEFORE}(?:кімнат[ауи]|комнат[ауиы])${BOUNDARY_AFTER}`,
  "iu",
);
const EXCLUDED_PRIMARY = new RegExp(
  `${BOUNDARY_BEFORE}(?:комірк\\p{L}*|комор\\p{L}*|підвал\\p{L}*|паркінг\\p{L}*|паркомісц\\p{L}*|машиномісц\\p{L}*|гараж\\p{L}*|земельн\\p{L}*|ділянк\\p{L}*|офіс\\p{L}*|склад\\p{L}*|кладовк\\p{L}*|комерц\\p{L}*|commercial|garage|land\\s+plot)${BOUNDARY_AFTER}`,
  "iu",
);
const HOME = new RegExp(
  `${BOUNDARY_BEFORE}(?:квартир\\p{L}*|апартамент\\p{L}*|будин\\p{L}*|house|apartment|flat|вілл\\p{L}*)${BOUNDARY_AFTER}`,
  "iu",
);
const APARTMENT = new RegExp(
  `${BOUNDARY_BEFORE}(?:квартир\\p{L}*|апартамент\\p{L}*|apartment|flat)${BOUNDARY_AFTER}`,
  "iu",
);
const HOUSE = new RegExp(
  `${BOUNDARY_BEFORE}(?:будин\\p{L}*|house|дом)${BOUNDARY_AFTER}`,
  "iu",
);
const NOT_FOR_SALE = new RegExp(
  `${BOUNDARY_BEFORE}не\\s+(?:для\\s+)?продажу${BOUNDARY_AFTER}`,
  "giu",
);

export type PropertySignals = {
  realtyTypeId?: number | undefined;
  sectionId?: number | undefined;
  categoryText?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  aim?: string | undefined;
};

function maskNegatedSale(text: string): string {
  return text.replace(NOT_FOR_SALE, " ");
}

/** Rooms, daily rent, sale, and non-home property types are not long-term apartments or houses. */
export function rentalTextRejectsHome(text: string): boolean {
  return rentalTextRejectMatch(text) !== undefined;
}

export type RentalTextRejectReason = "short_term" | "sale" | "room_unit" | "excluded_primary";

/** Which rental-text rule rejected the blob, plus the matched word. */
export function rentalTextRejectMatch(
  text: string,
): { reason: RentalTextRejectReason; match: string } | undefined {
  const normalized = maskNegatedSale(text);
  if (!normalized.trim()) {
    return undefined;
  }
  const shortTerm = SHORT_TERM.exec(normalized);
  if (shortTerm) {
    return { reason: "short_term", match: shortTerm[0] };
  }
  const sale = SALE.exec(normalized);
  if (sale) {
    return { reason: "sale", match: sale[0] };
  }
  const room = ROOM_UNIT.exec(normalized);
  if (room) {
    return { reason: "room_unit", match: room[0] };
  }
  if (EXCLUDED_PRIMARY.test(normalized) && !HOME.test(normalized)) {
    const excluded = EXCLUDED_PRIMARY.exec(normalized);
    return { reason: "excluded_primary", match: excluded?.[0] ?? "excluded" };
  }
  return undefined;
}

export function namesLongTermHome(text: string): boolean {
  return HOME.test(maskNegatedSale(text));
}

export function looksLikeExcludedProperty(text: string): boolean {
  return rentalTextRejectsHome(text);
}

export function detectPropertyType(input: PropertySignals): PropertyType {
  const blob = [input.title, input.description, input.categoryText, input.aim].filter(Boolean).join("\n");
  if (rentalTextRejectsHome(blob)) {
    return "unknown";
  }
  if (input.realtyTypeId === 2 || input.sectionId === 2) {
    return "apartment";
  }
  if (input.realtyTypeId === 5 || input.sectionId === 4) {
    return "house";
  }
  const text = input.categoryText ?? input.title ?? "";
  if (APARTMENT.test(text)) {
    return "apartment";
  }
  if (HOUSE.test(text)) {
    return "house";
  }
  return "unknown";
}
