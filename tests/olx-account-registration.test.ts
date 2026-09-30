import { describe, expect, it } from "vitest";
import {
  OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
  extractOlxAccountRegistrationYear,
  sellerRegistrationYearRejectionReason,
} from "../src/sources/olx/olx-account-registration.ts";

function memberSinceHtml(inner: string): string {
  return `<!DOCTYPE html><html><body>
<p data-testid="member-since">на OLX з <span>${inner}</span></p>
</body></html>`;
}

describe("OLX account registration year exclusion", () => {
  it("rejects exactly registration year 2026", () => {
    const year = extractOlxAccountRegistrationYear(memberSinceHtml("січень 2026 р."));
    expect(year).toBe(2026);
    expect(sellerRegistrationYearRejectionReason(year)).toBe(
      OLX_SELLER_REGISTRATION_YEAR_2026_REASON,
    );
  });

  it("does not reject registration year 2025 by this rule", () => {
    const year = extractOlxAccountRegistrationYear(memberSinceHtml("червень 2025 р."));
    expect(year).toBe(2025);
    expect(sellerRegistrationYearRejectionReason(year)).toBeUndefined();
  });

  it("does not reject registration year 2027 solely by this exact-year rule", () => {
    const year = extractOlxAccountRegistrationYear(memberSinceHtml("березень 2027 р."));
    expect(year).toBe(2027);
    expect(sellerRegistrationYearRejectionReason(year)).toBeUndefined();
  });

  it("keeps missing member-since as unknown (not rejected)", () => {
    const html = `<html><body><p>Онлайн 18 вересня 2026 р.</p></body></html>`;
    expect(extractOlxAccountRegistrationYear(html)).toBeUndefined();
    expect(sellerRegistrationYearRejectionReason(undefined)).toBeUndefined();
  });

  it("keeps malformed member-since as unknown", () => {
    expect(extractOlxAccountRegistrationYear(memberSinceHtml("невідомо"))).toBeUndefined();
    expect(
      extractOlxAccountRegistrationYear(memberSinceHtml("2025 / 2026 р.")),
    ).toBeUndefined();
  });

  it("does not treat listing publication year as account registration", () => {
    const html = `<html><body>
<p>Опубліковано 23 вересня 2026 р.</p>
<p data-testid="lastSeenBox">Онлайн 18 вересня 2026 р.</p>
</body></html>`;
    expect(extractOlxAccountRegistrationYear(html)).toBeUndefined();
  });

  it("reads live-shaped member-since with month + year", () => {
    expect(
      extractOlxAccountRegistrationYear(memberSinceHtml("листопад 2024 р.")),
    ).toBe(2024);
  });

  it("parses Russian на OLX с inside member-since without inventing from listing dates", () => {
    const html = `<p data-testid="member-since">на OLX с <span>январь 2026 г.</span></p>`;
    expect(extractOlxAccountRegistrationYear(html)).toBe(2026);
    expect(
      extractOlxAccountRegistrationYear(
        `<html><body><p>Опубликовано 23 сентября 2026 г.</p></body></html>`,
      ),
    ).toBeUndefined();
  });

  it("does not treat ad-description copy as platform registration year", () => {
    const html =
      `<html><body><div data-testid="ad-description">Текст оголошення: на OLX з 2026 р.</div></body></html>`;
    expect(extractOlxAccountRegistrationYear(html)).toBeUndefined();
  });

  it("does not treat script text as platform registration year", () => {
    const html = `<html><script>var description="на OLX з 2026 р.";</script></html>`;
    expect(extractOlxAccountRegistrationYear(html)).toBeUndefined();
  });

  it("empty member-since with unrelated 2026 text stays unknown", () => {
    const html = `<html><body>
<p data-testid="member-since"></p>
<div data-testid="ad-description">на OLX з 2026 р.</div>
<script>var x="на OLX з 2026 р.";</script>
</body></html>`;
    expect(extractOlxAccountRegistrationYear(html)).toBeUndefined();
  });
});
