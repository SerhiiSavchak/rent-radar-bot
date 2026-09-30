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
  const normalized = maskNegatedSale(text);
  if (!normalized.trim()) {
    return false;
  }
  if (SHORT_TERM.test(normalized) || SALE.test(normalized) || ROOM_UNIT.test(normalized)) {
    return true;
  }
  return EXCLUDED_PRIMARY.test(normalized) && !HOME.test(normalized);
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
