import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Browser, Page, Response } from "playwright";
import { isOwnerEligible } from "../src/filters/owner-filter.ts";
import { inspectOlxOfferDetailHtml } from "../src/sources/olx/olx-browser.detail-inspect.ts";
import {
  inspectOlxOwnerDetailViaBrowser,
  isOlxOfferDetailHtmlResponse,
} from "../src/sources/olx/olx-browser.owner-detail.ts";
import { OLX_OWNER_DETAIL_CANDIDATE } from "../src/sources/olx/olx-owner-detail.candidate.ts";
import { derivedOracleHousePrivateAd } from "./fixtures/olx-prerendered-oracle-derived.ts";
import {
  derivedOracleOfferDetailChallengeHtml,
  derivedOracleOfferDetailHtml,
  derivedOracleOfferDetailMissingSellerHtml,
  derivedOracleOfferDetailOwnerHtml,
} from "./fixtures/olx-offer-detail-html.ts";

describe("OLX owner-detail candidate provenance", () => {
  it("records the baab323 house URL, not a 75f7384 sample", () => {
    expect(OLX_OWNER_DETAIL_CANDIDATE.generatingCommit).toBe(
      "baab3230824bc4e976cae50c6ad2c9ded2e91467",
    );
    expect(OLX_OWNER_DETAIL_CANDIDATE.captureId).toBe("capture-1789666022490");
    expect(OLX_OWNER_DETAIL_CANDIDATE.sourceId).toBe("924128798");
    expect(OLX_OWNER_DETAIL_CANDIDATE.url).toBe(derivedOracleHousePrivateAd().url);
    expect(OLX_OWNER_DETAIL_CANDIDATE.url).toMatch(/ID10xy7c\.html$/);
    expect(OLX_OWNER_DETAIL_CANDIDATE.catalogUserSellerType).toBeNull();
    expect(OLX_OWNER_DETAIL_CANDIDATE.catalogIsBusiness).toBe(false);
  });
});

describe("OLX offer detail HTML inspection", () => {
  it("keeps a null sellerType as unknown platform label, not ownership", () => {
    const html = derivedOracleOfferDetailHtml(derivedOracleHousePrivateAd());
    const result = inspectOlxOfferDetailHtml(html, "924128798");
    expect(result.offerRecordFound).toBe(true);
    expect(result.matchedExpectedId).toBe(true);
    expect(result.sellerTypeField).toEqual({ present: true, value: null });
    expect(result.platformLabel).toBe("null");
    expect(result.accountType).toBe("private");
    expect(result.sellerAuthoredSelfDeclared).toBe(true);
    expect(result.ownerEvidenceLevel).toBe("self_declared");
    expect(result.strongerThanCatalogSelfDeclared).toBe(false);
    expect(result.defaultOwnerGateWouldAccept).toBe(true);
    expect(
      isOwnerEligible({
        sellerType: "unknown",
        metadata: { ownerEvidenceLevel: result.ownerEvidenceLevel },
      }),
    ).toBe(false);
  });

  it("treats a structured sellerType=owner as stronger platform evidence", () => {
    const result = inspectOlxOfferDetailHtml(derivedOracleOfferDetailOwnerHtml(), "924128798");
    expect(result.sellerTypeField).toEqual({ present: true, value: "owner" });
    expect(result.platformLabel).toBe("owner");
    expect(result.ownerEvidenceLevel).toBe("platform_confirmed");
    expect(result.strongerThanCatalogSelfDeclared).toBe(true);
    expect(result.defaultOwnerGateWouldAccept).toBe(true);
  });

  it("leaves an absent sellerType field unknown", () => {
    const result = inspectOlxOfferDetailHtml(
      derivedOracleOfferDetailMissingSellerHtml(),
      "924128798",
    );
    expect(result.sellerTypeField).toEqual({ present: false });
    expect(result.platformLabel).toBe("unknown");
    expect(result.notes).toContain("sellerType_field_absent");
    expect(result.strongerThanCatalogSelfDeclared).toBe(false);
  });

  it("does not treat owner-seeking copy as a self-declaration", () => {
    const ad = {
      ...derivedOracleHousePrivateAd(),
      title: "Looking for an owner, owners contact us",
      description: "",
    };
    const result = inspectOlxOfferDetailHtml(derivedOracleOfferDetailHtml(ad), "924128798");
    expect(result.sellerAuthoredSelfDeclared).toBe(false);
    expect(result.sellerAuthoredMisleadingOwnerSeeking).toBe(true);
    expect(result.ownerEvidenceLevel).toBe("private_unknown");
  });

  it("does not invent an offer when prerendered state is missing", () => {
    const result = inspectOlxOfferDetailHtml(derivedOracleOfferDetailChallengeHtml(), "924128798");
    expect(result.offerRecordFound).toBe(false);
    expect(result.sellerTypeField).toEqual({ present: false });
    expect(result.ownerEvidenceLevel).toBe("unknown");
    expect(result.strongerThanCatalogSelfDeclared).toBe(false);
  });
});

