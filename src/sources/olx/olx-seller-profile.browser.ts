import type { Listing } from "../../domain/listing.ts";
import { inspectPrerenderedState } from "./olx-browser.html-extract.ts";
import {
  findOlxPublicProfilePath,
  mergeOlxProfilePages,
  parseOlxProfileInventory,
  type OlxProfileSnapshot,
} from "./olx-seller-profile.ts";

const UNREADABLE: OlxProfileSnapshot = { acquired: false };

function pageTwoPath(hrefs: string[], profilePath: string): string | undefined {
  const slug = profilePath.match(/\/uk\/list\/user\/[A-Za-z0-9]+/)?.[0];
  return hrefs.find((href) => {
    if (!/(?:\?|&)page=2(?:&|$)/.test(href)) {
      return false;
    }
    if (!slug) {
      return true;
    }
    return href.includes(slug) || href.startsWith("?") || href.startsWith("&");
  });
}

/**
 * One stock Chromium, opened for this seller and closed before return.
 * Page 2 is the profile's own next link, in the same browser, and only when
 * the first page says another page exists. A transport failure is unreadable.
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
    const first = parseOlxProfileInventory(
      inspectPrerenderedState((await profileResponse.text()) ?? "").decoded,
    );
    if (!first.acquired || (first.totalPages ?? 0) < 2) {
      return first;
    }
    const hrefs = await page.$$eval("a[href]", (nodes) =>
      nodes.map((node) => node.getAttribute("href") ?? ""),
    );
    const nextPath = pageTwoPath(hrefs, profilePath);
    if (!nextPath) {
      return first;
    }
    try {
      const secondResponse = await page.goto(new URL(nextPath, page.url()).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      if (secondResponse?.status() !== 200) {
        return first;
      }
      const second = parseOlxProfileInventory(
        inspectPrerenderedState((await secondResponse.text()) ?? "").decoded,
      );
      return mergeOlxProfilePages(first, second);
    } catch {
      return first;
    }
  } catch {
    return UNREADABLE;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
