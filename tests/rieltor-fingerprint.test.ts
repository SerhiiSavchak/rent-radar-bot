import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fingerprintRieltorBlock } from "../src/sources/rieltor/rieltor-fingerprint.ts";

describe("RIELTOR 403 fingerprint", () => {
  it("keeps cookie names and drops cookie values, the HTML body, and secrets", () => {
    const body = "<html><title>Just a moment...</title><p>secret-listing</p></html>";
    const fingerprint = fingerprintRieltorBlock({
      requestedUrl: "https://rieltor.ua/lvov/flats-rent/?sort=bycreated",
      finalUrl: "https://rieltor.ua/lvov/flats-rent/?sort=bycreated",
      status: 403,
      headers: {
        server: "cloudflare",
        "cf-ray": "abc-MUC",
        via: "1.1 example",
        "x-cache": "MISS",
        "retry-after": "30",
        "content-type": "text/html",
        "content-length": String(body.length),
        "set-cookie": "PHPSESSID=super-secret; Path=/, other=also-secret",
      },
      bodyText: body,
    });
    const encoded = JSON.stringify(fingerprint);
    expect(fingerprint.setCookieNames).toEqual(["PHPSESSID", "other"]);
    expect(fingerprint.server).toBe("cloudflare");
    expect(fingerprint.cfRay).toBe("abc-MUC");
    expect(fingerprint.via).toBe("1.1 example");
    expect(fingerprint.xCache).toBe("MISS");
    expect(fingerprint.retryAfter).toBe("30");
    expect(fingerprint.title).toBe("Just a moment...");
    expect(fingerprint.challenge).toBe("challenge_html");
    expect(fingerprint.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(encoded).not.toContain("super-secret");
    expect(encoded).not.toContain("also-secret");
    expect(encoded).not.toContain("secret-listing");
    expect(encoded).not.toContain("<html>");
  });

  it("classifies a bare 403 without challenge markup as http_status", () => {
    const fingerprint = fingerprintRieltorBlock({
      requestedUrl: "https://rieltor.ua/lvov/flats-rent/?sort=bycreated",
      finalUrl: "https://rieltor.ua/lvov/flats-rent/?sort=bycreated",
      status: 403,
      headers: {},
      bodyText: "no",
    });
    expect(fingerprint.challenge).toBe("http_status");
    expect(fingerprint.setCookieNames).toEqual([]);
  });
});
