import { describe, expect, it } from "vitest";
import {
  classifyOwner,
  isSellerEligible,
  sellerAssessmentFromClassification,
  sellerRejectionReason,
} from "../src/filters/owner-filter.ts";
import {
  classifySellerText,
  hasExplicitIntermediaryText,
} from "../src/utils/text-evidence.ts";

function rejected(text: string, extra: Parameters<typeof classifyOwner>[0] = {}) {
  const result = classifyOwner({ text, ...extra });
  return {
    result,
    send: isSellerEligible({
      sellerType: result.sellerType,
      metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
    }),
    reason: sellerRejectionReason({
      sellerType: result.sellerType,
      metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
    }),
  };
}

describe("strong intermediary markers — АН token boundaries", () => {
  it.each([
    'АН "Назва"',
    "АН: X",
    "АН-X",
    "(АН) X",
    "представник АН",
    "АН нерухомість",
    "Представник АН",
    "АН: X-House",
    "АН - Місто",
  ])("rejects lexical АН marker: %j", (text) => {
    expect(hasExplicitIntermediaryText(text)).toBe(true);
    expect(classifySellerText(text).level).toBe("confirmed");
    expect(rejected(text, { platformPrivate: true }).send).toBe(false);
  });

  it.each(["А.Н. Галичина", "А.Н X-House"])("rejects dotted А.Н. form: %j", (text) => {
    expect(hasExplicitIntermediaryText(text)).toBe(true);
    expect(rejected(text).send).toBe(false);
  });

  it.each(["Іван", "варіант", "пані", "стан", "дані", "банк"])(
    "does not treat embedded letters as АН: %j",
    (text) => {
      expect(hasExplicitIntermediaryText(text)).toBe(false);
      expect(classifySellerText(text).strongSignals).not.toContain("АН");
      expect(rejected(text, { platformPrivate: true }).send).toBe(true);
    },
  );
});

describe("strong intermediary markers — agency / realtor phrases", () => {
  it.each([
    "агентство нерухомості",
    "Агентство нерухомості пропонує квартиру",
    "агенція нерухомості",
    "агентство недвижимости",
    "агентство по недвижимости",
  ])("rejects agency phrase: %j", (text) => {
    expect(hasExplicitIntermediaryText(text)).toBe(true);
    expect(rejected(text, { platformPrivate: true }).send).toBe(false);
  });

  it.each([
    "ріелтор",
    "рієлтор",
    "риелтор",
    "риэлтор",
    "працює ріелтора",
    "послуги ріелторів",
    "realtor",
    "realtors",
  ])("rejects realtor lexical form: %j", (text) => {
    expect(hasExplicitIntermediaryText(text)).toBe(true);
    expect(rejected(text).send).toBe(false);
  });

  it("rejects explicit intermediary commission phrases already in taxonomy", () => {
    expect(rejected("комісія ріелтору 50%").send).toBe(false);
    expect(rejected("комиссия агентству").send).toBe(false);
    expect(rejected("представник агентства").send).toBe(false);
  });
});

describe("strong intermediary markers — precedence", () => {
  it("agency marker wins over self-declared owner text", () => {
    const { result, send } = rejected("я власник, АН X-House", {
      platformPrivate: true,
    });
    expect(send).toBe(false);
    expect(["intermediary", "conflict"]).toContain(result.ownerEvidenceLevel);
    expect(result.sellerType).not.toBe("owner");
  });

  it("OLX Private + agency marker → reject", () => {
    const { send, result } = rejected('АН "X-House"', { platformPrivate: true });
    expect(result.ownerEvidenceLevel).not.toBe("private_unknown");
    expect(send).toBe(false);
  });

  it("weak bare комісія alone is not a strong agency marker", () => {
    const judged = classifySellerText("комісія 50%");
    expect(judged.level).not.toBe("confirmed");
    expect(judged.strongSignals).toEqual([]);
    expect(rejected("комісія 50%", { platformPrivate: true }).send).toBe(true);
  });

  it("без комісії is neither confirmed owner nor strong intermediary", () => {
    const result = classifyOwner({ text: "без комісії", platformPrivate: true });
    expect(result.sellerType).not.toBe("owner");
    expect(result.ownerEvidenceLevel).not.toBe("platform_confirmed");
    expect(classifySellerText("без комісії").level).not.toBe("confirmed");
    expect(
      isSellerEligible({
        sellerType: result.sellerType,
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      }),
    ).toBe(true);
  });

  it("LUN aggregator owner yields to strong АН text", () => {
    const result = classifyOwner({
      platformOwner: true,
      aggregatorOwner: true,
      text: 'АН "Галичина"',
    });
    expect(["conflict", "intermediary"]).toContain(result.ownerEvidenceLevel);
    expect(
      isSellerEligible({
        sellerType: result.sellerType,
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      }),
    ).toBe(false);
  });

  it("platform-confirmed owner + strong free-text agency → conflict (not silent confirm)", () => {
    // Precedence: trusted platform owner and strong free-text intermediary contradict.
    // Conflict rejects under reject_intermediaries — never silently send as confirmed_owner.
    const result = classifyOwner({
      platformOwner: true,
      text: 'АН "X-House"',
    });
    expect(result.ownerEvidenceLevel).toBe("conflict");
    expect(result.sellerType).not.toBe("owner");
    expect(sellerAssessmentFromClassification(result).state).toBe("confirmed_agent");
    expect(
      isSellerEligible({
        sellerType: result.sellerType,
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      }),
    ).toBe(false);
  });
});
