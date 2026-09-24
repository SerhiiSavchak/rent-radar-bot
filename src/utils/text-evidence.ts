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

export type SellerTextLevel = "confirmed" | "likely" | "unknown";

export type SellerTextSignalFamily =
  "collaboration" | "inventory" | "transaction" | "service" | "agency_brand";

export type SellerTextJudgement = {
  level: SellerTextLevel;
  strongSignals: string[];
  supportingSignals: string[];
  supportingFamilies: SellerTextSignalFamily[];
  ownerContextSignals: string[];
};

const PROTECTED_SPANS: RegExp[] = [
  /(?<![\p{L}\p{N}_])(?:не|без)\s+агентств\p{L}*\s+нерухомост\p{L}*/giu,
  /(?<![\p{L}\p{N}_])(?:не|без)\s+агенці\p{L}*\s+нерухомост\p{L}*/giu,
  /(?<![\p{L}\p{N}_])(?:не|без)\s+агентств\p{L}*\s+недвижимост\p{L}*/giu,
  /я\s+не\s+рі[єе]лтор/giu,
  /я\s+не\s+риелтор/giu,
  /я\s+не\s+realtor/giu,
  /я\s+не\s+агент\s+(?:з|по)\s+не(?:рухомост|движимост)\p{L}*/giu,
  /з\s+рі[єе]лторами\s+не\s+співпрац\p{L}*/giu,
  /з\s+риелторами\s+не\s+(?:співпрац|сотруднича)\p{L}*/giu,
  /агентствам\s+недвижимости\s+не\s+\p{L}+/giu,
  /без\s+рі[єе]лторськ\p{L}*\s+комісі\p{L}*/giu,
  /без\s+риелторск\p{L}*\s+комисси\p{L}*/giu,
  /без\s+комісі\p{L}*/giu,
  /без\s+комисси\p{L}*/giu,
  /без\s+рі[єе]лторів/giu,
  /без\s+риелторов/giu,
  /рі[єе]лторам\s+не\s+(?:дзвонити|телефонувати)/giu,
  /риелторам\s+не\s+звонить/giu,
  /агентам\s+не\s+(?:турбувати|беспокоить)/giu,
  /агентствам\s+нерухомості\s+не\s+\p{L}+/giu,
  /агенціям\s+нерухомості\s+не\s+\p{L}+/giu,
];

const STRONG_INTERMEDIARY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: unicodePhrase(String.raw`я\s+рі[єе]лтор`), label: "я рієлтор" },
  { pattern: unicodePhrase(String.raw`я\s+риелтор`), label: "я риелтор" },
  { pattern: unicodePhrase(String.raw`я\s+realtor${CYRILLIC_WORD_END}`), label: "я realtor" },
  { pattern: unicodePhrase(String.raw`ми\s+рі[єе]лтор`), label: "ми рієлтори" },
  { pattern: unicodePhrase(String.raw`ми\s+риелтор`), label: "ми риелторы" },
  {
    pattern: unicodePhrase(String.raw`брокер\s+(?:з|по)\s+не(?:рухомост|движимост)`),
    label: "брокер з нерухомості",
  },
  {
    pattern: unicodePhrase(String.raw`агент\s+(?:з|по)\s+не(?:рухомост|движимост)`),
    label: "агент з нерухомості",
  },
  { pattern: unicodePhrase(String.raw`менеджер\s+агентств`), label: "менеджер агентства" },
  {
    pattern: unicodePhrase(String.raw`спеціаліст\s+з\s+нерухомост`),
    label: "спеціаліст з нерухомості",
  },
  {
    pattern: unicodePhrase(String.raw`специалист\s+по\s+недвижимост`),
    label: "специалист по недвижимости",
  },
  {
    pattern: unicodePhrase(String.raw`представ(?:ник|итель)\s+агентств`),
    label: "представник агентства",
  },
  { pattern: /агентств\p{L}*\s+нерухомост/iu, label: "агентство нерухомості" },
  { pattern: /агенці\p{L}*\s+нерухомост/iu, label: "агенція нерухомості" },
  { pattern: /агентств\p{L}*\s+недвижимост/iu, label: "агентство недвижимости" },
  { pattern: /real\s+estate\s+agency/iu, label: "real estate agency" },
  { pattern: /рі[єе]лторськ\p{L}*\s+комісі\p{L}*/iu, label: "рієлторська комісія" },
  { pattern: /риелторск\p{L}*\s+комисси\p{L}*/iu, label: "риелторская комиссия" },
  { pattern: /комісі\p{L}*\s+рі[єе]лтор/iu, label: "комісія рієлтора" },
  { pattern: /комисси\p{L}*\s+риелтор/iu, label: "комиссия риелтора" },
  { pattern: /комісі\p{L}*\s+агентств/iu, label: "комісія агентства" },
  { pattern: /комисси\p{L}*\s+агентств/iu, label: "комиссия агентства" },
  { pattern: /послуги\s+рі[єе]лтора/iu, label: "послуги рієлтора" },
  { pattern: /услуги\s+риелтора/iu, label: "услуги риелтора" },
  { pattern: unicodePhrase(String.raw`я\s+агент${CYRILLIC_WORD_END}`), label: "я агент" },
];

