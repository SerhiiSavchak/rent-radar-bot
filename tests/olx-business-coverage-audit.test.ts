import { describe, expect, it } from "vitest";
import {
  classifyBusinessCoverageEvidence,
  crosscheckIdentities,
  hasPositiveOwnerSignal,
} from "../src/scripts/olx-business-coverage-evidence.ts";

describe("business coverage evidence", () => {
  it("does not treat a business account flag as intermediary evidence", () => {
    const judged = classifyBusinessCoverageEvidence({
      sellerType: null,
      text: "Здам квартиру на тривалий термін",
    });
    expect(judged.outcome).toBe("AMBIGUOUS");
  });

  it("keeps an explicit owner statement as self-declared", () => {
    const text = "Здам квартиру від власника на тривалий термін";
    expect(hasPositiveOwnerSignal({ sellerType: null, text })).toBe(true);
    expect(classifyBusinessCoverageEvidence({ sellerType: null, text }).outcome).toBe(
      "SELF_DECLARED_OWNER",
    );
  });

  it("queues a bare owner word for review without upgrading the classifier", () => {
    const text = "Власник, здам квартиру на тривалий термін";
    expect(hasPositiveOwnerSignal({ sellerType: null, text })).toBe(true);
    expect(classifyBusinessCoverageEvidence({ sellerType: null, text }).outcome).toBe("AMBIGUOUS");
  });

  it("rejects registration year 2026 before owner text", () => {
    const judged = classifyBusinessCoverageEvidence({
      sellerType: null,
      text: "Власник, здам квартиру",
      registrationYear: 2026,
    });
    expect(judged.outcome).toBe("REJECT_REGISTRATION_YEAR_2026");
  });

  it("rejects five precise properties and keeps an obvious agency out of owner", () => {
    expect(
      classifyBusinessCoverageEvidence({
        sellerType: null,
        text: "Власник, здам квартиру",
        preciseProperties: 5,
      }).outcome,
    ).toBe("REJECT_INVENTORY_LIMIT");
    expect(
      classifyBusinessCoverageEvidence({
        sellerType: null,
        companyName: "АН Центральна",
        text: "Власник, здам квартиру",
      }).outcome,
    ).toBe("CONFIRMED_INTERMEDIARY");
  });

  it("crosschecks exact ids and ignores title similarity", () => {
    const result = crosscheckIdentities(
      [{ sourceId: "1", token: "aaa", url: "https://www.olx.ua/d/uk/obyavlenie/a-IDaaa.html" }],
      [
        { sourceId: "1", token: "aaa", url: "https://www.olx.ua/d/uk/obyavlenie/a-IDaaa.html" },
        { sourceId: "2", token: "bbb", url: "https://www.olx.ua/d/uk/obyavlenie/b-IDbbb.html" },
      ],
    );
    expect(result.idOverlap).toEqual(["1"]);
    expect(result.onlyBusiness).toEqual(["2"]);
    expect(result.tokenOverlap).toEqual(["aaa"]);
    expect(result.urlOverlap).toEqual(["https://www.olx.ua/d/uk/obyavlenie/a-idaaa.html"]);
  });
});
