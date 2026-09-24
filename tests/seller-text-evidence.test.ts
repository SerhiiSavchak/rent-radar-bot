import { describe, expect, it } from "vitest";
import { applySellerProfileGate } from "../src/delivery/seller-profile.ts";
import { classifyOwner, isSellerEligible } from "../src/filters/owner-filter.ts";
import type { Listing } from "../src/domain/listing.ts";
import { parseLunCard } from "../src/sources/lun/lun.parser.ts";
import { parseOlxOffer } from "../src/sources/olx/olx.parser.ts";
import { parseRieltorCard } from "../src/sources/rieltor/rieltor.parser.ts";
import { classifySellerText } from "../src/utils/text-evidence.ts";

function eligible(text: string, extra: Parameters<typeof classifyOwner>[0] = {}) {
  const result = classifyOwner({ text, platformPrivate: true, ...extra });
  return {
    result,
    send: isSellerEligible({
      sellerType: result.sellerType,
      metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
    }),
  };
}

describe("seller text evidence", () => {
  it.each([
    ["Пропозиція від агентства нерухомості", "від агентства нерухомості"],
    ["Пропозиція від агенції нерухомості", "від агенції нерухомості"],
    ["рієлторську комісію - 100 %", "рієлторська комісія"],
    ["ріелторську комісію — 50%", "рієлторська комісія"],
    ["риелторская комиссия 50%", "риелторская комиссия"],
    ["комісія рієлтора 50%", "комісія рієлтора"],
    ["Ксенія АН\nрієлторську комісію - 100 %", "рієлторська комісія"],
  ])("confirms strong copy: %s", (text, signal) => {
    const judged = classifySellerText(text);
    expect(judged.level).toBe("confirmed");
    expect(judged.strongSignals).toContain(signal);
    expect(eligible(text).send).toBe(false);
  });

  it("rejects a structured LUN realtor contact and the АН Золотий дім agency name", () => {
    const listing = parseLunCard(
      {
        id: 4725633107,
        urlRaw: "https://rieltor.ua/lvov/flats-rent/view/13071259/",
        isOwner: false,
        agency: null,
        text: "Оренда 1 к кв",
        rieltorContact: {
          contactType: "rieltor",
          name: "АН Золотий дім",
          agency: { name: "АН Золотий дім" },
        },
        site: { displayName: "rieltor.ua" },
      },
      undefined,
    );
    expect(listing?.sellerType).toBe("agent");
    expect(listing?.sellerEvidence?.join(" ")).toContain("lun.rieltorContact.contactType=rieltor");
    expect(listing?.sellerEvidence?.join(" ")).toContain("АН Золотий дім");
    expect(
      isSellerEligible({
        sellerType: listing!.sellerType,
        metadata: listing?.metadata,
      }),
    ).toBe(false);
    expect(listing?.sellerEvidence?.join(" ")).not.toMatch(/^aggregated site = rieltor\.ua$/);
  });

  it("keeps an aggregated rieltor.ua card sendable when the contact is not a realtor", () => {
    const listing = parseLunCard(
      {
        id: 1,
        isOwner: false,
        agency: null,
        text: "Оренда від власника",
        site: { displayName: "rieltor.ua" },
      },
      undefined,
    );
    expect(listing?.sellerType).toBe("unknown");
    expect(listing?.metadata?.ownerEvidenceLevel).not.toBe("intermediary");
  });

  it.each([
    [10, { agencyId: 15 }],
    [11, { platformAgent: true, offerTypeLabel: "Рієлтор" }],
    [12, { agencyName: "Агенція Дім" }],
  ])("keeps existing structured intermediary path %s", (_n, signals) => {
    expect(eligible("Оренда", signals).send).toBe(false);
  });

  it.each([
    "без комісії",
    "без рієлторської комісії",
    "рієлторам не дзвонити",
    "без рієлторів",
    "від власника, без посередників",
    "агентам не турбувати",
    "агентствам нерухомості не телефонувати",
  ])("does not confirm owner-side negation: %s", (text) => {
    const judged = classifySellerText(text);
    expect(judged.level).not.toBe("confirmed");
    expect(eligible(text).send).toBe(true);
  });

  it.each(["без співпраці", "комісія", "є інші варіанти", "ключі на руках"])(
    "sends a single supporting family: %s",
    (text) => {
      const judged = classifySellerText(text);
      expect(judged.level).toBe("unknown");
      expect(judged.supportingFamilies).toHaveLength(1);
      expect(eligible(text).send).toBe(true);
    },
  );

  it("does not treat OLX isBusiness alone as intermediary", () => {
    expect(eligible("Оренда", { isBusiness: true }).send).toBe(true);
  });

  it.each([
    "без співпраці\nє інші варіанти",
    "комісія. Підберемо варіант. Співпрацюємо з колегами",
    "ексклюзив і супровід угоди",
  ])("marks two independent families as likely: %s", (text) => {
    const judged = classifySellerText(text);
    expect(judged.level).toBe("likely");
    expect(judged.supportingFamilies.length).toBeGreaterThanOrEqual(2);
    const result = eligible(text).result;
    expect(result.sellerTextLevel).toBe("likely");
    expect(result.ownerEvidenceLevel).not.toBe("intermediary");
  });

  it("drops likely text under the client reject policy even without a seller id", () => {
    const judged = classifyOwner({ text: "без співпраці. є інші варіанти", platformPrivate: true });
    const listing = {
      source: "lun",
      sourceId: "multi",
      url: "https://lun.ua/uk/realty/1",
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment",
      sellerType: judged.sellerType,
      discoveredAt: new Date("2026-09-24T00:00:00.000Z"),
      metadata: {
        ownerEvidenceLevel: judged.ownerEvidenceLevel,
        sellerTextLevel: judged.sellerTextLevel,
      },
    } satisfies Listing;
    const gated = applySellerProfileGate(
      [listing],
      undefined,
      new Date("2026-09-24T00:00:00.000Z"),
    );
    expect(gated.dropped).toBe(1);
    expect(gated.profileLikelyIntermediary).toBe(1);
  });

  it("tolerates apostrophes, dashes, spaces and line breaks inside a strong phrase", () => {
    expect(classifySellerText("рієлторську комісію - 100 %").level).toBe("confirmed");
    expect(classifySellerText("рієлторську комісію\u2014100%").level).toBe("confirmed");
    expect(classifySellerText("РІЄЛТОРСЬКУ   КОМІСІЮ").level).toBe("confirmed");
    expect(classifySellerText("від\nагентства\nнерухомості").level).toBe("confirmed");
    expect(classifySellerText("представнику агентства нерухомості").level).toBe("confirmed");
  });

  it("lets a platform-confirmed owner override strong text and still drops a structured agency", () => {
    expect(classifySellerText("Ксенія АН").level).toBe("unknown");
    const owner = classifyOwner({
      platformOwner: true,
      text: "рієлторську комісію - 100 %",
    });
    expect(owner.sellerType).toBe("owner");
    expect(owner.sellerEvidence.join(" ")).toContain("overrides intermediary evidence");
    expect(
      isSellerEligible({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      }),
    ).toBe(true);
    const mixed = classifyOwner({
      agencyName: "АН Золотий дім",
      text: "від власника",
    });
    expect(mixed.ownerEvidenceLevel).toBe("conflict");
    expect(
      isSellerEligible({
        sellerType: mixed.sellerType,
        metadata: { ownerEvidenceLevel: mixed.ownerEvidenceLevel },
      }),
    ).toBe(false);
    expect(classifyOwner({}).ownerEvidenceLevel).toBe("private_unknown");
  });
});

