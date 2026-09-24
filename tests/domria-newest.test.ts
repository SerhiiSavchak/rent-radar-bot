import { describe, expect, it } from "vitest";
import { classifyListingFreshness } from "../src/delivery/listing-freshness.ts";
import { InMemoryListingDedupe } from "../src/delivery/listing-dedupe-memory.ts";
import { isSellerEligible } from "../src/filters/owner-filter.ts";
import {
  acquireDomriaNewest,
  buildDomriaNewestSearchUrl,
  mergeDomriaAcquiredIds,
  planDomriaDetailFetches,
  type DomriaFetchResponse,
} from "../src/sources/domria/domria-newest.ts";

const MISSED_OWNER_ID = "34953276";

function searchBody(ids: number[]): string {
  return JSON.stringify({ count: ids.length, items: ids });
}

function dataCard(id: string, published: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    realty_id: Number(id),
    beautiful_url: `realty-${id}.html`,
    city_name_uk: "Львів",
    street_name_uk: "вул. Володимира Великого",
    publishing_date: published,
    price: 25000,
    currency_type: "грн",
    realty_type_id: 2,
    advert_type_name_uk: "довгострокова оренда",
    user_id: 488374,
    latitude: 49.83,
    longitude: 24.03,
    description_uk: "Квартира",
    ...overrides,
  });
}

function pageState(id: string, role: number | undefined): unknown {
  return {
    catalog: { realtyForCatalog: [] },
    card: {
      realty_id: Number(id),
      ...(role !== undefined ? { characteristics_values: { "1437": role } } : {}),
    },
  };
}

function scriptedGet(
  routes: Record<string, DomriaFetchResponse | (() => DomriaFetchResponse)>,
): ((url: string) => Promise<DomriaFetchResponse>) & { calls: string[] } {
  const calls: string[] = [];
  const get = (async (url: string): Promise<DomriaFetchResponse> => {
    calls.push(url);
    const route = Object.entries(routes).find(([key]) => url.includes(key));
    if (!route) {
      throw new Error(`unexpected ${url}`);
    }
    const value = route[1];
    return typeof value === "function" ? value() : value;
  }) as ((url: string) => Promise<DomriaFetchResponse>) & { calls: string[] };
  get.calls = calls;
  return get;
}

