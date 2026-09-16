import { describe, expect, it } from "vitest";
import {
  classifyOlxExperimentCategory,
  deriveOlxInspectResultKind,
  OLX_HTML_APARTMENTS_URL,
  OLX_HTML_HOUSES_URL,
  selectOlxHtmlFallbackUrl,
} from "../src/probe/olx-experiment-classify.ts";

describe("OLX HTML fallback URL selection", () => {
  it("uses apartments HTML for apartments-only and default combined", () => {
    expect(selectOlxHtmlFallbackUrl({ includeApartments: true, includeHouses: false })).toBe(
      OLX_HTML_APARTMENTS_URL,
    );
    expect(selectOlxHtmlFallbackUrl()).toBe(OLX_HTML_APARTMENTS_URL);
    expect(OLX_HTML_APARTMENTS_URL).toContain("kvartiry/dolgosrochnaya-arenda-kvartir");
  });

  it("uses houses HTML for houses-only (regression: must not note apartments URL)", () => {
    const url = selectOlxHtmlFallbackUrl({ includeApartments: false, includeHouses: true });
    expect(url).toBe(OLX_HTML_HOUSES_URL);
    expect(url).toContain("doma/arenda-domov");
    expect(url).not.toContain("kvartiry");
    expect(url).not.toBe(OLX_HTML_APARTMENTS_URL);
  });
});

describe("OLX experiment classification", () => {
  const api403Note =
    "https://www.olx.ua/api/v1/offers/?offset=0&limit=10&category_id=1760&region_id=5&city_id=176&distance=15&sort_by=created_at%3Adesc -> 403 content-type=text/html; server=CloudFront";
  const html200ApartmentsNote = `HTML ${OLX_HTML_APARTMENTS_URL} -> 200 content-type=text/html`;
  const html200HousesNote = `HTML ${OLX_HTML_HOUSES_URL} -> 200 content-type=text/html`;

  it("classifies API 403 CloudFront HTML as transport_blocked even when HTML fallback is 200", () => {
    const notes = [api403Note, html200ApartmentsNote, "HTML reached, but Phase 0 does not scrape"];
    const classified = classifyOlxExperimentCategory({
      notes,
      httpStatus: 403,
      resultKind: "http_error",
      listingCount: 0,
    });
    expect(classified.blocked).toBe(true);
    expect(classified.success).toBe(false);
    expect(classified.failureReason).toBe("transport_blocked");
  });

  it("still marks transport_blocked from notes when reported status was wrongly HTML 200", () => {
    const classified = classifyOlxExperimentCategory({
      notes: [api403Note, html200HousesNote],
      httpStatus: 200,
      resultKind: "parser_failure",
      listingCount: 0,
    });
    expect(classified.blocked).toBe(true);
    expect(classified.failureReason).toBe("transport_blocked");
    expect(classified.success).toBe(false);
  });

  it("classifies HTML 200 without listing payload as parser_failure (not success)", () => {
    const classified = classifyOlxExperimentCategory({
      notes: [html200ApartmentsNote, "HTML reached, but Phase 0 does not scrape"],
      httpStatus: 200,
      resultKind: "parser_failure",
      listingCount: 0,
    });
    expect(classified.blocked).toBe(false);
    expect(classified.success).toBe(false);
    expect(classified.failureReason).toBe("parser_failure");
  });

  it("does not treat HTML 200 alone as successful OLX access", () => {
    const classified = classifyOlxExperimentCategory({
      notes: [html200HousesNote],
      httpStatus: 200,
      resultKind: "ok",
      listingCount: 0,
    });
    expect(classified.success).toBe(false);
    expect(classified.failureReason).toBe("no_listings");
  });
});

describe("OLX inspect resultKind derivation", () => {
  it("prefers http_error when API notes show 403", () => {
    const notes = [
      "https://www.olx.ua/api/v1/offers/?category_id=330 -> 403 content-type=text/html; server=CloudFront",
      `HTML ${OLX_HTML_HOUSES_URL} -> 200 content-type=text/html`,
    ];
    expect(
      deriveOlxInspectResultKind({
        listingCount: 0,
        jsonSucceeded: false,
        apiStatus: 403,
        htmlStatus: 200,
        notes,
      }),
    ).toBe("http_error");
  });

  it("uses parser_failure for HTML 200 with no JSON listings and no API block", () => {
    expect(
      deriveOlxInspectResultKind({
        listingCount: 0,
        jsonSucceeded: false,
        apiStatus: 200,
        htmlStatus: 200,
        notes: ["JSON 200 but no offers parsed", `HTML ${OLX_HTML_APARTMENTS_URL} -> 200`],
      }),
    ).toBe("parser_failure");
  });
});
