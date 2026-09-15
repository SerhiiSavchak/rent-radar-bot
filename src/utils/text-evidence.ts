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

const AGENT_PHRASES = [
  "агентство",
  "агенція",
  "рієлтор",
  "риелтор",
  "realtor",
  "комісія рієлтора",
  "послуги рієлтора",
];

export function collectTextEvidence(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const phrase of OWNER_PHRASES) {
    if (lower.includes(phrase)) {
      hits.push(`listing text contains '${phrase}'`);
    }
  }
  for (const phrase of AGENT_PHRASES) {
    if (lower.includes(phrase)) {
      hits.push(`listing text contains '${phrase}'`);
    }
  }
  return hits;
}

export function hasOwnerText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return OWNER_PHRASES.some((phrase) => lower.includes(phrase));
}