describe("DIM.RIA newest-first acquisition", () => {
  it("requests apartments and houses with the live newest-first parameters", () => {
    const apartments = buildDomriaNewestSearchUrl("apartment");
    const houses = buildDomriaNewestSearchUrl("house");
    expect(apartments).toContain("sort=created_at");
    expect(apartments).toContain("category=1");
    expect(apartments).toContain("realty_type=2");
    expect(apartments).toContain("operation_type=3");
    expect(apartments).toContain("city_ids=5");
    expect(houses).toContain("category=4");
    expect(houses).toContain("realty_type=0");
    expect(houses).toContain("sort=created_at");
    expect(apartments).not.toContain("arenda-kvartir");
    expect(houses).not.toContain("arenda-domov");
  });

  it("acquires ids from searchEngine and skips known ids", async () => {
    const get = scriptedGet({
      "searchEngine/v2/": { status: 200, url: "search", bodyText: searchBody([1, 2, 3]) },
      "realty/data/3": { status: 200, url: "data-3", bodyText: dataCard("3", "2026-09-24 11:07:26") },
      "realty-3.html": { status: 200, url: "page-3", bodyText: "page" },
    });
    const result = await acquireDomriaNewest({
      categories: ["apartment"],
      knownIds: new Set(["1", "2"]),
      get,
      extractState: () => pageState("3", 1436),
    });
    expect(result.listings.map((item) => item.sourceId)).toEqual(["3"]);
    expect(result.persistIds).toEqual(["3"]);
    expect(get.calls.some((url) => url.includes("realty/data/1"))).toBe(false);
    expect(get.calls.some((url) => url.includes("realty/data/2"))).toBe(false);
    expect(get.calls.some((url) => url.includes("arenda-kvartir"))).toBe(false);
  });

  it("emits the missed-owner shape as a platform-confirmed owner", async () => {
    const get = scriptedGet({
      "searchEngine/v2/": { status: 200, url: "search", bodyText: searchBody([Number(MISSED_OWNER_ID)]) },
      [`realty/data/${MISSED_OWNER_ID}`]: {
        status: 200,
        url: "data",
        bodyText: dataCard(MISSED_OWNER_ID, "2026-09-24 11:07:26", {
          characteristics_values: {},
          agency_id: 0,
        }),
      },
      [`realty-${MISSED_OWNER_ID}.html`]: { status: 200, url: "page", bodyText: "page" },
    });
    const result = await acquireDomriaNewest({
      categories: ["apartment"],
      knownIds: new Set(),
      get,
      extractState: () => pageState(MISSED_OWNER_ID, 1436),
    });
    const listing = result.listings[0];
    expect(listing?.sourceId).toBe(MISSED_OWNER_ID);
    expect(listing?.sellerType).toBe("owner");
    expect(listing?.metadata?.ownerEvidenceLevel).toBe("platform_confirmed");
    expect(listing?.location.raw).toContain("Володимира Великого");
    expect(listing?.metadata?.userId).toBe(488374);
    expect(listing?.publishedAt?.toISOString()).toBe(new Date("2026-09-24T11:07:26").toISOString());
  });

  it("rejects a new intermediary characteristic later via seller rules", async () => {
    const get = scriptedGet({
      "searchEngine/v2/": { status: 200, url: "search", bodyText: searchBody([10]) },
      "realty/data/10": { status: 200, url: "data", bodyText: dataCard("10", "2026-09-24 12:00:00") },
      "realty-10.html": { status: 200, url: "page", bodyText: "page" },
    });
    const result = await acquireDomriaNewest({
      categories: ["apartment"],
      knownIds: new Set(),
      get,
      extractState: () => pageState("10", 1434),
    });
    const listing = result.listings[0];
    expect(listing?.sellerType).toBe("agent");
    expect(listing ? isSellerEligible(listing) : true).toBe(false);
  });

  it("keeps a missing characteristic 1437 unknown", async () => {
    const get = scriptedGet({
      "searchEngine/v2/": { status: 200, url: "search", bodyText: searchBody([11]) },
      "realty/data/11": {
        status: 200,
        url: "data",
        bodyText: dataCard("11", "2026-09-24 12:00:00", { agency_id: 0 }),
      },
      "realty-11.html": { status: 200, url: "page", bodyText: "page" },
    });
    const result = await acquireDomriaNewest({
      categories: ["apartment"],
      knownIds: new Set(),
      get,
      extractState: () => pageState("11", undefined),
    });
    expect(result.listings[0]?.sellerType).toBe("unknown");
    expect(result.listings[0]?.metadata?.ownerEvidenceLevel).not.toBe("platform_confirmed");
  });

  it("still fetches a newer id that sits after an older one", async () => {
    const plan = planDomriaDetailFetches(["20", "21", "22"], new Set(), 8);
    expect(plan.toFetch).toEqual(["20", "21", "22"]);
    const get = scriptedGet({
      "searchEngine/v2/": { status: 200, url: "search", bodyText: searchBody([20, 21, 22]) },
      "realty/data/20": { status: 200, url: "d20", bodyText: dataCard("20", "2026-09-24 10:00:00") },
      "realty/data/21": { status: 200, url: "d21", bodyText: dataCard("21", "2026-09-23 09:00:00") },
      "realty/data/22": { status: 200, url: "d22", bodyText: dataCard("22", "2026-09-24 18:00:00") },
      "realty-20.html": { status: 200, url: "p20", bodyText: "page" },
      "realty-21.html": { status: 200, url: "p21", bodyText: "page" },
      "realty-22.html": { status: 200, url: "p22", bodyText: "page" },
    });
    const result = await acquireDomriaNewest({
      categories: ["apartment"],
      knownIds: new Set(),
      get,
      extractState: (html) => pageState(html.includes("22") ? "22" : html.includes("21") ? "21" : "20", 1436),
    });
    expect(result.listings.map((item) => item.sourceId)).toEqual(["20", "21", "22"]);
    expect(result.persistIds).toEqual(["20", "21", "22"]);
  });

  it("does not remember ids past a failed detail read", async () => {
    const get = scriptedGet({
      "searchEngine/v2/": { status: 200, url: "search", bodyText: searchBody([30, 31, 32]) },
      "realty/data/30": { status: 200, url: "d30", bodyText: dataCard("30", "2026-09-24 10:00:00") },
      "realty-30.html": { status: 200, url: "p30", bodyText: "page" },
      "realty/data/31": { status: 503, url: "d31", bodyText: "down" },
    });
    const result = await acquireDomriaNewest({
      categories: ["apartment"],
      knownIds: new Set(),
      get,
      extractState: () => pageState("30", 1436),
    });
    expect(result.persistIds).toEqual(["30"]);
    expect(result.coverageTruncated).toBe(true);
    expect(result.boundaryReached).toBe(false);
    expect(result.listings.map((item) => item.sourceId)).toEqual(["30"]);
    expect(get.calls.some((url) => url.includes("realty/data/32"))).toBe(false);
  });

  it("uses the house search parameters and distinguishes parser failure from an empty id list", async () => {
    const empty = await acquireDomriaNewest({
      categories: ["house"],
      knownIds: new Set(),
      get: async (url) => {
        expect(url).toContain("category=4");
        expect(url).toContain("realty_type=0");
        return { status: 200, url, bodyText: searchBody([]) };
      },
      extractState: () => ({}),
    });
    expect(empty.structurePresent).toBe(true);
    expect(empty.parserFailure).toBe(false);
    expect(empty.listings).toEqual([]);
    const broken = await acquireDomriaNewest({
      categories: ["house"],
      knownIds: new Set(),
      get: async (url) => ({ status: 200, url, bodyText: "{\"noItems\":true}" }),
      extractState: () => ({}),
    });
    expect(broken.parserFailure).toBe(true);
    expect(broken.structurePresent).toBe(false);
    expect(broken.persistIds).toBeUndefined();
  });

  it("does not redeliver a seen id or a publication from before the existing baseline", () => {
    const dedupe = new InMemoryListingDedupe();
    const seen = {
      source: "domria" as const,
      sourceId: MISSED_OWNER_ID,
      url: "https://dom.ria.com/uk/realty-34953276.html",
      title: "Квартира",
      location: { raw: "Львів" },
      propertyType: "apartment" as const,
      sellerType: "owner" as const,
      discoveredAt: new Date("2026-09-24T12:00:00Z"),
    };
    dedupe.markSeen(seen);
    expect(dedupe.filterUnseen([seen])).toEqual([]);
    const freshness = classifyListingFreshness(
      { source: "domria", sourceId: "1", publishedAt: new Date("2026-09-18T15:03:31Z") },
      {
        maxPublicationAgeMinutes: 7 * 24 * 60,
        strictNewPublications: true,
        now: new Date("2026-09-24T12:00:00Z"),
        monitoringStartedAt: new Date("2026-09-19T21:15:02Z"),
      },
    );
    expect(freshness.kind).toBe("late_discovered");
    expect(freshness.deliverable).toBe(false);
    expect(mergeDomriaAcquiredIds(["1"], ["2"])).toEqual(["1", "2"]);
  });
});
