/**
 * One-shot live probe: compare OLX HTML catalog filters via prerendered ads cities.
 * Not imported by production. Run on Oracle with Playwright.
 */
import { chromium } from "playwright";
import {
  extractListingAdsFromPrerenderedState,
  inspectPrerenderedState,
} from "../sources/olx/olx-browser.html-extract.ts";

function citiesFromAds(ads: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of ads) {
    if (!raw || typeof raw !== "object") continue;
    const loc = (raw as { location?: Record<string, unknown> }).location;
    if (!loc) continue;
    const city =
      (typeof loc.cityName === "string" && loc.cityName) ||
      (loc.city && typeof loc.city === "object" && typeof (loc.city as { name?: string }).name === "string"
        ? (loc.city as { name: string }).name
        : typeof loc.city === "string"
          ? loc.city
          : undefined);
    if (city) out.push(city);
  }
  return [...new Set(out)];
}

async function sample(url: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "uk-UA" });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const html = (await resp?.text()) ?? "";
    const inspection = inspectPrerenderedState(html);
    const ads = extractListingAdsFromPrerenderedState(inspection.decoded);
    const cities = citiesFromAds(ads);
    const suburbs = cities.filter((c) => !/^львів$/i.test(c.trim()));
    // totalElements if present
    const listing = (inspection.decoded as { listing?: { listing?: { totalElements?: number; ads?: unknown[] } } } | undefined)
      ?.listing?.listing;
    return {
      requested: url,
      status: resp?.status() ?? 0,
      finalUrl: page.url(),
      hasState: inspection.present && inspection.complete,
      adCount: ads.length,
      totalElements: listing?.totalElements ?? null,
      cities,
      suburbs,
    };
  } finally {
    await browser.close();
  }
}

const urls = [
  "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/",
  "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/?search%5Bdist%5D=15",
  "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/?search%5Bdist%5D=15&search%5Border%5D=created_at%3Adesc",
  "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/?search%5Border%5D=created_at%3Adesc",
  "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/?page=2",
];

const results = [];
for (const url of urls) {
  results.push(await sample(url));
}
console.log(JSON.stringify(results, null, 2));
