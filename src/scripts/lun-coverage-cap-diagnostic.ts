/**
 * READ-ONLY live diagnostic: current LUN production acquisition vs deeper bounded walk.
 * No Telegram. No SQLite. Writes JSON under EVIDENCE_DIR.
 *
 * Usage:
 *   npx tsx src/scripts/lun-coverage-cap-diagnostic.ts
 *   LIVE_PROBE_CYCLES=3 npx tsx src/scripts/lun-coverage-cap-diagnostic.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpGet } from "../utils/http.ts";
import { inspectLunHtml } from "../sources/lun/lun.parser.ts";
import {
  LUN_ACQUIRED_CARD_CAP,
  LUN_CATEGORY_WALK_BUDGET_MS,
  LUN_FLATS_URL,
  LUN_HOUSES_URL,
  LUN_PAGE_SAFETY_CAP,
  LunSource,
  buildLunCategoryPageUrl,
  readLunWalkBoundary,
} from "../sources/lun/lun.source.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { getConfig } from "../config/env.ts";
import type { Listing } from "../domain/listing.ts";

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR?.trim() ||
  join(process.env.HOME ?? process.cwd(), "rent-radar-runtime", "evidence", "lun-coverage-cap");
const CYCLES = Math.max(1, Number(process.env.LIVE_PROBE_CYCLES ?? "3") || 3);
const DEEP_SAFETY_CAP = Math.max(LUN_PAGE_SAFETY_CAP, Number(process.env.LUN_DEEP_SAFETY_CAP ?? "120") || 120);
const DEEP_BUDGET_MS = Math.max(
  LUN_CATEGORY_WALK_BUDGET_MS,
  Number(process.env.LUN_DEEP_BUDGET_MS ?? "600000") || 600_000,
);
const DEEP_ACQUIRED_CAP = Math.max(
  LUN_ACQUIRED_CARD_CAP,
  Number(process.env.LUN_DEEP_ACQUIRED_CAP ?? "10000") || 10_000,
);

type AgeBucket = {
  withPublishedAt: number;
  le10m: number;
  le30m: number;
  le60m: number;
  le24h: number;
  olderOrUnknown: number;
};

function ageBuckets(listings: Listing[], nowMs: number): AgeBucket {
  const out: AgeBucket = {
    withPublishedAt: 0,
    le10m: 0,
    le30m: 0,
    le60m: 0,
    le24h: 0,
    olderOrUnknown: 0,
  };
  for (const listing of listings) {
    if (!listing.publishedAt) {
      out.olderOrUnknown += 1;
      continue;
    }
    out.withPublishedAt += 1;
    const ageMs = nowMs - listing.publishedAt.getTime();
    if (ageMs <= 10 * 60_000) out.le10m += 1;
    if (ageMs <= 30 * 60_000) out.le30m += 1;
    if (ageMs <= 60 * 60_000) out.le60m += 1;
    if (ageMs <= 24 * 60 * 60_000) out.le24h += 1;
    else out.olderOrUnknown += 1;
  }
  return out;
}

function pageTimestampOrder(pages: Array<{ page: number; timestamps: string[] }>) {
  const perPageNewest: Array<{ page: number; newest?: string; oldest?: string; count: number }> = [];
  for (const page of pages) {
    const sorted = [...page.timestamps].filter(Boolean).sort();
    const newest = sorted.at(-1);
    const oldest = sorted[0];
    perPageNewest.push({
      page: page.page,
      ...(newest ? { newest } : {}),
      ...(oldest ? { oldest } : {}),
      count: page.timestamps.length,
    });
  }
  let newestFirstTransitions = 0;
  let oldestFirstTransitions = 0;
  let incomparable = 0;
  for (let i = 1; i < perPageNewest.length; i += 1) {
    const prev = perPageNewest[i - 1]!;
    const cur = perPageNewest[i]!;
    if (!prev.newest || !cur.newest) {
      incomparable += 1;
      continue;
    }
    if (prev.newest >= cur.newest) newestFirstTransitions += 1;
    if (prev.newest <= cur.newest) oldestFirstTransitions += 1;
  }
  return {
    perPage: perPageNewest,
    newestFirstTransitions,
    oldestFirstTransitions,
    incomparable,
    provenNewestFirst:
      newestFirstTransitions > 0 &&
      oldestFirstTransitions === 0 &&
      incomparable === 0 &&
      perPageNewest.length >= 3,
  };
}

async function deepWalkCategory(baseUrl: string, label: string) {
  const started = Date.now();
  const pages: Array<{
    page: number;
    status: number;
    resultKind: string;
    rawCardCount: number;
    validatedCardCount: number;
    schemaRejectCount: number;
    totalGroupedCount?: number;
    totalPages?: number;
    ids: string[];
    timestamps: string[];
    elapsedMs: number;
  }> = [];
  const allListings: Listing[] = [];
  const rawIds: string[] = [];
  const duplicateIds: string[] = [];
  const seen = new Set<string>();
  let declaredTotal: number | undefined;
  let declaredPages: number | undefined;
  let stopReason = "completed";

  for (let page = 1; page <= DEEP_SAFETY_CAP; page += 1) {
    if (page > 1 && Date.now() - started >= DEEP_BUDGET_MS) {
      stopReason = "time_budget";
      break;
    }
    const url = buildLunCategoryPageUrl(baseUrl, page);
    let response;
    try {
      response = await httpGet(url, { timeoutMs: 25_000, maxRetries: 1 });
    } catch {
      stopReason = page === 1 ? "transport_error" : "http_error";
      break;
    }
    const inspection = inspectLunHtml(response.bodyText);
    const boundary = readLunWalkBoundary(response.bodyText);
    if (boundary.totalGroupedCount !== undefined) {
      declaredTotal =
        declaredTotal === undefined
          ? boundary.totalGroupedCount
          : Math.max(declaredTotal, boundary.totalGroupedCount);
    }
    if (boundary.totalPages !== undefined) declaredPages = boundary.totalPages;
    const ids = inspection.listings.map((l) => l.sourceId);
    for (const id of inspection.rawCardIds) {
      if (seen.has(id)) duplicateIds.push(id);
      else {
        seen.add(id);
        rawIds.push(id);
      }
    }
    allListings.push(...inspection.listings);
    pages.push({
      page,
      status: response.status,
      resultKind: inspection.resultKind,
      rawCardCount: inspection.rawCardCount,
      validatedCardCount: inspection.validatedCardCount,
      schemaRejectCount: inspection.schemaRejectCount,
      ...(boundary.totalGroupedCount !== undefined
        ? { totalGroupedCount: boundary.totalGroupedCount }
        : {}),
      ...(boundary.totalPages !== undefined ? { totalPages: boundary.totalPages } : {}),
      ids,
      timestamps: inspection.listings
        .map((l) => l.publishedAt?.toISOString())
        .filter((v): v is string => Boolean(v)),
      elapsedMs: Date.now() - started,
    });
    if (response.status !== 200) {
      stopReason = "http_error";
      break;
    }
    if (inspection.resultKind === "parser_failure") {
      stopReason = "parser_failure";
      break;
    }
    if (inspection.listings.length === 0 && inspection.rawCardCount === 0) {
      stopReason = "empty_page";
      break;
    }
    if (declaredTotal !== undefined && seen.size >= declaredTotal) {
      stopReason = "maxTotalGroupedCount";
      break;
    }
    if (declaredPages !== undefined && page >= declaredPages) {
      stopReason = "totalPages";
      break;
    }
    if (page === DEEP_SAFETY_CAP) {
      stopReason = "safety_cap";
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    label,
    baseUrl,
    stopReason,
    declaredTotal,
    declaredPages,
    pagesFetched: pages.length,
    rawCards: rawIds.length + duplicateIds.length,
    uniqueIds: rawIds.length,
    duplicateIds: duplicateIds.length,
    parserFailures: pages.filter((p) => p.resultKind === "parser_failure").length,
    schemaRejects: pages.reduce((n, p) => n + p.schemaRejectCount, 0),
    listings: allListings,
    pageOrder: pageTimestampOrder(pages),
    pages: pages.map((p) => ({
      page: p.page,
      status: p.status,
      resultKind: p.resultKind,
      rawCardCount: p.rawCardCount,
      validatedCardCount: p.validatedCardCount,
      schemaRejectCount: p.schemaRejectCount,
      totalGroupedCount: p.totalGroupedCount,
      totalPages: p.totalPages,
      idCount: p.ids.length,
      newest: p.timestamps.sort().at(-1),
      oldest: p.timestamps.sort()[0],
      elapsedMs: p.elapsedMs,
    })),
    elapsedMs: Date.now() - started,
  };
}

function summarizeListingSet(listings: Listing[], nowMs: number) {
  const config = getConfig();
  const filtered = applyListingFilters(listings, config, {
    ownerOnly: false,
    requireCoordinates: false,
  });
  const propertyValid = filtered.filter((row) => row.propertyMatched).map((row) => row.listing);
  const geoValid = filtered
    .filter((row) => row.propertyMatched && row.locationMatched)
    .map((row) => row.listing);
  return {
    count: listings.length,
    propertyValid: propertyValid.length,
    geoValid: geoValid.length,
    ages: ageBuckets(listings, nowMs),
    propertyValidAges: ageBuckets(propertyValid, nowMs),
    geoValidAges: ageBuckets(geoValid, nowMs),
    ids: listings.map((l) => l.sourceId),
  };
}

async function oneCycle(cycle: number) {
  const started = Date.now();
  const nowMs = Date.now();

  const current = new LunSource();
  const currentResult = await current.inspectLatest();
  const currentIds = new Set(currentResult.listings.map((l) => l.sourceId));

  const deepFlats = await deepWalkCategory(LUN_FLATS_URL, "flats");
  const deepHouses = await deepWalkCategory(LUN_HOUSES_URL, "houses");
  const deepListings = [...deepFlats.listings, ...deepHouses.listings];
  const deepById = new Map(deepListings.map((l) => [l.sourceId, l]));
  const deepUniqueIds = [...new Set(deepListings.map((l) => l.sourceId))];

  const beyondCap = deepUniqueIds
    .filter((id) => !currentIds.has(id))
    .map((id) => deepById.get(id)!)
    .filter(Boolean);
  const beyondSummary = summarizeListingSet(beyondCap, nowMs);
  const currentSummary = summarizeListingSet(currentResult.listings, nowMs);

  const stopNotes = (currentResult.rawNotes ?? []).filter(
    (n) =>
      n.includes("coverage_truncated") ||
      n.includes("terminal=") ||
      n.includes("acquired-response") ||
      n.includes("lun_schema_rejects") ||
      n.includes("lun_pages_fetched") ||
      n.includes("total_first=") ||
      n.includes("total_max="),
  );

  return {
    cycle,
    at: new Date().toISOString(),
    constants: {
      LUN_PAGE_SAFETY_CAP,
      LUN_CATEGORY_WALK_BUDGET_MS,
      LUN_ACQUIRED_CARD_CAP,
      DEEP_SAFETY_CAP,
      DEEP_BUDGET_MS,
      DEEP_ACQUIRED_CAP,
    },
    current: {
      resultKind: currentResult.resultKind,
      healthy: currentResult.health.healthy,
      message: currentResult.health.message,
      coverage: currentResult.coverage,
      cardsFetched: currentResult.listings.length,
      latencyMs: currentResult.health.latencyMs,
      stopNotes,
      summary: {
        count: currentSummary.count,
        propertyValid: currentSummary.propertyValid,
        geoValid: currentSummary.geoValid,
        ages: currentSummary.ages,
      },
    },
    deep: {
      flats: {
        stopReason: deepFlats.stopReason,
        pagesFetched: deepFlats.pagesFetched,
        uniqueIds: deepFlats.uniqueIds,
        duplicateIds: deepFlats.duplicateIds,
        schemaRejects: deepFlats.schemaRejects,
        declaredTotal: deepFlats.declaredTotal,
        declaredPages: deepFlats.declaredPages,
        pageOrder: deepFlats.pageOrder,
        elapsedMs: deepFlats.elapsedMs,
        pages: deepFlats.pages,
      },
      houses: {
        stopReason: deepHouses.stopReason,
        pagesFetched: deepHouses.pagesFetched,
        uniqueIds: deepHouses.uniqueIds,
        duplicateIds: deepHouses.duplicateIds,
        schemaRejects: deepHouses.schemaRejects,
        declaredTotal: deepHouses.declaredTotal,
        declaredPages: deepHouses.declaredPages,
        pageOrder: deepHouses.pageOrder,
        elapsedMs: deepHouses.elapsedMs,
        pages: deepHouses.pages,
      },
      uniqueIds: deepUniqueIds.length,
      listingsCount: deepListings.length,
    },
    beyondCurrent: {
      count: beyondSummary.count,
      propertyValid: beyondSummary.propertyValid,
      geoValid: beyondSummary.geoValid,
      ages: beyondSummary.ages,
      propertyValidAges: beyondSummary.propertyValidAges,
      geoValidAges: beyondSummary.geoValidAges,
      sampleIds: beyondSummary.ids.slice(0, 20),
      freshEligibleRisk:
        beyondSummary.geoValidAges.le60m > 0 || beyondSummary.propertyValidAges.le60m > 0,
    },
    elapsedMs: Date.now() - started,
  };
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const cycles = [];
  for (let i = 1; i <= CYCLES; i += 1) {
    console.log(`[lun-coverage-cap] cycle ${i}/${CYCLES} starting…`);
    const row = await oneCycle(i);
    cycles.push(row);
    console.log(
      JSON.stringify(
        {
          cycle: row.cycle,
          currentHealthy: row.current.healthy,
          currentCards: row.current.cardsFetched,
          currentMessage: row.current.message,
          beyond: row.beyondCurrent.count,
          beyondLe60m: row.beyondCurrent.ages.le60m,
          beyondGeoLe60m: row.beyondCurrent.geoValidAges.le60m,
          freshEligibleRisk: row.beyondCurrent.freshEligibleRisk,
          flatsStop: row.deep.flats.stopReason,
          housesStop: row.deep.houses.stopReason,
          flatsNewestFirst: row.deep.flats.pageOrder.provenNewestFirst,
          housesNewestFirst: row.deep.houses.pageOrder.provenNewestFirst,
          elapsedMs: row.elapsedMs,
        },
        null,
        2,
      ),
    );
    if (i < CYCLES) await new Promise((r) => setTimeout(r, 2_000));
  }

  const anyRisk = cycles.some((c) => c.beyondCurrent.freshEligibleRisk);
  const anyBeyond = cycles.some((c) => c.beyondCurrent.count > 0);
  const anyCurrentDegraded = cycles.some((c) => !c.current.healthy);
  const summary = {
    at: new Date().toISOString(),
    commitHint: "fix/current-production-stabilization",
    cycles: cycles.length,
    anyCurrentDegraded,
    anyBeyondCurrentIds: anyBeyond,
    freshEligibleBeyondCurrent: anyRisk,
    verdict: anyRisk
      ? "UNSAFE_fresh_eligible_beyond_current_acquisition"
      : anyBeyond
        ? "BEYOND_IDS_BUT_NO_FRESH_ELIGIBLE_IN_WINDOW"
        : anyCurrentDegraded
          ? "CURRENT_DEGRADED_BUT_DEEP_MATCHED"
          : "CURRENT_COMPLETE_MATCHED_DEEP",
    cycleSummaries: cycles.map((c) => ({
      cycle: c.cycle,
      currentHealthy: c.current.healthy,
      currentCards: c.current.cardsFetched,
      currentMessage: c.current.message,
      stopNotes: c.current.stopNotes,
      beyond: c.beyondCurrent,
      flatsStop: c.deep.flats.stopReason,
      housesStop: c.deep.houses.stopReason,
      flatsPageOrder: {
        newestFirstTransitions: c.deep.flats.pageOrder.newestFirstTransitions,
        oldestFirstTransitions: c.deep.flats.pageOrder.oldestFirstTransitions,
        provenNewestFirst: c.deep.flats.pageOrder.provenNewestFirst,
      },
      housesPageOrder: {
        newestFirstTransitions: c.deep.houses.pageOrder.newestFirstTransitions,
        oldestFirstTransitions: c.deep.houses.pageOrder.oldestFirstTransitions,
        provenNewestFirst: c.deep.houses.pageOrder.provenNewestFirst,
      },
      elapsedMs: c.elapsedMs,
    })),
  };

  const out = join(EVIDENCE_DIR, `lun-coverage-cap-${Date.now()}.json`);
  writeFileSync(out, `${JSON.stringify({ summary, cycles }, null, 2)}\n`, { mode: 0o600 });
  console.log(`[lun-coverage-cap] wrote ${out}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
