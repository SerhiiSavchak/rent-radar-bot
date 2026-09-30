import { inspectPrerenderedState } from "./olx-browser.html-extract.ts";
import { SELLER_INVENTORY_LIMIT_MIN } from "../../delivery/seller-profile.ts";
import {
  mergeOlxProfilePages,
  parseOlxProfileInventory,
  resolveOlxInventoryProbeTarget,
  OLX_PROFILE_PAGE_HARD_CAP,
  type OlxProfileSnapshot,
} from "./olx-seller-profile.ts";

const UNREADABLE: OlxProfileSnapshot = { acquired: false };

function pagePath(hrefs: string[], probeTarget: string, page: number): string | undefined {
  const slug = probeTarget.match(/\/uk\/list\/user\/[A-Za-z0-9]+/)?.[0];
  const pageRe = new RegExp(`[?&]page=${page}(?:&|$)`);
  return hrefs.find((href) => {
    if (!pageRe.test(href)) {
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
 * or a seller-linked shop/home URL. One stock Chromium, pages until inventory
 * reject threshold / exhaustion / hard cap, closed before return.
 * Transport failure → unreadable (unknown, not owner).
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
  let listingHtml = input.listingHtml;
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
      listingHtml = (await listingResponse?.text()) ?? "";
      probeTarget = resolveOlxInventoryProbeTarget(listingHtml);
      if (!probeTarget || listingResponse?.status() !== 200) {
        return { acquired: false, ...(listingHtml ? { listingHtml } : {}) };
      }
    }

    const profileResponse = await page.goto(new URL(probeTarget, "https://www.olx.ua").toString(), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (profileResponse?.status() !== 200) {
      return { acquired: false, ...(listingHtml ? { listingHtml } : {}) };
    }
    let merged = parseOlxProfileInventory(
      inspectPrerenderedState((await profileResponse.text()) ?? "").decoded,
    );
    if (listingHtml) {
      merged = { ...merged, listingHtml };
    }
    // Stop as soon as ≥5 precise properties are known.
    if (!merged.acquired || (merged.precisePropertyKeys?.length ?? 0) >= SELLER_INVENTORY_LIMIT_MIN) {
      return merged;
    }

    let nextPage = 2;
    while (
      (merged.totalPages ?? 0) >= nextPage &&
      nextPage <= OLX_PROFILE_PAGE_HARD_CAP &&
      (merged.precisePropertyKeys?.length ?? 0) < SELLER_INVENTORY_LIMIT_MIN
    ) {
      const hrefs = await page.$$eval("a[href]", (nodes) =>
        nodes.map((node) => node.getAttribute("href") ?? ""),
      );
      const nextPath = pagePath(hrefs, probeTarget, nextPage);
      if (!nextPath) {
        break;
      }
      try {
        const nextResponse = await page.goto(new URL(nextPath, page.url()).toString(), {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
        if (nextResponse?.status() !== 200) {
          // Partial pages remain; caller treats incompleteness as unresolved.
          break;
        }
        const nextSnap = parseOlxProfileInventory(
          inspectPrerenderedState((await nextResponse.text()) ?? "").decoded,
        );
        merged = mergeOlxProfilePages(merged, nextSnap);
        if (listingHtml) {
          merged = { ...merged, listingHtml };
        }
      } catch {
        break;
      }
      if ((merged.precisePropertyKeys?.length ?? 0) >= SELLER_INVENTORY_LIMIT_MIN) {
        break;
      }
      nextPage += 1;
    }
    return merged;
  } catch {
    return { acquired: false, ...(listingHtml ? { listingHtml } : {}) };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
