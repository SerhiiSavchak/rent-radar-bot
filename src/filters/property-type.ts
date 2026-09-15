import type { PropertyType } from "../domain/listing.ts";

const HOME_WORDS = /квартир|апартамент|будин|будинк|house|apartment|flat|вілл/i;
const EXCLUDED_PRIMARY =
  /\b(комірк[аиу]?|комор[аиу]?|підвал|паркінг|паркомісц|машиномісц|гараж|земельн|ділянка|офіс|склад|кладовк)/i;

export type PropertySignals = {
  realtyTypeId?: number | undefined;
  sectionId?: number | undefined;
  categoryText?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  aim?: string | undefined;
};

export function looksLikeExcludedProperty(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!EXCLUDED_PRIMARY.test(normalized)) {
    return false;
  }
  if (HOME_WORDS.test(normalized) && !/^\s*(оренда\s*)?\(?\s*(комірк|комор|підвал|паркінг|гараж)/i.test(text)) {
    return false;
  }
  return true;
}

export function detectPropertyType(input: PropertySignals): PropertyType {
  const blob = [input.title, input.description, input.categoryText, input.aim].filter(Boolean).join("\n");
  if (looksLikeExcludedProperty(blob)) {
    return "unknown";
  }
  if (input.realtyTypeId === 2 || input.sectionId === 2) {
    return "apartment";
  }
  if (input.realtyTypeId === 5 || input.sectionId === 4) {
    return "house";
  }
  const text = (input.categoryText ?? input.title ?? "").toLowerCase();
  if (text.includes("квартир") || text.includes("apartment") || text.includes("flat")) {
    return "apartment";
  }
  if (text.includes("будин") || text.includes("дом") || text.includes("house")) {
    return "house";
  }
  return "unknown";
}
