/**
 * Continue apartments depth from page 26. Cap wall 300s. Same production URL builder.
 * Stop only: confirmed empty (0 ads + 200) OR wall 300s. Do not stop on zero-novel.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOlxBrowserCategoryUrl } from "../sources/olx/olx-browser.coverage.ts";
import {
  extractListingAdsFromPrerenderedState,
  inspectPrerenderedState,
} from "../sources/olx/olx-browser.html-extract.ts";

const START_PAGE = 26;
const WALL_CAP_MS = 300_000;
const GAP_MS = 500;
const EVIDENCE_DIR = join(process.cwd(), "evidence", "source-layer-live", "olx-coverage-scan");

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true });
  const wallStarted = Date.now();
  const pages: Array<{
    page: number;
    status: number;
    finalUrl: string;
    navMs: number;
    cardCount: number;
    novelIdCount: number;
    cumulativeUniqueIdsThisSegment: number;
    totalElements: number | null;
    ids: string[];
  }> = [];
  const seenIds = new Set<string>();
  let stopReason: string | undefined;
  let confirmedEmptyAt: number | null = null;
  let totalElements: number | null = null;
  try {
    const page = await browser.newPage({
      locale: "uk-UA",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    for (let p = START_PAGE; ; p += 1) {
      if (Date.now() - wallStarted >= WALL_CAP_MS) {
        stopReason = "wall_cap_300s";
        break;
      }
      const url = buildOlxBrowserCategoryUrl("apartments", { page: p });
      const t0 = Date.now();
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const html = (await resp?.text()) ?? "";
      const navMs = Date.now() - t0;
      const inspection = inspectPrerenderedState(html);
      const decoded = inspection.decoded as
        | { listing?: { listing?: { totalElements?: number; total_elements?: number } } }
        | undefined;
      const listingInner = decoded?.listing?.listing;
      if (typeof listingInner?.totalElements === "number") {
        totalElements = listingInner.totalElements;
      } else if (typeof listingInner?.total_elements === "number") {
        totalElements = listingInner.total_elements;
      }
      const ads = extractListingAdsFromPrerenderedState(inspection.decoded) as Array<{ id?: unknown }>;
      const ids = ads.map((a) => String(a.id)).filter((id) => id && id !== "undefined");
      let novel = 0;
      for (const id of ids) {
        if (!seenIds.has(id)) {
          seenIds.add(id);
          novel += 1;
        }
      }
      const row = {
        page: p,
        status: resp?.status() ?? 0,
        finalUrl: page.url(),
        navMs,
        cardCount: ads.length,
        novelIdCount: novel,
        cumulativeUniqueIdsThisSegment: seenIds.size,
        totalElements,
        ids,
      };
      pages.push(row);
      console.error(
        JSON.stringify({
          page: p,
          status: row.status,
          cards: row.cardCount,
          novel,
          navMs,
          totalElements,
          wallMs: Date.now() - wallStarted,
        }),
      );
      if (ads.length === 0 && row.status === 200) {
        confirmedEmptyAt = p;
        stopReason = "confirmed_empty";
        break;
      }
      if (Date.now() - wallStarted >= WALL_CAP_MS) {
        stopReason = "wall_cap_300s";
        break;
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    await page.close();
  } finally {
    await browser.close();
  }

  const elapsedMs = Date.now() - wallStarted;
  const navs = pages.map((p) => p.navMs);
  const summary = {
    probe: "olx-apartments-depth-continue-from-26",
    commit: process.env.RENT_RADAR_COMMIT ?? "unknown",
    startPage: START_PAGE,
    wallCapMs: WALL_CAP_MS,
    gapMs: GAP_MS,
    query: buildOlxBrowserCategoryUrl("apartments", { page: START_PAGE }),
    stopReason: stopReason ?? "unknown",
    confirmedEmptyAt,
    totalElementsLastSeen: totalElements,
    pagesFetched: pages.length,
    lastPage: pages.at(-1)?.page ?? null,
    uniqueIdsThisSegment: seenIds.size,
    elapsedMs,
    navMs: navs.length
      ? {
          min: Math.min(...navs),
          max: Math.max(...navs),
          avg: Math.round(navs.reduce((a, b) => a + b, 0) / navs.length),
        }
      : null,
    pages: pages.map((p) => ({
      page: p.page,
      status: p.status,
      finalUrl: p.finalUrl,
      navMs: p.navMs,
      cardCount: p.cardCount,
      novelIdCount: p.novelIdCount,
      cumulativeUniqueIdsThisSegment: p.cumulativeUniqueIdsThisSegment,
      totalElements: p.totalElements,
      ids: p.ids,
    })),
  };
  const out = join(EVIDENCE_DIR, `apartments-from26-${Date.now()}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        written: out,
        stopReason: summary.stopReason,
        confirmedEmptyAt: summary.confirmedEmptyAt,
        pagesFetched: summary.pagesFetched,
        lastPage: summary.lastPage,
        uniqueIdsThisSegment: summary.uniqueIdsThisSegment,
        totalElementsLastSeen: summary.totalElementsLastSeen,
        elapsedMs: summary.elapsedMs,
        navMs: summary.navMs,
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
