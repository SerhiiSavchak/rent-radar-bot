/**
 * Source-layer live evidence: OLX HTML radius + sort.
 * Not production. Requires Playwright. Writes sanitized JSON under EVIDENCE_DIR.
 *
 * PASS criteria (all required, repeated ≥3 cycles):
 * - radius: with search[dist]=15, organic cards include suburb cities absent from city-only sample
 * - sort: organic created_time on page1 is non-increasing AND page2 oldest≤page1 oldest (with overlap)
 * HTTP 200 / URL retention alone is NOT pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  extractListingAdsFromPrerenderedState,
  inspectPrerenderedState,
} from "../sources/olx/olx-browser.html-extract.ts";

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR?.trim() ||
  join(process.cwd(), "evidence", "source-layer-live", "olx-radius-sort");
const CYCLES = Math.max(1, Number(process.env.LIVE_PROBE_CYCLES ?? "3") || 3);

type AdSample = {
  id?: string;
  city?: string;
  createdTime?: number;
  promoted?: boolean;
};

function cityOf(ad: Record<string, unknown>): string | undefined {
  const loc = ad.location as Record<string, unknown> | undefined;
  if (!loc) return undefined;
  if (typeof loc.cityName === "string") return loc.cityName;
  if (loc.city && typeof loc.city === "object" && typeof (loc.city as { name?: string }).name === "string") {
    return (loc.city as { name: string }).name;
  }
  if (typeof loc.city === "string") return loc.city;
  return undefined;
}

/** HTML prerendered ads use camelCase ISO; API shape uses snake_case epoch seconds. */
function createdEpochSeconds(ad: Record<string, unknown>): number | undefined {
  for (const key of ["createdTime", "created_time", "lastRefreshTime", "last_refresh_time"] as const) {
    const value = ad[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? Math.floor(value / 1000) : value;
    }
    if (typeof value === "string" && value.trim()) {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    }
  }
  return undefined;
}

function isPromotedAd(ad: Record<string, unknown>): boolean {
  if (ad.isPromoted === true || ad.is_promoted === true || ad.is_top === true) return true;
  const promotion = ad.promotion;
  if (promotion && typeof promotion === "object") {
    const p = promotion as Record<string, unknown>;
    if (p.top_ad === true || p.highlighted === true || p.urgent === true) return true;
  }
  return false;
}

function sampleAds(ads: unknown[]): AdSample[] {
  const out: AdSample[] = [];
  for (const raw of ads) {
    if (!raw || typeof raw !== "object") continue;
    const ad = raw as Record<string, unknown>;
    const created = createdEpochSeconds(ad);
    const city = cityOf(ad);
    const sample: AdSample = {
      promoted: isPromotedAd(ad),
    };
    if (typeof ad.id === "number" || typeof ad.id === "string") {
      sample.id = String(ad.id);
    }
    if (city) {
      sample.city = city;
    }
    if (created !== undefined) {
      sample.createdTime = created;
    }
    out.push(sample);
  }
  return out;
}

function organicCreated(samples: AdSample[]): number[] {
  return samples
    .filter((s) => s.promoted !== true && typeof s.createdTime === "number")
    .map((s) => s.createdTime as number);
}

function isNonIncreasing(times: number[]): boolean {
  if (times.length < 3) return false;
  for (let i = 1; i < times.length; i += 1) {
    if (times[i]! > times[i - 1]!) return false;
  }
  return true;
}

async function fetchCatalog(url: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      locale: "uk-UA",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Prefer the navigation response body (same as production extract). page.content()
    // after client hydration can drop or alter __PRERENDERED_STATE__.
    const html = (await resp?.text()) ?? (await page.content());
    const inspection = inspectPrerenderedState(html);
    const ads = extractListingAdsFromPrerenderedState(inspection.decoded);
    const samples = sampleAds(ads);
    const cities = [...new Set(samples.map((s) => s.city).filter((c): c is string => Boolean(c)))];
    const suburbs = cities.filter((c) => !/^львів$/i.test(c.trim()));
    const organic = organicCreated(samples);
    return {
      requested: url,
      status: resp?.status() ?? 0,
      finalUrl: page.url(),
      htmlChars: html.length,
      hasPrerenderedMarker: html.includes("__PRERENDERED_STATE__"),
      paramsRetained: {
        dist: /search(?:%5B|\[)dist(?:%5D|\])=15/i.test(page.url()),
        order: /search(?:%5B|\[)order(?:%5D|\])=created_at/i.test(page.url()),
      },
      hasPrerendered: inspection.present && inspection.complete,
      adCount: samples.length,
      organicDatedCount: organic.length,
      cities,
      suburbs,
      organicCreatedHead: organic.slice(0, 8),
      organicNonIncreasing: isNonIncreasing(organic),
      oldestOrganic: organic.length ? Math.min(...organic) : null,
      newestOrganic: organic.length ? Math.max(...organic) : null,
    };
  } finally {
    await browser.close();
  }
}