function sends(listing: {
  sellerType: Listing["sellerType"];
  metadata?: Listing["metadata"];
}): boolean {
  return isSellerEligible({
    sellerType: listing.sellerType,
    metadata: listing.metadata,
  });
}

function olx(name: string | undefined, description: string, company?: string) {
  const listing = parseOlxOffer({
    id: 1,
    title: "Оренда квартири",
    description,
    url: "https://www.olx.ua/d/uk/obyavlenie/test-ID1.html",
    business: false,
    user: {
      ...(name ? { name } : {}),
      ...(company ? { company_name: company } : { company_name: null }),
      sellerType: null,
    },
  });
  if (!listing) {
    throw new Error("olx fixture did not parse");
  }
  return listing;
}

function rieltor(label: string | undefined, description: string) {
  const id = "13070001";
  const url = `https://rieltor.ua/lvov/flats-rent/view/${id}/`;
  const card = `
<div class="catalog-card " data-catalog-item-id="${id}" data-longitude="24.03" data-latitude="49.84">
  <a href="${url}" class="catalog-card-media"></a>
  <h2 class="catalog-card-address">Зелена вул.</h2>
  ${label ? `<div class="catalog-card-author-subtitle"><span>${label}</span></div>` : ""}
</div>`;
  const listing = parseRieltorCard(card, {
    category: "apartment",
    discoveredAt: new Date("2026-09-24T00:00:00.000Z"),
    jsonLd: new Map([
      [
        url,
        {
          url,
          name: "Зелена вул.",
          description,
        },
      ],
    ]),
  });
  if (!listing) {
    throw new Error("rieltor fixture did not parse");
  }
  return listing;
}

