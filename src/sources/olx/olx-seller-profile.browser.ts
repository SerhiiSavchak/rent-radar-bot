import type { Listing } from "../../domain/listing.ts";
import { inspectPrerenderedState } from "./olx-browser.html-extract.ts";
import {
  findOlxPublicProfilePath,
  parseOlxProfileInventory,
  type OlxProfileSnapshot,
} from "./olx-seller-profile.ts";

const UNREADABLE: OlxProfileSnapshot = { acquired: false };

/**
 * One stock Chromium navigation from the listing page to the public profile link
 * already rendered on that page. Closes the browser before returning.
 * A transport failure is unreadable, not an owner.
 */
export async function probeOlxSellerProfile(listing: Listing): Promise<OlxProfileSnapshot> {
  if (listing.source !== "olx" || !listing.url.startsWith("https://www.olx.ua/")) {
    return UNREADABLE;
  }
  const { chromium } = await import("playwright");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ locale: "uk-UA" });
    const listingResponse = await page.goto(listing.url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const listingHtml = (await listingResponse?.text()) ?? "";
    const profilePath = findOlxPublicProfilePath(listingHtml);
    if (!profilePath || listingResponse?.status() !== 200) {
      return UNREADABLE;
    }
    const profileResponse = await page.goto(new URL(profilePath, "https://www.olx.ua").toString(), {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (profileResponse?.status() !== 200) {
      return UNREADABLE;
    }
    const state = inspectPrerenderedState((await profileResponse.text()) ?? "").decoded;
    return parseOlxProfileInventory(state);
  } catch {
    return UNREADABLE;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
