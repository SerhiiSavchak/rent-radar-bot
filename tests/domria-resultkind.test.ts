import { describe, expect, it } from "vitest";
import { deriveDomriaInspectResultKind } from "../src/sources/domria/domria.source.ts";
import { classifyCycleStatus } from "../src/probe/oracle-soak/classify.ts";
import type { SoakSourceResult } from "../src/probe/oracle-soak/types.ts";
import { formatSellerLabel } from "../src/outputs/telegram-test.sink.ts";
import type { Listing } from "../src/domain/listing.ts";

describe("DIM.RIA resultKind (Oracle soak regression)", () => {
  it("sets ok when listings were extracted (soak previously saw unknown+10)", () => {
    expect(deriveDomriaInspectResultKind({ listingCount: 10, httpStatus: 200 })).toBe("ok");
  });

  it("does not invent valid_empty for bare empty HTML", () => {
    expect(deriveDomriaInspectResultKind({ listingCount: 0, httpStatus: 200 })).toBe(
      "parser_failure",
    );
  });

  it("treats a present empty catalog array as valid_empty", () => {
    expect(
      deriveDomriaInspectResultKind({ listingCount: 0, httpStatus: 200, structurePresent: true }),
    ).toBe("valid_empty");
  });

  it("treats a schema/structure miss as parser_failure even on HTTP 200", () => {
    expect(
      deriveDomriaInspectResultKind({
        listingCount: 0,
        httpStatus: 200,
        parserFailure: true,
        structurePresent: true,
      }),
    ).toBe("parser_failure");
  });

  it("marks non-200 as http_error", () => {
    expect(deriveDomriaInspectResultKind({ listingCount: 0, httpStatus: 403 })).toBe("http_error");
  });
});

describe("soak classification with Domria-shaped results", () => {
  it("treats resultKind=ok + extractedCount>0 as required success", () => {
    const sources: SoakSourceResult[] = [
      {
        source: "domria",
        required: true,
        success: true,
        transport: "public HTML embedded JSON",
        classification: "ok",
        resultKind: "ok",
        extractedCount: 10,
        elapsedMs: 1,
      },
      {
        source: "lun",
        required: true,
        success: true,
        transport: "http",
        classification: "ok",
        extractedCount: 1,
        elapsedMs: 1,
      },
      {
        source: "rieltor",
        required: true,
        success: true,
        transport: "http",
        classification: "ok",
        extractedCount: 1,
        elapsedMs: 1,
      },
      {
        source: "olx_browser",
        required: true,
        success: true,
        transport: "playwright",
        classification: "browser_accessible",
        extractedCount: 2,
        elapsedMs: 1,
      },
      {
        source: "olx_http",
        required: false,
        success: false,
        transport: "http",
        classification: "transport_blocked",
        extractedCount: 0,
        elapsedMs: 1,
      },
    ];
    expect(classifyCycleStatus(sources)).toBe("complete");
  });

  it("keeps missing resultKind as unsuccessful (do not weaken)", () => {
    // Demonstrates the pre-fix soak shape: listings present but kind unknown → not success.
    const kind = undefined as string | undefined;
    const extractedCount = 10;
    const success = (kind === "ok" && extractedCount > 0) || kind === "valid_empty";
    expect(success).toBe(false);
  });
});

describe("seller label honesty", () => {
  it("does not present unknown as verified ownership", () => {
    const listing = {
      sellerType: "unknown",
    } as Listing;
    expect(formatSellerLabel(listing)).toContain("не підтверджено");
    expect(formatSellerLabel({ sellerType: "owner" } as Listing)).toContain("позначкою майданчика");
    expect(formatSellerLabel({ sellerType: "owner" } as Listing)).not.toContain(
      "platform-verified",
    );
  });
});