describe("seller evidence review gaps", () => {
  it("sends a normal OLX display name", () => {
    expect(sends(olx("Ксенія", "Оренда квартири"))).toBe(true);
  });

  it("treats Ксенія АН in the OLX display name as supporting only", () => {
    const listing = olx("Ксенія АН", "Оренда квартири");
    expect(listing.metadata?.sellerTextLevel).not.toBe("likely");
    expect(sends(listing)).toBe(true);
    expect(classifySellerText("Ксенія АН").supportingFamilies).toEqual(["agency_brand"]);
  });

  it("drops Ксенія АН plus realtor commission in the OLX description", () => {
    expect(sends(olx("Ксенія АН", "рієлторську комісію - 100 %"))).toBe(false);
  });

  it("still drops an OLX company_name", () => {
    expect(sends(olx("Ксенія", "Оренда квартири", "Агенція Дім"))).toBe(false);
  });

  it("drops a RIELTOR card when the description has an agency phrase and the role is missing", () => {
    expect(sends(rieltor(undefined, "Пропозиція від агентства нерухомості"))).toBe(false);
  });

  it("drops a RIELTOR card when the description has realtor commission and the role is missing", () => {
    expect(sends(rieltor(undefined, "рієлторська комісія 50%"))).toBe(false);
  });

  it("keeps a neutral RIELTOR description sendable", () => {
    expect(sends(rieltor(undefined, "Світла квартира з меблями"))).toBe(true);
  });

  it("still drops an explicit RIELTOR realtor role", () => {
    expect(sends(rieltor("Рієлтор", "Світла квартира"))).toBe(false);
  });

  it("keeps an explicit RIELTOR owner even when the description has commission text", () => {
    expect(sends(rieltor("Власник", "рієлторська комісія 50%"))).toBe(true);
  });

  it.each([
    "Не агентство нерухомості, від власника",
    "Без агентства нерухомості, власник",
    "Не агентство недвижимости, от собственника",
    "Я не рієлтор",
    "Я не риелтор",
    "Я не агент з нерухомості",
    "З рієлторами не співпрацюю. Ключі на руках.",
    "З риелторами не сотрудничаю. Ключи на руках.",
    "Агентствам недвижимости не звонить",
  ])("sends protected wording: %s", (text) => {
    expect(classifySellerText(text).level).not.toBe("confirmed");
    expect(classifySellerText(text).level).not.toBe("likely");
    expect(eligible(text).send).toBe(true);
  });

  it("keeps a later strong statement after a negated role", () => {
    expect(classifySellerText("Я не рієлтор. Рієлторська комісія 50%.").level).toBe("confirmed");
    expect(eligible("Я не рієлтор. Рієлторська комісія 50%.").send).toBe(false);
    expect(
      classifySellerText("Не агентство нерухомості. Пропозиція від агентства нерухомості.").level,
    ).toBe("confirmed");
  });

  it.each([
    "Не працюю з агентствами нерухомості",
    "З агентствами нерухомості не співпрацюю",
    "Посередникам та агентствам нерухомості прохання не телефонувати",
    "Агентствам нерухомості прохання не турбувати",
    "Квартира без агентства нерухомості",
    "Не агентство нерухомості, власник",
    "Я не брокер з нерухомості",
    "Я не агент з нерухомості",
    "Не рієлтор, здаю власну квартиру",
    "Я не спеціаліст з нерухомості",
    "Не працюю з агентствами нерухомості. Є інші варіанти.",
    "З рієлторами не співпрацюю. Ключі на руках.",
  ])("does not confirm anti-agent context: %s", (text) => {
    const judged = classifySellerText(text);
    expect(judged.level).not.toBe("confirmed");
    expect(judged.level).not.toBe("likely");
    expect(eligible(text).send).toBe(true);
  });

  it.each([
    "Пропозиція від агентства нерухомості",
    "Оголошення від агентства нерухомості",
    "Представник агентства нерухомості",
    "Агентство нерухомості Золотий Дім",
    "От агентства недвижимости",
    "Я рієлтор",
    "Брокер з нерухомості",
    "рієлторську комісію - 100 %",
  ])("confirms positive agency or role context: %s", (text) => {
    expect(classifySellerText(text).level).toBe("confirmed");
    expect(eligible(text).send).toBe(false);
  });

  it("keeps a separate positive statement after a negation", () => {
    expect(classifySellerText("Не рієлтор. Пропозиція від агентства нерухомості.").level).toBe(
      "confirmed",
    );
    expect(
      classifySellerText("Не працюю з агентствами нерухомості. Рієлторська комісія 50%.").level,
    ).toBe("confirmed");
  });

  it.each([
    ["Агентство нерухомості Золотий Дім", "агентство нерухомості"],
    ["АГЕНТСТВО НЕРУХОМОСТІ Золотий Дім", "агентство нерухомості"],
    ["Агенція нерухомості Рідний Дім", "агенція нерухомості"],
    ["Агентство недвижимости Новый Дом", "агентство недвижимости"],
  ])("confirms a cased nominative agency name: %s", (text, signal) => {
    const judged = classifySellerText(text);
    expect(judged.level).toBe("confirmed");
    expect(judged.strongSignals).toContain(signal);
    expect(eligible(text).send).toBe(false);
  });

  it.each([
    "агентство нерухомості без комісії",
    "агентство нерухомості квартира",
    "агенція нерухомості пропозиції",
    "агентство недвижимости аренда",
    "агентство нерухомості не цікавить",
    "агентство недвижимости не интересует",
  ])("does not confirm a lowercase nominative agency continuation: %s", (text) => {
    const judged = classifySellerText(text);
    expect(judged.strongSignals).not.toContain("агентство нерухомості");
    expect(judged.strongSignals).not.toContain("агенція нерухомості");
    expect(judged.strongSignals).not.toContain("агентство недвижимости");
    expect(judged.level).not.toBe("confirmed");
  });

  it("treats a cased АН brand as supporting and ignores a bare acronym", () => {
    expect(classifySellerText("Ксенія АН").supportingFamilies).toEqual(["agency_brand"]);
    expect(classifySellerText("Ксенія Ан").supportingFamilies).toEqual(["agency_brand"]);
    expect(classifySellerText("АН Золотий Дім").level).toBe("unknown");
    expect(classifySellerText("АН Золотий Дім").supportingFamilies).toEqual(["agency_brand"]);
    expect(classifySellerText("Ксенія").supportingFamilies).toEqual([]);
    expect(classifySellerText("АН").strongSignals).toEqual([]);
    expect(classifySellerText("АН").supportingFamilies).toEqual([]);
  });

  it("counts only ключі after a protected anti-realtor collaboration phrase", () => {
    const judged = classifySellerText("З рієлторами не співпрацюю. Ключі на руках.");
    expect(judged.supportingFamilies).toEqual(["transaction"]);
    expect(judged.level).toBe("unknown");
    expect(classifySellerText("Без співпраці. Є інші варіанти.").level).toBe("likely");
  });
});
