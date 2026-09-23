import { describe, expect, it } from "vitest";
import {
  classifyOlxProfileInventory,
  findOlxPublicProfilePath,
  olxProfileCacheState,
  parseOlxProfileInventory,
} from "../src/sources/olx/olx-seller-profile.ts";

describe("OLX public profile inventory", () => {
  it("reads the profile path from the listing page and the userListing counters", () => {
    expect(
      findOlxPublicProfilePath('<a href="/uk/list/user/1YzaQC/">усі оголошення</a>'),
    ).toBe("/uk/list/user/1YzaQC/");
    const nadia = parseOlxProfileInventory({
      userListing: {
        userListing: {
          pageNumber: 1,
          totalElements: 6,
          totalPages: 1,
          ads: [{ category: { type: "real_estate", id: 1760 } }, { category: { type: "accommodation", id: 3711 } }],
        },
      },
    });
    expect(classifyOlxProfileInventory(nadia).verdict).toBe("unknown");

    const tkachuk = parseOlxProfileInventory({
      userListing: {
        userListing: {
          pageNumber: 1,
          totalElements: 13,
          totalPages: 2,
          ads: [{ category: { type: "real_estate", id: 330 } }],
        },
      },
    });
    expect(classifyOlxProfileInventory(tkachuk).verdict).toBe("profile_likely_intermediary");
  });

  it("does not treat a failed profile read or a business flag as an owner", () => {
    expect(classifyOlxProfileInventory({ acquired: false }).verdict).toBe("unknown");
    expect(classifyOlxProfileInventory({ acquired: false }).evidence).toContain("unreadable");
    const businessOnly = classifyOlxProfileInventory({
      acquired: true,
      totalPages: 1,
      totalElements: 1,
      realEstateOnPage: true,
    });
    expect(businessOnly.verdict).toBe("unknown");
    expect(
      olxProfileCacheState("olx_unreadable=1;olx_checked_at=2026-09-23T12:00:00.000Z", new Date("2026-09-23T12:30:00.000Z")),
    ).toBe("fresh_unknown");
  });

  it("does not reject two pages that are not real estate", () => {
    const decision = classifyOlxProfileInventory({
      acquired: true,
      totalPages: 2,
      totalElements: 15,
      realEstateOnPage: false,
    });
    expect(decision.verdict).toBe("unknown");
  });
});
