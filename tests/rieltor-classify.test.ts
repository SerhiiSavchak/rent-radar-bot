import { describe, expect, it } from "vitest";
import {
  isRieltorChallengeHtml,
  isRieltorTransportBlocked,
  resolveRieltorInspectKind,
} from "../src/sources/rieltor/rieltor-classify.ts";
import { inspectRieltorHtml } from "../src/sources/rieltor/rieltor.parser.ts";

const cloudflare403Html = `<!DOCTYPE html>
<html>
<head><title>Attention Required! | Cloudflare</title></head>
<body>
  <h1>Sorry, you have been blocked</h1>
  <form action="/cdn-cgi/challenge-platform/h/b/flow/ov1"></form>
</body>
</html>`;

const challenge200Html = `<!DOCTYPE html>
<html>
<head><title>Just a moment...</title></head>
<body>
  <div id="cf-browser-verification"></div>
  Enable JavaScript and cookies to continue
</body>
</html>`;

describe("RIELTOR transport classification", () => {
  it("treats HTTP 403 as transport_blocked even when a catalog HTML success already exists", () => {
    expect(isRieltorTransportBlocked({ status: 403, bodyText: cloudflare403Html })).toBe(true);
    expect(
      resolveRieltorInspectKind({
        parserFailure: false,
        httpError: true,
        blocked: true,
        uniqueCount: 3,
        sawStructure: true,
      }),
    ).toBe("http_error");
  });

  it("does not treat a Cloudflare challenge 200 as catalog HTML success", () => {
    expect(isRieltorChallengeHtml(challenge200Html)).toBe(true);
    expect(isRieltorTransportBlocked({ status: 200, bodyText: challenge200Html })).toBe(true);
    const inspection = inspectRieltorHtml(challenge200Html, {
      category: "apartment",
      pageUrl: "https://rieltor.ua/lvov/flats-rent/?f-owners=1",
    });
    expect(inspection.resultKind).toBe("parser_failure");
    expect(inspection.listings).toHaveLength(0);
  });

  it("keeps a real catalog 200 as parseable, not blocked", () => {
    const catalog =
      '<html><head><title>Оренда квартир в Львові</title></head><body><div data-listing-items></div></body></html>';
    expect(isRieltorTransportBlocked({ status: 200, bodyText: catalog })).toBe(false);
    expect(
      resolveRieltorInspectKind({
        parserFailure: false,
        httpError: false,
        blocked: false,
        uniqueCount: 3,
        sawStructure: true,
      }),
    ).toBe("ok");
  });
});