const SUPPORTING_FAMILIES: Array<{
  family: SellerTextSignalFamily;
  pattern: RegExp;
  label: string;
}> = [
  { family: "collaboration", pattern: /без\s+співпраці/iu, label: "без співпраці" },
  { family: "collaboration", pattern: /співпрац/iu, label: "співпраця" },
  { family: "collaboration", pattern: /(?<![\p{L}\p{N}_])колег/iu, label: "колеги" },
  { family: "collaboration", pattern: /(?<![\p{L}\p{N}_])спп(?![\p{L}\p{N}_])/iu, label: "спп" },
  { family: "inventory", pattern: /є\s+інші\s+варіанти/iu, label: "є інші варіанти" },
  { family: "inventory", pattern: /є\s+інші\s+об/iu, label: "є інші об'єкти" },
  { family: "inventory", pattern: /маю\s+інші\s+варіанти/iu, label: "маю інші варіанти" },
  { family: "inventory", pattern: /підбер\p{L}*\s+варіант/iu, label: "підбір варіанта" },
  { family: "inventory", pattern: /підбір\s+нерухомост/iu, label: "підбір нерухомості" },
  { family: "inventory", pattern: /допоможу\s+підібрати/iu, label: "допоможу підібрати" },
  { family: "inventory", pattern: /база\s+об/iu, label: "база об'єктів" },
  { family: "inventory", pattern: /інші\s+об['']?єкти/iu, label: "інші об'єкти" },
  { family: "transaction", pattern: /(?<![\p{L}\p{N}_])комісі/iu, label: "комісія" },
  { family: "transaction", pattern: /(?<![\p{L}\p{N}_])комисси/iu, label: "комиссия" },
  { family: "transaction", pattern: /ексклюзив/iu, label: "ексклюзив" },
  { family: "transaction", pattern: /ключі\s+на\s+руках/iu, label: "ключі на руках" },
  { family: "transaction", pattern: /ключи\s+на\s+руках/iu, label: "ключи на руках" },
  {
    family: "transaction",
    pattern: /(?<![\p{L}\p{N}_])покази(?![\p{L}\p{N}_])/iu,
    label: "покази",
  },
  {
    family: "transaction",
    pattern: /(?<![\p{L}\p{N}_])показы(?![\p{L}\p{N}_])/iu,
    label: "показы",
  },
  { family: "service", pattern: /супровід\s+угоди/iu, label: "супровід угоди" },
  { family: "service", pattern: /сопровождение\s+сделки/iu, label: "сопровождение сделки" },
  {
    family: "service",
    pattern: /консультаці\p{L}*\s+з\s+нерухомост/iu,
    label: "консультація з нерухомості",
  },
  {
    family: "service",
    pattern: /консультаци\p{L}*\s+по\s+недвижимост/iu,
    label: "консультация по недвижимости",
  },
  { family: "agency_brand", pattern: /(?<![\p{L}\p{N}_])АН\s+\p{L}/u, label: "АН назва" },
  {
    family: "agency_brand",
    pattern: /(?<![\p{L}\p{N}_])\p{L}{2,}\s+АН(?![\p{L}\p{N}_])/u,
    label: "ім'я АН",
  },
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

export function normalizeSellerText(text: string): string {
  return text
    .replace(/[\u2019\u2018\u02BC`]/g, "'")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function maskProtectedSpans(text: string): { masked: string; ownerContextSignals: string[] } {
  let masked = text;
  const ownerContextSignals: string[] = [];
  for (const pattern of PROTECTED_SPANS) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, (span) => {
      ownerContextSignals.push(span);
      return " ".repeat(span.length);
    });
  }
  return { masked, ownerContextSignals };
}

function matchedLabels(
  text: string,
  patterns: Array<{ pattern: RegExp; label: string }>,
): string[] {
  const hits: string[] = [];
  for (const item of patterns) {
    item.pattern.lastIndex = 0;
    if (item.pattern.test(text)) {
      hits.push(item.label);
    }
  }
  return hits;
}

/**
 * Classifies already-available public seller text.
 * One supporting family stays unknown. Two independent families are likely.
 * A strong agency, role, or realtor-commission phrase is confirmed.
 * Negated owner-side phrases are masked first and cannot create that confirmation.
 */
export function classifySellerText(text: string | undefined): SellerTextJudgement {
  if (!text || !text.trim()) {
    return {
      level: "unknown",
      strongSignals: [],
      supportingSignals: [],
      supportingFamilies: [],
      ownerContextSignals: [],
    };
  }
  const normalized = normalizeSellerText(text);
  const { masked, ownerContextSignals } = maskProtectedSpans(normalized);
  const strongSignals = matchedLabels(masked, STRONG_INTERMEDIARY_PATTERNS);
  const supportingSignals: string[] = [];
  const supportingFamilies: SellerTextSignalFamily[] = [];
  if (strongSignals.length === 0) {
    for (const item of SUPPORTING_FAMILIES) {
      item.pattern.lastIndex = 0;
      if (!item.pattern.test(masked) || supportingFamilies.includes(item.family)) {
        continue;
      }
      supportingFamilies.push(item.family);
      supportingSignals.push(item.label);
    }
  }
  const level: SellerTextLevel =
    strongSignals.length > 0 ? "confirmed" : supportingFamilies.length >= 2 ? "likely" : "unknown";
  return { level, strongSignals, supportingSignals, supportingFamilies, ownerContextSignals };
}

function strongIntermediaryHits(text: string): string[] {
  return classifySellerText(text).strongSignals;
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
