const OWNER_PHRASES = [
  "від власника",
  "від власниці",
  "без посередників",
  "без посередника",
  "без комісії",
  "без комиссии",
  "от хозяина",
  "от собственника",
];

/** Strong first-person owner claims. "без комісії" is too weak (agencies use it). */
const SELF_DECLARED_OWNER_PHRASES = [
  "від власника",
  "від власниці",
  "от хозяина",
  "от собственника",
  "без посередників",
  "без посередника",
];

const MISLEADING_OWNER_SEEKING = [
  "шукаю власника",
  "шукаємо власника",
  "шукаємо власників",
  "шукаю власників",
  "looking for an owner",
  "looking for owners",
  "owners, contact",
  "owners contact us",
  "власники, контакт",
  "власники контакт",
  "власники, дзвон",
];

/**
 * Unambiguous intermediary self-description or an explicit brokerage commission offer.
 * Bare substrings «рієлтор» / «агентство» / «комісія» are not enough.
 */
/** JS `\b` is ASCII-only, so a Cyrillic «Я» at the start of a string never matches `\bя`. */
const CYRILLIC_WORD_START = String.raw`(?<![\p{L}\p{N}_])`;
const CYRILLIC_WORD_END = String.raw`(?![\p{L}\p{N}_])`;

function unicodePhrase(source: string): RegExp {
  return new RegExp(`${CYRILLIC_WORD_START}(?:${source})`, "iu");
}

const STRONG_INTERMEDIARY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: unicodePhrase(String.raw`я\s+рі[єе]лтор`), label: "я рієлтор" },
  { pattern: unicodePhrase(String.raw`я\s+риелтор`), label: "я риелтор" },
  { pattern: unicodePhrase(String.raw`я\s+realtor${CYRILLIC_WORD_END}`), label: "я realtor" },
  { pattern: unicodePhrase(String.raw`ми\s+рі[єе]лтор`), label: "ми рієлтори" },
  { pattern: unicodePhrase(String.raw`ми\s+риелтор`), label: "ми риелторы" },
  { pattern: /агентство\s+нерухомост/i, label: "агентство нерухомості" },
  { pattern: /агенція\s+нерухомост/i, label: "агенція нерухомості" },
  { pattern: /агентство\s+недвижимост/i, label: "агентство недвижимости" },
  { pattern: /комісія\s+агентств/i, label: "комісія агентства" },
  { pattern: /комиссия\s+агентств/i, label: "комиссия агентства" },
  { pattern: /комісія\s+рі[єе]лтор/i, label: "комісія рієлтора" },
  { pattern: /комиссия\s+риелтор/i, label: "комиссия риелтора" },
  { pattern: /коміс[іи]я\s+\d+\s*%/i, label: "комісія N%" },
  { pattern: /комиссия\s+\d+\s*%/i, label: "комиссия N%" },
  { pattern: /послуги\s+рі[єе]лтора/i, label: "послуги рієлтора" },
  { pattern: /услуги\s+риелтора/i, label: "услуги риелтора" },
  { pattern: unicodePhrase(String.raw`я\s+агент(?:ство)?${CYRILLIC_WORD_END}`), label: "я агент" },
];

function includesPhrase(lower: string, phrase: string): boolean {
  return lower.includes(phrase.toLowerCase());
}

export function collectTextEvidence(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const phrase of OWNER_PHRASES) {
    if (includesPhrase(lower, phrase)) {
      hits.push(`listing text contains '${phrase}'`);
    }
  }
  for (const hit of strongIntermediaryHits(text)) {
    hits.push(`listing text contains explicit intermediary phrasing '${hit}'`);
  }
  for (const phrase of MISLEADING_OWNER_SEEKING) {
    if (includesPhrase(lower, phrase)) {
      hits.push(`listing text seeks an owner ('${phrase}') — not a self-declaration`);
    }
  }
  return hits;
}

export function hasOwnerText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return OWNER_PHRASES.some((phrase) => includesPhrase(lower, phrase));
}

export function hasMisleadingOwnerSeekingText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return MISLEADING_OWNER_SEEKING.some((phrase) => includesPhrase(lower, phrase));
}

/**
 * Explicit self-declared owner phrasing, excluding agency-seeking copy.
 * Does not include "без комісії" or "приватний будинок".
 */
export function hasExplicitSelfDeclaredOwnerText(text: string | undefined): boolean {
  if (!text || hasMisleadingOwnerSeekingText(text)) {
    return false;
  }
  const lower = text.toLowerCase();
  return SELF_DECLARED_OWNER_PHRASES.some((phrase) => includesPhrase(lower, phrase));
}

function strongIntermediaryHits(text: string): string[] {
  const hits: string[] = [];
  for (const item of STRONG_INTERMEDIARY_PATTERNS) {
    if (item.pattern.test(text)) {
      hits.push(item.label);
    }
  }
  return hits;
}

/**
 * True only for unambiguous seller self-description or an explicit commission offer.
 * Negative copy such as «Без комісії» / «Рієлторам не телефонувати» does not match.
 */
export function hasExplicitIntermediaryText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return strongIntermediaryHits(text).length > 0;
}

/** @deprecated use hasExplicitIntermediaryText — bare realtor/agency substrings are not evidence. */
export function hasAgentText(text: string | undefined): boolean {
  return hasExplicitIntermediaryText(text);
}
