/**
 * Platform-supported OLX account registration year from listing/detail HTML.
 *
 * Live OLX offer pages expose:
 *   <p data-testid="member-since">на OLX з <span>листопад 2024 р.</span></p>
 *
 * Only the calendar year is used. Month text is ignored. Listing
 * createdTime / lastRefreshTime must never substitute for this field.
 */

export const OLX_SELLER_REGISTRATION_YEAR_2026_REASON = "seller_registration_year_2026";

/** Exact customer exclusion year. Not "current year", not "2026 and later". */
export const OLX_EXCLUDED_REGISTRATION_YEAR = 2026;

const MEMBER_SINCE_BLOCK =
  /data-testid=["']member-since["'][^>]*>([\s\S]*?)<\/p>/i;

/**
 * Returns the platform registration year when `data-testid="member-since"` yields
 * a single unambiguous 20xx year. Missing, empty, malformed, or multi-year text
 * → undefined.
 *
 * No whole-document fallback: listing description / script text can contain
 * "на OLX з 2026" without establishing account registration.
 */
export function extractOlxAccountRegistrationYear(html: string): number | undefined {
  if (!html) {
    return undefined;
  }
  const block = html.match(MEMBER_SINCE_BLOCK);
  if (!block) {
    return undefined;
  }
  const text = (block[1] ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  const unique = [...new Set(years.filter((y) => Number.isInteger(y) && y >= 2000 && y <= 2100))];
  if (unique.length !== 1) {
    return undefined;
  }
  return unique[0];
}

/**
 * Customer exclusion: reject only when the platform year is exactly 2026.
 * 2025, 2027, missing, and malformed years are not rejected by this rule.
 */
export function sellerRegistrationYearRejectionReason(
  year: number | undefined,
): typeof OLX_SELLER_REGISTRATION_YEAR_2026_REASON | undefined {
  if (year === OLX_EXCLUDED_REGISTRATION_YEAR) {
    return OLX_SELLER_REGISTRATION_YEAR_2026_REASON;
  }
  return undefined;
}