const BASE = "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/";

async function oneCycle(cycle: number) {
  const cityOnly = await fetchCatalog(BASE);
  const withDist = await fetchCatalog(`${BASE}?search%5Bdist%5D=15`);
  const withDistOrder = await fetchCatalog(
    `${BASE}?search%5Bdist%5D=15&search%5Border%5D=created_at%3Adesc`,
  );
  const page2 = await fetchCatalog(
    `${BASE}?search%5Bdist%5D=15&search%5Border%5D=created_at%3Adesc&page=2`,
  );

  const suburbEvidence =
    withDist.suburbs.some((s) => !cityOnly.cities.includes(s)) ||
    withDistOrder.suburbs.some((s) => !cityOnly.cities.includes(s));
  const radiusApplied =
    suburbEvidence &&
    withDist.status === 200 &&
    withDist.hasPrerendered &&
    withDist.adCount > 0;
  const sortApplied =
    withDistOrder.organicNonIncreasing &&
    page2.organicNonIncreasing &&
    withDistOrder.oldestOrganic !== null &&
    page2.newestOrganic !== null &&
    page2.newestOrganic <= withDistOrder.oldestOrganic + 2 * 60 * 60 &&
    withDistOrder.organicDatedCount >= 5 &&
    page2.organicDatedCount >= 3;

  return {
    cycle,
    at: new Date().toISOString(),
    cityOnly: {
      status: cityOnly.status,
      adCount: cityOnly.adCount,
      cities: cityOnly.cities,
      suburbs: cityOnly.suburbs,
      paramsRetained: cityOnly.paramsRetained,
    },
    withDist: {
      status: withDist.status,
      adCount: withDist.adCount,
      cities: withDist.cities,
      suburbs: withDist.suburbs,
      paramsRetained: withDist.paramsRetained,
      organicNonIncreasing: withDist.organicNonIncreasing,
    },
    withDistOrder: {
      status: withDistOrder.status,
      adCount: withDistOrder.adCount,
      organicDatedCount: withDistOrder.organicDatedCount,
      organicCreatedHead: withDistOrder.organicCreatedHead,
      organicNonIncreasing: withDistOrder.organicNonIncreasing,
      oldestOrganic: withDistOrder.oldestOrganic,
      newestOrganic: withDistOrder.newestOrganic,
      paramsRetained: withDistOrder.paramsRetained,
      suburbs: withDistOrder.suburbs,
    },
    page2: {
      status: page2.status,
      adCount: page2.adCount,
      organicDatedCount: page2.organicDatedCount,
      organicCreatedHead: page2.organicCreatedHead,
      organicNonIncreasing: page2.organicNonIncreasing,
      oldestOrganic: page2.oldestOrganic,
      newestOrganic: page2.newestOrganic,
    },
    verdict: {
      urlRetentionOnly: withDistOrder.paramsRetained.dist && withDistOrder.paramsRetained.order,
      radiusListingEvidence: radiusApplied,
      sortListingEvidence: sortApplied,
      radiusStatus: radiusApplied ? "PASS" : "BLOCKED",
      sortStatus: sortApplied ? "PASS" : "BLOCKED",
      sortBlockReason: sortApplied
        ? null
        : !withDistOrder.organicNonIncreasing
          ? "organic_created_not_non_increasing"
          : !page2.organicNonIncreasing
            ? "page2_organic_created_not_non_increasing"
            : withDistOrder.organicDatedCount < 5 || page2.organicDatedCount < 3
              ? "insufficient_dated_organic"
              : "page_continuity_or_other",
    },
  };
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const cycles = [];
  for (let i = 1; i <= CYCLES; i += 1) {
    console.error(`olx-radius-sort cycle ${i}/${CYCLES}`);
    cycles.push(await oneCycle(i));
    if (i < CYCLES) await new Promise((r) => setTimeout(r, 2_000));
  }
  const radiusPass = cycles.every((c) => c.verdict.radiusListingEvidence);
  const sortPass = cycles.every((c) => c.verdict.sortListingEvidence);
  const summary = {
    probe: "olx-html-radius-sort",
    commit: process.env.RENT_RADAR_COMMIT ?? "unknown",
    cycles: CYCLES,
    radiusStatus: radiusPass ? "PASS" : "BLOCKED",
    sortStatus: sortPass ? "PASS" : "BLOCKED",
    note: "PASS requires listing-level suburb/order evidence on every cycle; URL retention alone is insufficient.",
    cyclesDetail: cycles,
  };
  const out = join(EVIDENCE_DIR, `summary-${Date.now()}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ written: out, radiusStatus: summary.radiusStatus, sortStatus: summary.sortStatus }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