describe("OLX owner-detail browser diagnostic", () => {
  it("accepts the recorded canonical offer URL as detail HTML", () => {
    expect(
      isOlxOfferDetailHtmlResponse({
        requestedUrl: OLX_OWNER_DETAIL_CANDIDATE.url,
        responseUrl: OLX_OWNER_DETAIL_CANDIDATE.url,
        contentType: "text/html; charset=utf-8",
      }),
    ).toBe(true);
  });

  it("does one goto, skips offers API, and always closes the browser", async () => {
    const html = derivedOracleOfferDetailHtml(derivedOracleHousePrivateAd());
    const content = vi.fn(async () => {
      throw new Error("page.content() must not run for the owner-detail diagnostic");
    });
    const pageOn = vi.fn();
    const pageClose = vi.fn(async () => undefined);
    const contextClose = vi.fn(async () => undefined);
    const browserClose = vi.fn(async () => undefined);
    const goto = vi.fn(async (navUrl: string) => {
      return {
        url: () => navUrl,
        status: () => 200,
        headers: () => ({ "content-type": "text/html; charset=utf-8" }),
        body: async () => Buffer.from(html, "utf8"),
        json: async () => {
          throw new Error("/api/v1/offers must not be fetched");
        },
      } as unknown as Response;
    });
    const page = {
      on: pageOn,
      goto,
      content,
      url: () => OLX_OWNER_DETAIL_CANDIDATE.url,
      title: async () => "OLX",
      close: pageClose,
    } as unknown as Page;
    const browser = {
      newContext: async () => ({
        newPage: async () => page,
        close: contextClose,
      }),
      close: browserClose,
    } as unknown as Browser;

    const result = await inspectOlxOwnerDetailViaBrowser({
      timeoutMs: 5_000,
      launch: async () => browser,
    });

    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith(OLX_OWNER_DETAIL_CANDIDATE.url, {
      waitUntil: "domcontentloaded",
      timeout: 5_000,
    });
    expect(pageOn).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(result.navigations).toBe(1);
    expect(result.offersApiIntercepted).toBe(false);
    expect(result.browserClosed).toBe(true);
    expect(browserClose).toHaveBeenCalled();
    expect(contextClose).toHaveBeenCalled();
    expect(result.inspection.ownerEvidenceLevel).toBe("self_declared");
    expect(result.inspection.strongerThanCatalogSelfDeclared).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("reports timeout and still closes when navigation times out", async () => {
    const pageClose = vi.fn(async () => undefined);
    const contextClose = vi.fn(async () => undefined);
    const browserClose = vi.fn(async () => undefined);
    const page = {
      on: vi.fn(),
      goto: vi.fn(async () => {
        throw new Error("page.goto: Timeout 50ms exceeded");
      }),
      content: vi.fn(),
      url: () => OLX_OWNER_DETAIL_CANDIDATE.url,
      title: async () => "",
      close: pageClose,
    } as unknown as Page;
    const browser = {
      newContext: async () => ({
        newPage: async () => page,
        close: contextClose,
      }),
      close: browserClose,
    } as unknown as Browser;

    const result = await inspectOlxOwnerDetailViaBrowser({
      timeoutMs: 50,
      launch: async () => browser,
    });
    expect(result.timedOut).toBe(true);
    expect(result.browserClosed).toBe(true);
    expect(browserClose).toHaveBeenCalled();
    expect(result.notes.some((note) => note.includes("navigation_timeout"))).toBe(true);
  });

  it("writes a redacted detail capture outside the inspection return payload cookies", async () => {
    const root = mkdtempSync(join(tmpdir(), "olx-detail-"));
    const html = derivedOracleOfferDetailHtml(derivedOracleHousePrivateAd());
    const page = {
      on: vi.fn(),
      goto: vi.fn(async (navUrl: string) => ({
        url: () => navUrl,
        status: () => 200,
        headers: () => ({ "content-type": "text/html" }),
        body: async () => Buffer.from(html, "utf8"),
      })),
      content: vi.fn(),
      url: () => OLX_OWNER_DETAIL_CANDIDATE.url,
      title: async () => "OLX",
      close: vi.fn(async () => undefined),
    } as unknown as Page;
    const browser = {
      newContext: async () => ({
        newPage: async () => page,
        close: vi.fn(async () => undefined),
      }),
      close: vi.fn(async () => undefined),
    } as unknown as Browser;
    try {
      const result = await inspectOlxOwnerDetailViaBrowser({
        timeoutMs: 5_000,
        launch: async () => browser,
        captureDir: root,
        commit: "testcommit",
      });
      const manifest = JSON.parse(readFileSync(result.capturePaths!.manifestPath, "utf8")) as {
        requestedUrl: string;
        commit: string;
      };
      expect(manifest.commit).toBe("testcommit");
      expect(manifest.requestedUrl).toContain("ID10xy7c");
      expect(manifest.requestedUrl).not.toMatch(/cookie|token=/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
