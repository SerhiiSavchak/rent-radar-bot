import type { Listing, ListingPrice } from "../../domain/listing.ts";
import { inspectPrerenderedState } from "./olx-browser.html-extract.ts";

/** Detail reads per cycle. Catalog JSON only exposes the converted UAH amount. */
export const OLX_DISPLAY_PRICE_MAX = 8;

/**
 * OLX listing pages put the presented price in `price.displayValue`
 * (`1 300 $`) and the converted hryvnia amount in `regularPrice`.
 */
export function parseOlxDisplayPrice(raw: string): Pick<ListingPrice, "amount" | "currency"> | undefined {
  const text = raw.replace(/\u00a0/g, " ").trim();
  let currency: string | undefined;
  if (text.includes("$") || /\busd\b/i.test(text)) {
    currency = "USD";
  } else if (text.includes("€") || /\beur\b/i.test(text)) {
    currency = "EUR";
  } else if (/грн|uah/i.test(text)) {
    currency = "UAH";
  }
  if (!currency) {
    return undefined;
  }
  const numeric = text.replace(/[^\d,.]/g, "").replace(",", ".");
  const amount = Number(numeric);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  return { amount, currency };
}

export function applyOlxDisplayPrice(listing: Listing, displayValue: string): void {
  const parsed = parseOlxDisplayPrice(displayValue);
  if (!parsed) {
    return;
  }
  listing.displayPrice = {
    amount: parsed.amount,
    currency: parsed.currency,
    period: listing.price?.period ?? "month",
  };
}

function detailDisplayValue(state: unknown): string | undefined {
  if (!state || typeof state !== "object") {
    return undefined;
  }
  const price = (state as { ad?: { ad?: { price?: { displayValue?: unknown } } } }).ad?.ad?.price;
  return typeof price?.displayValue === "string" ? price.displayValue : undefined;
}

/**
 * Read the public listing page for a handful of OLX cards about to be sent.
 * Leaves `listing.price` unchanged so dedupe still compares the catalog amount.
 */
export async function readOlxDisplayedPrices(listings: Listing[]): Promise<void> {
  const targets = listings
    .filter((listing) => listing.source === "olx" && listing.url.startsWith("https://www.olx.ua/"))
    .slice(0, OLX_DISPLAY_PRICE_MAX);
  if (targets.length === 0) {
    return;
  }
  const { chromium } = await import("playwright");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (const listing of targets) {
      try {
        const response = await page.goto(listing.url, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        const html = await response?.text();
        const display = html ? detailDisplayValue(inspectPrerenderedState(html).decoded) : undefined;
        if (display) {
          applyOlxDisplayPrice(listing, display);
        }
      } catch {
        // The catalog price remains available for the card.
      }
    }
  } catch {
    // Playwright or the network failed; catalog prices still render.
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
