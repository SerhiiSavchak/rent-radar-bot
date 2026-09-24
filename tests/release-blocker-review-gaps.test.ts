import { describe, expect, it, vi } from "vitest";
import {
  classifyOlxLinkedSellerHtml,
  createCycleOlxSellerVerifier,
} from "../src/delivery/olx-detail-seller.ts";
import { classifyOwner, isSellerEligible, sellerRejectionReason } from "../src/filters/owner-filter.ts";
import type { Listing } from "../src/domain/listing.ts";
import { derivedOracleOfferDetailHtml } from "./fixtures/olx-offer-detail-html.ts";
import { extractOlxListingsViaBrowser } from "../src/sources/olx/olx-browser.extract.ts";
import { OLX_BROWSER_APARTMENTS_URL } from "../src/probe/olx-browser-classify.ts";
import type { Browser, Page } from "playwright";
import {
  derivedOracleApartmentPrivateAd,
  derivedOracleMainDocumentHtml,
} from "./fixtures/olx-prerendered-oracle-derived.ts";

function lunOwner(sourceId: string, token: string): Listing {
  return {
    source: "lun",
    sourceId,
    url: `https://lun.ua/uk/realty/${sourceId}`,
    title: "Квартира",
    location: { raw: "Львів" },
    propertyType: "apartment",
    sellerType: "owner",
    discoveredAt: new Date("2026-09-24T10:00:00.000Z"),
    publishedAt: new Date("2026-09-24T09:00:00.000Z"),
    metadata: {
      ownerEvidenceLevel: "platform_confirmed",
      originalUrl: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${token}.html`,
    },
  };
}

describe("release blocker review gaps — OLX identity and browser fallback", () => {
  it("rejects neutral company when seller name is a realtor brand", () => {
    const owner = classifyOwner({
      agencyName: "Хата Інвест",
      sellerIdentityName: "Рієлтор Олена",
      text: "Здам квартиру",
    });
    expect(sellerRejectionReason({
      sellerType: owner.sellerType,
      metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
    })).toBeTruthy();
  });

  it("does not invent intermediary from neutral company + ordinary seller name", () => {
    const owner = classifyOwner({
      agencyName: "Хата Інвест",
      sellerIdentityName: "Олена",
      text: "Здам квартиру",
    });
    expect(owner.ownerEvidenceLevel).not.toBe("intermediary");
    expect(owner.ownerEvidenceLevel).not.toBe("conflict");
    expect(
      isSellerEligible({
        sellerType: owner.sellerType,
        metadata: { ownerEvidenceLevel: owner.ownerEvidenceLevel },
      }),
    ).toBe(true);
  });

  it("A: raw OLX 403 -> browser West Realty -> reject", async () => {
    let browserCalls = 0;
    const token = "99wRst";
    const html = derivedOracleOfferDetailHtml({
      id: 99,
      url: `https://www.olx.ua/d/obyavlenie/orenda-ID${token}.html`,
      title: "Квартира",
      description: "Здам",
      user: { name: "West Realty", company_name: "West Realty", sellerType: null },
      isBusiness: false,
    });
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-24T10:00:00.000Z"),
      timeoutMs: 5000,
      fetchPage: async () => ({
        status: 403,
        finalUrl: `https://www.olx.ua/d/obyavlenie/orenda-ID${token}.html`,
        bodyText: "blocked",
      }),
      fetchViaBrowser: async (url) => {
        browserCalls += 1;
        return {
          status: 200,
          finalUrl: url,
          bodyText: html,
          browserClosed: true,
          browserCloseTimedOut: false,
          timedOut: false,
          notes: ["test"],
        };
      },
    });
    const decision = await verify(lunOwner("700", token));
    expect(browserCalls).toBe(1);
    expect(decision.drop).toBe(true);
    expect(decision.outcome).toBe("detail_confirmed_agent");
    expect(decision.evidence).toMatch(/West Realty|browser fallback/i);
  });

  it("B: raw OLX 403 -> browser unavailable -> unknown/hold path", async () => {
    const token = "88fail";
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-24T10:00:00.000Z"),
      timeoutMs: 5000,
      fetchPage: async () => ({
        status: 403,
        finalUrl: `https://www.olx.ua/d/obyavlenie/orenda-ID${token}.html`,
        bodyText: "blocked",
      }),
      fetchViaBrowser: async () => ({
        status: 0,
        finalUrl: `https://www.olx.ua/d/obyavlenie/orenda-ID${token}.html`,
        bodyText: "",
        browserClosed: true,
        browserCloseTimedOut: false,
        timedOut: true,
        notes: ["navigation_timeout"],
      }),
    });
    const decision = await verify(lunOwner("701", token));
    expect(decision.drop).toBe(false);
    expect(decision.outcome).toBe("detail_transport_failure");
    expect(decision.evidence).not.toMatch(/confirmed owner/i);
  });

  it("C: raw OLX 200 -> browser fallback is not launched", async () => {
    let browserCalls = 0;
    const token = "77okOK";
    const html = derivedOracleOfferDetailHtml({
      id: 77,
      url: `https://www.olx.ua/d/obyavlenie/orenda-ID${token}.html`,
      title: "Квартира",
      description: "Здам",
      user: { name: "Олена", company_name: null, sellerType: null },
      isBusiness: false,
    });
    const verify = createCycleOlxSellerVerifier({
      peers: [],
      now: () => new Date("2026-09-24T10:00:00.000Z"),
      timeoutMs: 5000,
      fetchPage: async (url) => ({
        status: 200,
        finalUrl: url,
        bodyText: html,
      }),
      fetchViaBrowser: async () => {
        browserCalls += 1;
        throw new Error("browser must not run");
      },
    });
    const decision = await verify(lunOwner("702", token));
    expect(browserCalls).toBe(0);
    expect(decision.drop).toBe(false);
    expect(decision.requested).toBe(true);
  });

  it("classifies HTML with realtor seller name despite neutral company_name", () => {
    const html = derivedOracleOfferDetailHtml({
      id: 55,
      url: "https://www.olx.ua/d/obyavlenie/orenda-ID55name.html",
      title: "Квартира",
      description: "Здам",
      user: { name: "Рієлтор Олена", company_name: "Хата Інвест", sellerType: null },
      isBusiness: false,
    });
    expect(classifyOlxLinkedSellerHtml(html, "55name").verdict).toBe("confirmed_intermediary");
  });

  it("M: browser.close timeout is reported as browserClosed=false", async () => {
    const ads = [derivedOracleApartmentPrivateAd()];
    const main = derivedOracleMainDocumentHtml(ads);
    let nowMs = 0;
    let lastUrl = OLX_BROWSER_APARTMENTS_URL;
    const page = {
      on: vi.fn(),
      goto: vi.fn(async (navUrl: string) => {
        lastUrl = navUrl;
        nowMs += 20;
        return {
          url: () => navUrl,
          status: () => 200,
          headers: () => ({ "content-type": "text/html; charset=utf-8" }),
          body: async () => Buffer.from(main, "utf8"),
        };
      }),
      waitForLoadState: vi.fn(async () => undefined),
      content: vi.fn(async () => main),
      url: () => lastUrl,
      title: async () => "OLX",
      close: vi.fn(async () => undefined),
    } as unknown as Page;
    const browser = {
      newContext: async () => ({
        newPage: async () => page,
        close: vi.fn(async () => undefined),
      }),
      close: () => new Promise<void>(() => undefined),
    } as unknown as Browser;

    const result = await extractOlxListingsViaBrowser({
      timeoutMs: 80,
      categoryBudgetMs: 80,
      totalBudgetMs: 200,
      cleanupBudgetMs: 30,
      launch: async () => browser,
      clockMs: () => nowMs,
    });
    expect(result.timing.browserCloseTimedOut).toBe(true);
    expect(result.browserClosed).toBe(false);
    expect(result.notes.some((note) => note.includes("cleanup_budget_hit"))).toBe(true);
  });
});
