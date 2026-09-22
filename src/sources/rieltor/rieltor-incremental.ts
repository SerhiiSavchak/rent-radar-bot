import type { Listing } from "../../domain/listing.ts";
import type { IncrementalCoverage } from "../../domain/source.ts";

/** Public RIELTOR menu value whose live pages were newest-first on 2026-09-22. */
export const RIELTOR_NEWEST_SORT = "bycreated";

/** Keep this much publication-time overlap so a small reorder is still collected. */
export const RIELTOR_INCREMENTAL_OVERLAP_MS = 30 * 60 * 1000;

/**
 * How many catalog pages one category may request in a single poll.
 * This is a per-poll budget, not a coverage ceiling: a longer backlog
 * continues on the next poll from the stored catch-up cursor.
 */
export const RIELTOR_POLL_PAGE_BUDGET = 3;

export type RieltorCategoryName = "apartment" | "house";

export type RieltorWalkMode = "seed" | "catchup" | "steady";

/** Backlog still owed to an older publication target. Page 1 is always rechecked. */
export type RieltorCatchupState = {
  target: string;
  resumePage: number;
};

export type RieltorIncrementalCoverage = IncrementalCoverage;

export function rieltorPublicationBoundaryKey(category: RieltorCategoryName): string {
  return `rieltor_incremental_boundary_${category}`;
}

export function rieltorCatchupKey(category: RieltorCategoryName): string {
  return `rieltor_incremental_catchup_${category}`;
}

export function parseRieltorCatchup(raw: string | undefined): RieltorCatchupState | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { target?: unknown; resumePage?: unknown };
    if (typeof parsed.target !== "string" || !Number.isFinite(Date.parse(parsed.target))) {
      return undefined;
    }
    const resumePage = Number(parsed.resumePage);
    if (!Number.isInteger(resumePage) || resumePage < 1) {
      return undefined;
    }
    return { target: new Date(parsed.target).toISOString(), resumePage };
  } catch {
    return undefined;
  }
}

export function serializeRieltorCatchup(state: RieltorCatchupState): string {
  return JSON.stringify({ target: state.target, resumePage: state.resumePage });
}

export function crossedRieltorPublicationBoundary(
  publishedAt: Date | undefined,
  watermark: Date | undefined,
  overlapMs = RIELTOR_INCREMENTAL_OVERLAP_MS,
): boolean {
  if (!watermark || !publishedAt) {
    return false;
  }
  return publishedAt.getTime() <= watermark.getTime() - overlapMs;
}

export function publicationRange(listings: Pick<Listing, "publishedAt">[]): {
  oldest?: string;
  newest?: string;
} {
  const times = listings
    .map((listing) => listing.publishedAt?.getTime())
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (times.length === 0) {
    return {};
  }
  return {
    oldest: new Date(Math.min(...times)).toISOString(),
    newest: new Date(Math.max(...times)).toISOString(),
  };
}

export function planRieltorCategoryFetch(input: {
  committedBoundary?: string;
  catchup?: RieltorCatchupState;
  bootstrapTarget?: string;
  budget?: number;
}): {
  mode: RieltorWalkMode;
  pages: number[];
  stopAt?: string;
  catchupTarget?: string;
} {
  const budget = input.budget ?? RIELTOR_POLL_PAGE_BUDGET;
  if (!input.committedBoundary && !input.catchup && !input.bootstrapTarget) {
    return { mode: "seed", pages: [1] };
  }
  const catchupTarget = input.catchup?.target ?? input.bootstrapTarget ?? input.committedBoundary;
  const stopAt =
    catchupTarget !== undefined
      ? new Date(Date.parse(catchupTarget) - RIELTOR_INCREMENTAL_OVERLAP_MS).toISOString()
      : undefined;
  const resumePage = input.catchup?.resumePage ?? 1;
  if (resumePage > 1) {
    const pages = [1];
    for (
      let page = Math.max(2, resumePage - 1);
      pages.length < budget;
      page += 1
    ) {
      if (!pages.includes(page)) {
        pages.push(page);
      }
    }
    return {
      mode: "catchup",
      pages,
      ...(stopAt ? { stopAt } : {}),
      ...(catchupTarget ? { catchupTarget } : {}),
    };
  }
  const pages: number[] = [];
  for (let page = 1; page <= budget; page += 1) {
    pages.push(page);
  }
  const mode: RieltorWalkMode = input.committedBoundary && !input.catchup && !input.bootstrapTarget
    ? "steady"
    : "catchup";
  return {
    mode,
    pages,
    ...(stopAt ? { stopAt } : {}),
    ...(catchupTarget ? { catchupTarget } : {}),
  };
}

/**
 * Decide whether this walk closed the publication gap.
 * A missing timestamp never counts as crossing the boundary.
 * The per-poll page budget only pauses the walk; it does not drop the backlog.
 */
export function assessRieltorWalk(input: {
  mode: RieltorWalkMode;
  plannedPages: number[];
  fetchedPages: number[];
  crossed: boolean;
  failed: boolean;
  catalogEnded: boolean;
  newest?: string;
  catchupTarget?: string;
  previousCommitted?: string;
}): {
  boundaryReached: boolean;
  coverageTruncated: boolean;
  committed?: string;
  catchup: RieltorCatchupState | null;
} {
  if (input.mode === "seed") {
    if (input.failed || !input.newest) {
      return { boundaryReached: false, coverageTruncated: true, catchup: null };
    }
    return {
      boundaryReached: true,
      coverageTruncated: false,
      committed: input.newest,
      catchup: null,
    };
  }

  const target = input.catchupTarget ?? input.previousCommitted;
  const keep = (resumePage: number): RieltorCatchupState | null =>
    target ? { target, resumePage } : null;

  if (input.failed) {
    const failedPage = input.plannedPages[input.fetchedPages.length] ?? input.plannedPages[0] ?? 1;
    return {
      boundaryReached: false,
      coverageTruncated: true,
      catchup: keep(failedPage),
    };
  }

  if (input.crossed || input.catalogEnded) {
    return {
      boundaryReached: true,
      coverageTruncated: false,
      ...(input.newest ? { committed: input.newest } : {}),
      catchup: null,
    };
  }

  const last = input.fetchedPages[input.fetchedPages.length - 1] ?? 1;
  return {
    boundaryReached: false,
    coverageTruncated: true,
    catchup: keep(last + 1),
  };
}

export function formatRieltorCoverage(coverage: RieltorIncrementalCoverage): string {
  const catchup = coverage.catchup;
  const resume = catchup
    ? (["apartment", "house"] as const)
        .map((category) => {
          const state = catchup[category];
          return state ? `${category}:${state.resumePage}` : undefined;
        })
        .filter((item): item is string => item !== undefined)
        .join(",")
    : "";
  return [
    "rieltor_incremental",
    `pagesFetched=${coverage.pagesFetched}`,
    `cardsFetched=${coverage.cardsFetched}`,
    `boundaryReached=${coverage.boundaryReached}`,
    `coverageTruncated=${coverage.coverageTruncated}`,
    `oldestObservedPublication=${coverage.oldestObservedPublication ?? "none"}`,
    `newestObservedPublication=${coverage.newestObservedPublication ?? "none"}`,
    `catchupResume=${resume || "none"}`,
  ].join(" ");
}
