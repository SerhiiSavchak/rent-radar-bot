import { inspectPrerenderedState } from "./olx-browser.html-extract.ts";
import {
  mergeOlxProfilePages,
  parseOlxProfileInventory,
  resolveOlxInventoryProbeTarget,
  type OlxProfileSnapshot,
} from "./olx-seller-profile.ts";

const UNREADABLE: OlxProfileSnapshot = { acquired: false };

function pageTwoPath(hrefs: string[], probeTarget: string): string | undefined {
  const slug = probeTarget.match(/\/uk\/list\/user\/[A-Za-z0-9]+/)?.[0];
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
 * Bounded public inventory for an exact OLX listing, a `/uk/list/user/…` path,
 * or a seller-linked shop/home URL. One stock Chromium, at most two profile
 * pages, closed before return. Transport failure → unreadable (unknown, not owner).
 *
 * Shop/storefront hosts are probe targets only — presence of a shop is not
 * intermediary proof.
 */
export async function probeOlxSellerProfile(input: {
  listingUrl?: string;
  listingHtml?: string;
  profilePath?: string;
  timeoutMs?: number;
}): Promise<OlxProfileSnapshot> {
  const timeoutMs = input.timeoutMs ?? 20_000;
  let probeTarget = input.profilePath ?? undefined;
  if (!probeTarget && input.listingHtml) {
    probeTarget = resolveOlxInventoryProbeTarget(input.listingHtml);
  }
  if (!probeTarget && !input.listingUrl) {
    return UNREADABLE;
  }

  const { chromium } = await import("playwright");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ locale: "uk-UA" });

    if (!probeTarget) {
      const listingUrl = input.listingUrl;
      if (!listingUrl || !listingUrl.startsWith("https://www.olx.ua/")) {
        return UNREADABLE;
      }
      const listingResponse = await page.goto(listingUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      const listingHtml = (await listingResponse?.text()) ?? "";
      probeTarget = resolveOlxInventoryProbeTarget(listingHtml);
      if (!probeTarget || listingResponse?.status() !== 200) {
        return UNREADABLE;
      }
    }

    const profileResponse = await page.goto(new URL(probeTarget, "https://www.olx.ua").toString(), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
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
    const nextPath = pageTwoPath(hrefs, probeTarget);
    if (!nextPath) {
      return first;
    }
    try {
      const secondResponse = await page.goto(new URL(nextPath, page.url()).toString(), {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
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
