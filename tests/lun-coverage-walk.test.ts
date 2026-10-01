import { describe, expect, it } from "vitest";
import { LunSource, readLunWalkBoundary } from "../src/sources/lun/lun.source.ts";

function encodeFlightString(inner: string): string {
  return JSON.stringify(inner).slice(1, -1);
}

function card(id: number, insertTime: string) {
  return {
    id,
    insertTime,
    price: 15_000,
    currency: "UAH",
    isOwner: true,
    sectionId: 2,
    header: `card ${id}`,
    location: [24.03, 49.84],
    text: "Оренда квартири",
  };
}

function pageHtml(cards: object[], extra: Record<string, number> = {}): string {
  const payload = {
    realties: { cards },
    ...extra,
  };
  const inner = JSON.stringify(payload);
  return `<html><script>self.__next_f.push([1,"${encodeFlightString(inner)}"])</script></html>`;
}

type PageResponse = { status: number; bodyText: string };

function sourceFor(
  pages: Map<string, PageResponse | (() => PageResponse | Promise<PageResponse>)>,
  options: { safetyCap?: number; now?: () => number; categoryBudgetMs?: number } = {},
) {
  const calls: string[] = [];
  const source = new LunSource({
    ...(options.safetyCap !== undefined ? { safetyCap: options.safetyCap } : {}),
    ...(options.categoryBudgetMs !== undefined ? { categoryBudgetMs: options.categoryBudgetMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    get: async (url) => {
      calls.push(url);
      const row = pages.get(url);
      if (!row) {
        return { status: 404, bodyText: "" };
      }
      return typeof row === "function" ? await row() : row;
    },
  });
  return { source, calls };
}

const FLATS = "https://lun.ua/rent/lviv/flats";

function flatsUrl(page: number): string {
  return page <= 1 ? FLATS : `${FLATS}?page=${page}`;
}

describe("LUN catalog walk", () => {
  it("reads totalGroupedCount and totalPages when the page exposes them", () => {
    const html = pageHtml([card(1, "2026-10-01T10:00:00")], {
      totalGroupedCount: 1604,
      totalPages: 67,
    });
    expect(readLunWalkBoundary(html)).toEqual({ totalGroupedCount: 1604, totalPages: 67 });
  });

  it("acquires a page-3 listing that is newer than page 2 and absent from pages 1-2", async () => {
    const { source, calls } = sourceFor(
      new Map([
        [flatsUrl(1), { status: 200, bodyText: pageHtml([card(1, "2026-10-01T08:00:00")]) }],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([card(2, "2026-09-30T07:00:00")]) }],
        [flatsUrl(3), { status: 200, bodyText: pageHtml([card(4727671994, "2026-10-01T12:24:44")]) }],
        [flatsUrl(4), { status: 200, bodyText: pageHtml([]) }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual([
      "1",
      "2",
      "4727671994",
    ]);
    const page3 = result.listings.find((listing) => listing.sourceId === "4727671994");
    const page2 = result.listings.find((listing) => listing.sourceId === "2");
    expect(page3?.publishedAt && page2?.publishedAt && page3.publishedAt > page2.publishedAt).toBe(
      true,
    );
    expect(result.resultKind).toBe("ok");
    expect(result.health.healthy).toBe(true);
    expect(result.coverage?.coverageTruncated).not.toBe(true);
    expect(result.coverage?.boundaryReached).toBe(true);
    expect(calls).toEqual([flatsUrl(1), flatsUrl(2), flatsUrl(3), flatsUrl(4)]);
  });

  it("treats a terminal empty page as a complete healthy walk", async () => {
    const { source } = sourceFor(
      new Map([
        [flatsUrl(1), { status: 200, bodyText: pageHtml([card(10, "2026-10-01T10:00:00")]) }],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([]) }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings).toHaveLength(1);
    expect(result.resultKind).toBe("ok");
    expect(result.health.healthy).toBe(true);
    expect(result.coverage?.boundaryReached).toBe(true);
    expect(result.coverage?.coverageTruncated).toBe(false);
  });

  it("stops on totalPages without requesting a further page", async () => {
    const { source, calls } = sourceFor(
      new Map([
        [
          flatsUrl(1),
          { status: 200, bodyText: pageHtml([card(1, "2026-10-01T10:00:00")], { totalPages: 2 }) },
        ],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([card(2, "2026-10-01T09:00:00")]) }],
        [flatsUrl(3), { status: 200, bodyText: pageHtml([card(3, "2026-10-01T12:00:00")]) }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual(["1", "2"]);
    expect(result.health.healthy).toBe(true);
    expect(result.resultKind).toBe("ok");
    expect(calls).not.toContain(flatsUrl(3));
  });

  it("stops once unique cards reach totalGroupedCount", async () => {
    const { source, calls } = sourceFor(
      new Map([
        [
          flatsUrl(1),
          {
            status: 200,
            bodyText: pageHtml([card(1, "2026-10-01T10:00:00")], { totalGroupedCount: 2 }),
          },
        ],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([card(2, "2026-10-01T09:00:00")]) }],
        [flatsUrl(3), { status: 200, bodyText: pageHtml([]) }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual(["1", "2"]);
    expect(result.health.healthy).toBe(true);
    expect(calls).toEqual([flatsUrl(1), flatsUrl(2)]);
  });

  it("does not let a repeated card id satisfy totalGroupedCount early", async () => {
    const { source, calls } = sourceFor(
      new Map([
        [
          flatsUrl(1),
          {
            status: 200,
            bodyText: pageHtml(
              [card(1, "2026-10-01T10:00:00"), card(2, "2026-10-01T09:00:00")],
              { totalGroupedCount: 4 },
            ),
          },
        ],
        [
          flatsUrl(2),
          {
            status: 200,
            bodyText: pageHtml([card(2, "2026-10-01T09:30:00"), card(3, "2026-10-01T11:00:00")]),
          },
        ],
        [flatsUrl(3), { status: 200, bodyText: pageHtml([card(4, "2026-10-01T12:00:00")]) }],
        [flatsUrl(4), { status: 200, bodyText: pageHtml([]) }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual(["1", "2", "3", "4"]);
    expect(result.health.healthy).toBe(true);
    expect(result.coverage?.coverageTruncated).toBe(false);
    expect(result.coverage?.boundaryReached).toBe(true);
    expect(calls).toEqual([flatsUrl(1), flatsUrl(2), flatsUrl(3)]);
  });

  it("keeps a legitimate empty catalog as valid_empty, not parser_failure", async () => {
    const { source } = sourceFor(
      new Map([[flatsUrl(1), { status: 200, bodyText: pageHtml([], { totalGroupedCount: 0 }) }]]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings).toHaveLength(0);
    expect(result.resultKind).toBe("valid_empty");
    expect(result.health.healthy).toBe(true);
    expect(result.health.resultKind).toBe("valid_empty");
    expect(result.coverage?.coverageTruncated).not.toBe(true);
  });

  it("marks a repeated page as coverage_degraded and keeps earlier cards", async () => {
    const repeated = pageHtml([card(1, "2026-10-01T10:00:00")]);
    const { source, calls } = sourceFor(
      new Map([
        [flatsUrl(1), { status: 200, bodyText: repeated }],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([card(2, "2026-10-01T09:00:00")]) }],
        [flatsUrl(3), { status: 200, bodyText: repeated }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual(["1", "2"]);
    expect(result.health.healthy).toBe(false);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.coverage?.boundaryReached).toBe(false);
    expect(result.health.message).toContain("coverage_degraded");
    expect(result.resultKind).toBe("ok");
    expect(calls).not.toContain(flatsUrl(4));
  });

  it("marks a deeper HTTP failure as coverage_degraded and keeps pages 1-2", async () => {
    const { source } = sourceFor(
      new Map([
        [flatsUrl(1), { status: 200, bodyText: pageHtml([card(1, "2026-10-01T10:00:00")]) }],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([card(2, "2026-10-01T09:00:00")]) }],
        [flatsUrl(3), { status: 503, bodyText: "" }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual(["1", "2"]);
    expect(result.resultKind).toBe("ok");
    expect(result.health.healthy).toBe(false);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.health.message).toContain("coverage_degraded");
    expect(result.health.resultKind).not.toBe("ok");
    expect(result.httpStatus).toBe(200);
  });

  it("keeps earlier cards when a deeper page is transport-blocked", async () => {
    const { source } = sourceFor(
      new Map([
        [flatsUrl(1), { status: 200, bodyText: pageHtml([card(1, "2026-10-01T10:00:00")]) }],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([card(2, "2026-10-01T09:00:00")]) }],
        [flatsUrl(3), { status: 403, bodyText: "" }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual(["1", "2"]);
    expect(result.resultKind).toBe("ok");
    expect(result.httpStatus).toBe(200);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.health.healthy).toBe(false);
    expect(result.health.message).toContain("coverage_degraded");
  });

  it("marks a deeper parser failure as coverage_degraded and keeps pages 1-2", async () => {
    const { source } = sourceFor(
      new Map([
        [flatsUrl(1), { status: 200, bodyText: pageHtml([card(1, "2026-10-01T10:00:00")]) }],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([card(2, "2026-10-01T09:00:00")]) }],
        [flatsUrl(3), { status: 200, bodyText: "<html>no cards</html>" }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual(["1", "2"]);
    expect(result.resultKind).toBe("ok");
    expect(result.health.healthy).toBe(false);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.health.message).toContain("coverage_degraded");
  });

  it("marks safety-cap exhaustion as coverage_degraded", async () => {
    const pages = new Map<string, PageResponse>();
    for (let page = 1; page <= 5; page += 1) {
      pages.set(flatsUrl(page), {
        status: 200,
        bodyText: pageHtml([card(page, `2026-10-0${page}T10:00:00`)]),
      });
    }
    const { source, calls } = sourceFor(pages, { safetyCap: 2 });
    const result = await source.inspectLatest({ includeHouses: false });
    expect(calls).toEqual([flatsUrl(1), flatsUrl(2)]);
    expect(result.listings).toHaveLength(2);
    expect(result.health.healthy).toBe(false);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.health.message).toContain("coverage_degraded");
    expect(result.health.message).toContain("safety_cap");
  });

  it("marks a walk stopped by the time budget as coverage_degraded", async () => {
    let tick = 0;
    const { source } = sourceFor(
      new Map([
        [flatsUrl(1), { status: 200, bodyText: pageHtml([card(1, "2026-10-01T10:00:00")]) }],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([card(2, "2026-10-01T09:00:00")]) }],
        [flatsUrl(3), { status: 200, bodyText: pageHtml([]) }],
      ]),
      {
        categoryBudgetMs: 1_000,
        now: () => {
          tick += 1;
          return tick === 1 ? 0 : 5_000;
        },
      },
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings.map((listing) => listing.sourceId)).toEqual(["1"]);
    expect(result.health.healthy).toBe(false);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.health.message).toContain("time_budget");
  });

  it("does not call a premature empty page a complete catalog when the declared total is far ahead", async () => {
    const { source } = sourceFor(
      new Map([
        [
          flatsUrl(1),
          {
            status: 200,
            bodyText: pageHtml([card(1, "2026-10-01T10:00:00")], { totalGroupedCount: 100 }),
          },
        ],
        [flatsUrl(2), { status: 200, bodyText: pageHtml([]) }],
      ]),
    );
    const result = await source.inspectLatest({ includeHouses: false });
    expect(result.listings).toHaveLength(1);
    expect(result.health.healthy).toBe(false);
    expect(result.coverage?.coverageTruncated).toBe(true);
    expect(result.resultKind).toBe("ok");
  });
});
