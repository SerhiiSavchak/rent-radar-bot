import { describe, expect, it } from "vitest";
import {
  classifyOlxProfileInventory,
  findOlxPublicProfilePath,
  mergeOlxProfilePages,
  OLX_PROFILE_FAILURE_TTL_MS,
  OLX_PROFILE_LIKELY_TTL_MS,
  OLX_PROFILE_REAL_ESTATE_MIN,
  OLX_PROFILE_UNKNOWN_TTL_MS,
  olxProfileCacheState,
  olxProfileEvidence,
  parseOlxProfileInventory,
} from "../src/sources/olx/olx-seller-profile.ts";

describe("OLX public profile inventory", () => {
  it("reads the profile path from the listing page and the userListing counters", () => {
    expect(findOlxPublicProfilePath('<a href="/uk/list/user/1YzaQC/">усі оголошення</a>')).toBe(
      "/uk/list/user/1YzaQC/",
    );
    const nadia = parseOlxProfileInventory({
      userListing: {
        userListing: {
          pageNumber: 1,
          totalElements: 6,
          totalPages: 1,
          ads: [
            { category: { type: "real_estate", id: 1760 } },
            { category: { type: "accommodation", id: 3711 } },
          ],
        },
      },
    });
    expect(nadia.visibleAds).toBe(2);
    expect(nadia.realEstateAds).toBe(1);
    expect(classifyOlxProfileInventory(nadia).verdict).toBe("unknown");

    const nadiaLive = classifyOlxProfileInventory({
      acquired: true,
      totalPages: 1,
      totalElements: 6,
      visibleAds: 6,
      realEstateAds: 2,
      realEstateRatio: 2 / 6,
    });
    expect(nadiaLive.verdict).toBe("unknown");
    expect(nadiaLive.evidence).toContain("olx_real_estate_count=2");

    const tkachukPage = parseOlxProfileInventory({
      userListing: {
        userListing: {
          pageNumber: 1,
          totalElements: 13,
          totalPages: 2,
          ads: Array.from({ length: 10 }, () => ({ category: { type: "real_estate", id: 330 } })),
        },
      },
    });
    const tkachuk = mergeOlxProfilePages(tkachukPage, {
      acquired: true,
      totalPages: 2,
      totalElements: 13,
      visibleAds: 3,
      realEstateAds: 3,
    });
    expect(tkachuk.realEstateAds).toBe(13);
    expect(classifyOlxProfileInventory(tkachuk).verdict).toBe("profile_likely_intermediary");
    expect(classifyOlxProfileInventory(tkachuk).evidence).toContain("olx_real_estate_count=13");
  });

  it("does not treat a failed profile read or a business flag as an owner", () => {
    expect(classifyOlxProfileInventory({ acquired: false }).verdict).toBe("unknown");
    expect(classifyOlxProfileInventory({ acquired: false }).evidence).toContain("unreadable");
    const businessOnly = classifyOlxProfileInventory({
      acquired: true,
      totalPages: 1,
      totalElements: 1,
      visibleAds: 1,
      realEstateAds: 1,
    });
    expect(businessOnly.verdict).toBe("unknown");
    expect(
      olxProfileCacheState(
        "olx_unreadable=1;olx_checked_at=2026-09-23T12:00:00.000Z",
        new Date("2026-09-23T12:30:00.000Z"),
      ),
    ).toBe("fresh_unknown");
  });

  it("keeps a two-page profile with one real-estate ad sendable", () => {
    const decision = classifyOlxProfileInventory({
      acquired: true,
      totalPages: 2,
      totalElements: 15,
      visibleAds: 15,
      realEstateAds: 1,
      realEstateRatio: 1 / 15,
    });
    expect(decision.verdict).toBe("unknown");
    expect(decision.evidence).toContain("olx_real_estate_count=1");
    expect(OLX_PROFILE_REAL_ESTATE_MIN).toBe(10);
  });

  it("uses a short TTL for unknown profiles and a long TTL for likely profiles", () => {
    const checked = new Date("2026-09-24T12:00:00.000Z");
    const likely = olxProfileEvidence(
      {
        acquired: true,
        totalPages: 2,
        totalElements: 13,
        visibleAds: 13,
        realEstateAds: 13,
      },
      checked,
    );
    const unknown = olxProfileEvidence(
      {
        acquired: true,
        totalPages: 1,
        totalElements: 6,
        visibleAds: 6,
        realEstateAds: 2,
      },
      checked,
    );
    const at = (ms: number) => new Date(checked.getTime() + ms);
    expect(OLX_PROFILE_UNKNOWN_TTL_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(OLX_PROFILE_UNKNOWN_TTL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(OLX_PROFILE_UNKNOWN_TTL_MS).toBeLessThan(OLX_PROFILE_LIKELY_TTL_MS);
    expect(OLX_PROFILE_LIKELY_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(OLX_PROFILE_FAILURE_TTL_MS).toBe(60 * 60 * 1000);
    expect(olxProfileCacheState(likely, at(60 * 60 * 1000))).toBe("fresh_likely");
    expect(olxProfileCacheState(likely, at(OLX_PROFILE_LIKELY_TTL_MS + 1))).toBe("stale");
    expect(olxProfileCacheState(unknown, at(10 * 60 * 1000))).toBe("fresh_unknown");
    expect(olxProfileCacheState(unknown, at(OLX_PROFILE_UNKNOWN_TTL_MS + 1))).toBe("stale");
    expect(olxProfileCacheState(likely, at(OLX_PROFILE_UNKNOWN_TTL_MS + 1))).toBe("fresh_likely");
    expect(
      olxProfileCacheState(
        `olx_unreadable=1;olx_checked_at=${checked.toISOString()}`,
        at(30 * 60 * 1000),
      ),
    ).toBe("fresh_unknown");
    expect(
      olxProfileCacheState(
        "olx_pages=2;olx_total=13;olx_real_estate=1;olx_checked_at=2026-09-24T12:00:00.000Z",
        at(0),
      ),
    ).toBe("stale");
  });
});
