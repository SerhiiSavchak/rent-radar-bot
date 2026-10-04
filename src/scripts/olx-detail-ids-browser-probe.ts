/**
 * READ-ONLY browser probe for specific OLX offer IDs. No Telegram.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalOlxDetailTarget } from "../delivery/olx-detail-seller.ts";
import { inspectOlxOfferDetailHtml } from "../sources/olx/olx-browser.detail-inspect.ts";
import { classifyOlxLinkedSellerHtml } from "../delivery/olx-detail-seller.ts";

const IDS = ["936778535", "936783731", "936785637", "936799302"];
const OUT = join(process.env.HOME ?? process.cwd(), "rent-radar-runtime", "evidence", "seller-detail-hold");
mkdirSync(OUT, { recursive: true, mode: 0o700 });

const browser = await chromium.launch({ headless: true });
const rows = [];
try {
  for (const id of IDS) {
    const target = canonicalOlxDetailTarget(`https://www.olx.ua/d/uk/obyavlenie/x-ID${id}.html`);
    const url = target?.url ?? `https://www.olx.ua/d/uk/obyavlenie/x-ID${id}.html`;
    const page = await browser.newPage();
    const started = Date.now();
    let status = 0;
    let finalUrl = url;
    let html = "";
    let navError: string | undefined;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      status = resp?.status() ?? 0;
      finalUrl = page.url();
      await page.waitForTimeout(1500);
      html = await page.content();
    } catch (e) {
      navError = e instanceof Error ? e.message : String(e);
    }
    const inspection = html ? inspectOlxOfferDetailHtml(html, id) : undefined;
    const classified = html ? classifyOlxLinkedSellerHtml(html, id) : undefined;
    rows.push({
      id,
      url,
      status,
      finalUrl,
      elapsedMs: Date.now() - started,
      navError,
      htmlBytes: html.length,
      offerFound: inspection?.offerRecordFound ?? false,
      sellerType: inspection?.sellerType ?? null,
      isBusiness: inspection?.isBusiness ?? null,
      companyName: inspection?.companyName ?? null,
      accountCreatedAt: inspection?.accountCreatedAt ?? null,
      classified,
      title: inspection?.title?.slice(0, 120) ?? null,
      notes: inspection?.notes?.slice(0, 8) ?? [],
    });
    await page.close();
    console.log(JSON.stringify(rows.at(-1), null, 2));
  }
} finally {
  await browser.close();
}
const out = join(OUT, `olx-browser-detail-${Date.now()}.json`);
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
console.log("wrote", out);
