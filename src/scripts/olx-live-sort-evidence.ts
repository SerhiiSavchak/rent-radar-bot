/**
 * Source-layer live evidence: OLX HTML newest-first sort only.
 * Not production. Requires Playwright. Does not enable time-stop.
 *
 * Uses exact production catalog URL builder (dist=15, order=created_at:desc).
 * PASS (≥3 cycles, listing-level):
 * - organic createdTime non-increasing within page 1 and page 2
 * - page2 newest organic createdTime ≤ page1 oldest organic createdTime
 * HTTP 200 / URL retention alone is NOT pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  buildOlxBrowserCategoryUrl,
  isNonIncreasingCreatedTimes,
  OLX_BROWSER_PAGE_BUDGET,
} from "../sources/olx/olx-browser.coverage.ts";
import {
  extractListingAdsFromPrerenderedState,
  inspectPrerenderedState,
} from "../sources/olx/olx-browser.html-extract.ts";

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR?.trim() ||
  join(process.cwd(), "evidence", "source-layer-live", "olx-sort");
const CYCLES = Math.max(1, Number(process.env.LIVE_PROBE_CYCLES ?? "3") || 3);
const CATEGORY = (process.env.OLX_SORT_CATEGORY?.trim() || "apartments") as
  | "apartments"
  | "houses";

export type OlxSortListingRow = {
  id: string;
  page: number;
  position: number;
  promoted: boolean;
  createdTimeIso: string | null;
  createdTimeEpoch: number | null;
  lastRefreshTimeIso: string | null;
};

function isPromotedAd(ad: Record<string, unknown>): boolean {
  if (ad.isPromoted === true || ad.is_promoted === true || ad.is_top === true) {
    return true;
  }
  const promotion = ad.promotion;
  if (promotion && typeof promotion === "object") {
    const p = promotion as Record<string, unknown>;
    if (p.top_ad === true || p.highlighted === true || p.urgent === true) {
      return true;
    }
  }
  return false;
}

function isoField(ad: Record<string, unknown>, key: string): string | null {
  const value = ad[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function epochFromIso(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function rowsFromAds(ads: unknown[], page: number): OlxSortListingRow[] {
  const rows: OlxSortListingRow[] = [];
  let position = 0;
  for (const raw of ads) {
    if (!raw || typeof raw !== "object") continue;
    const ad = raw as Record<string, unknown>;
    const id =
      typeof ad.id === "number" || typeof ad.id === "string" ? String(ad.id) : undefined;
    if (!id) continue;
    position += 1;
    const createdTimeIso = isoField(ad, "createdTime") ?? isoField(ad, "created_time");
    const lastRefreshTimeIso =
      isoField(ad, "lastRefreshTime") ?? isoField(ad, "last_refresh_time");
    rows.push({
      id,
      page,
      position,
      promoted: isPromotedAd(ad),
      createdTimeIso,
      createdTimeEpoch: epochFromIso(createdTimeIso),
      lastRefreshTimeIso,
    });
  }
  return rows;
}

function organicCreatedEpochs(rows: OlxSortListingRow[]): number[] {
  return rows
    .filter((r) => !r.promoted && r.createdTimeEpoch !== null)
    .map((r) => r.createdTimeEpoch as number);
}

function isNonIncreasing(times: number[]): { ok: boolean; reason?: string; breakIndex?: number } {
  if (times.length < 3) {
    return { ok: false, reason: "insufficient_dated_organic" };
  }
  if (!isNonIncreasingCreatedTimes(times)) {
    for (let i = 1; i < times.length; i += 1) {
      if (times[i]! > times[i - 1]!) {
        return { ok: false, reason: "organic_created_not_non_increasing", breakIndex: i };
      }
    }
    return { ok: false, reason: "organic_created_not_non_increasing" };
  }
  return { ok: true };
}

async function fetchPage(url: string, pageNumber: number) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      locale: "uk-UA",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const html = (await resp?.text()) ?? (await page.content());
    const inspection = inspectPrerenderedState(html);
    const ads = extractListingAdsFromPrerenderedState(inspection.decoded);
    const listings = rowsFromAds(ads, pageNumber);
    const organic = organicCreatedEpochs(listings);
    const orderCheck = isNonIncreasing(organic);
    return {
      requestedUrl: url,
      finalUrl: page.url(),
      status: resp?.status() ?? 0,
      page: pageNumber,
      paramsRetained: {
        dist: /search(?:%5B|\[)dist(?:%5D|\])=15/i.test(page.url()),
        order: /search(?:%5B|\[)order(?:%5D|\])=created_at(?:%3A|:)desc/i.test(page.url()),
        page:
          pageNumber <= 1
            ? !/[?&]page=/.test(page.url()) || /[?&]page=1(?:&|$)/.test(page.url())
            : new RegExp(`[?&]page=${pageNumber}(?:&|$)`).test(page.url()),
      },
      hasPrerendered: inspection.present && inspection.complete,
      listingCount: listings.length,
      organicDatedCount: organic.length,
      organicCreatedHead: organic.slice(0, 12),
      organicCreatedTail: organic.slice(-4),
      oldestOrganic: organic.length ? Math.min(...organic) : null,
      newestOrganic: organic.length ? Math.max(...organic) : null,
      withinPageNonIncreasing: orderCheck.ok,
      withinPageFailure: orderCheck.ok
        ? null
        : {
            reason: orderCheck.reason ?? "unknown",
            ...(orderCheck.breakIndex !== undefined ? { breakIndex: orderCheck.breakIndex } : {}),
          },
      // Sanitized listing rows: id + timestamps only (no titles/descriptions).
      listings,
    };
  } finally {
    await browser.close();
  }
}

async function oneCycle(cycle: number) {
  const page1Url = buildOlxBrowserCategoryUrl(CATEGORY, { page: 1 });
  const page2Url = buildOlxBrowserCategoryUrl(CATEGORY, { page: 2 });
  const page1 = await fetchPage(page1Url, 1);
  await new Promise((r) => setTimeout(r, 1_200));
  const page2 = await fetchPage(page2Url, 2);

  const pageContinuity =
    page1.oldestOrganic !== null &&
    page2.newestOrganic !== null &&
    page2.newestOrganic <= page1.oldestOrganic;

  const sortListingEvidence =
    page1.status === 200 &&
    page2.status === 200 &&
    page1.hasPrerendered &&
    page2.hasPrerendered &&
    page1.withinPageNonIncreasing &&
    page2.withinPageNonIncreasing &&
    pageContinuity &&
    page1.organicDatedCount >= 5 &&
    page2.organicDatedCount >= 3;

  let sortBlockReason: string | null = null;
  if (!sortListingEvidence) {
    if (!page1.withinPageNonIncreasing) {
      sortBlockReason = `page1_${page1.withinPageFailure?.reason ?? "order_fail"}`;
    } else if (!page2.withinPageNonIncreasing) {
      sortBlockReason = `page2_${page2.withinPageFailure?.reason ?? "order_fail"}`;
    } else if (!pageContinuity) {
      sortBlockReason = "page_boundary_newest_exceeds_page1_oldest";
    } else if (page1.organicDatedCount < 5 || page2.organicDatedCount < 3) {
      sortBlockReason = "insufficient_dated_organic";
    } else {
      sortBlockReason = "http_or_prerender_or_other";
    }
  }

  return {
    cycle,
    at: new Date().toISOString(),
    category: CATEGORY,
    pageBudget: OLX_BROWSER_PAGE_BUDGET,
    productionQuery: {
      distanceKm: 15,
      order: "created_at:desc",
      page1Url,
      page2Url,
    },
    page1: {
      requestedUrl: page1.requestedUrl,
      finalUrl: page1.finalUrl,
      status: page1.status,
      paramsRetained: page1.paramsRetained,
      hasPrerendered: page1.hasPrerendered,
      listingCount: page1.listingCount,
      organicDatedCount: page1.organicDatedCount,
      organicCreatedHead: page1.organicCreatedHead,
      oldestOrganic: page1.oldestOrganic,
      newestOrganic: page1.newestOrganic,
      withinPageNonIncreasing: page1.withinPageNonIncreasing,
      withinPageFailure: page1.withinPageFailure,
      listings: page1.listings,
    },
    page2: {
      requestedUrl: page2.requestedUrl,
      finalUrl: page2.finalUrl,
      status: page2.status,
      paramsRetained: page2.paramsRetained,
      hasPrerendered: page2.hasPrerendered,
      listingCount: page2.listingCount,
      organicDatedCount: page2.organicDatedCount,
      organicCreatedHead: page2.organicCreatedHead,
      oldestOrganic: page2.oldestOrganic,
      newestOrganic: page2.newestOrganic,
      withinPageNonIncreasing: page2.withinPageNonIncreasing,
      withinPageFailure: page2.withinPageFailure,
      listings: page2.listings,
    },
    verdict: {
      urlRetentionOnly: page1.paramsRetained.order && page2.paramsRetained.order,
      pageContinuity,
      sortListingEvidence,
      sortStatus: sortListingEvidence ? "PASS" : "BLOCKED",
      sortBlockReason,
    },
  };
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const cycles = [];
  for (let i = 1; i <= CYCLES; i += 1) {
    console.error(`olx-sort cycle ${i}/${CYCLES} category=${CATEGORY}`);
    cycles.push(await oneCycle(i));
    if (i < CYCLES) await new Promise((r) => setTimeout(r, 2_500));
  }
  const sortPass = cycles.every((c) => c.verdict.sortListingEvidence);
  const summary = {
    probe: "olx-html-sort-only",
    commit: process.env.RENT_RADAR_COMMIT ?? "unknown",
    cycles: CYCLES,
    category: CATEGORY,
    sortStatus: sortPass ? "PASS" : "BLOCKED",
    timeStop: "disabled",
    note: "PASS requires listing-level organic createdTime order on every cycle (within page + page boundary). HTTP 200 / URL retention alone is insufficient. Time-stop remains disabled regardless.",
    cyclesDetail: cycles,
  };
  const out = join(EVIDENCE_DIR, `summary-${Date.now()}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        written: out,
        sortStatus: summary.sortStatus,
        blockReasons: cycles.map((c) => c.verdict.sortBlockReason),
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
