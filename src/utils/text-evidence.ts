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

const AGENT_PHRASES = [
  "агентство",
  "агенція",
  "рієлтор",
  "риелтор",
  "realtor",
  "комісія рієлтора",
  "послуги рієлтора",
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
  for (const phrase of AGENT_PHRASES) {
    if (includesPhrase(lower, phrase)) {
      hits.push(`listing text contains '${phrase}'`);
    }
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

export function hasAgentText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return AGENT_PHRASES.some((phrase) => includesPhrase(lower, phrase));
}
