/**
 * READ-ONLY probe for production seller-hold candidate IDs.
 * No Telegram. No SQLite. No browser unless OLX_BROWSER_PROBE=true.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpGet } from "../utils/http.ts";
import { canonicalOlxDetailTarget } from "../delivery/olx-detail-seller.ts";
import { inspectOlxOfferDetailHtml } from "../sources/olx/olx-browser.detail-inspect.ts";
import { inspectLunHtml } from "../sources/lun/lun.parser.ts";

const OUT_DIR =
  process.env.EVIDENCE_DIR?.trim() ||
  join(process.env.HOME ?? process.cwd(), "rent-radar-runtime", "evidence", "seller-detail-hold");

const OLX_IDS = ["936778535", "936783731", "936785637", "936799302"];
const LUN_ID = "4728301697";

async function probeHttp(url: string) {
  try {
    const response = await httpGet(url, {
      timeoutMs: 25_000,
      maxRetries: 0,
      headers: {
        Accept: "text/html,application/json",
        "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8",
      },
    });
    const body = response.bodyText ?? "";
    const lower = body.toLowerCase();
    return {
      url,
      status: response.status,
      finalUrl: response.url,
      bytes: body.length,
      challenge: /captcha|cf-challenge|just a moment|cloudflare/i.test(lower),
      removed: /неактивне|видалене|nie jest już dostępne|не знайдено|page not found/i.test(lower),
      title: (body.match(/<title>([^<]+)<\/title>/i)?.[1] ?? "").slice(0, 160),
      body,
    };
  } catch (error) {
    return {
      url,
      error: error instanceof Error ? error.message : String(error),
      body: "",
    };
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const olx = [];
  for (const id of OLX_IDS) {
    const target = canonicalOlxDetailTarget(`https://www.olx.ua/d/uk/obyavlenie/x-ID${id}.html`);
    const urls = [
      target?.url ?? `https://www.olx.ua/d/uk/obyavlenie/x-ID${id}.html`,
      `https://www.olx.ua/api/v1/offers/${id}/`,
    ];
    const probes = [];
    for (const url of urls) {
      const row = await probeHttp(url);
      let detailInspection: unknown;
      if (row.body && (row.status === 200 || row.status === 301 || row.status === 302)) {
        try {
          detailInspection = inspectOlxOfferDetailHtml(row.body, id);
        } catch (error) {
          detailInspection = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      probes.push({
        url: row.url,
        status: "status" in row ? row.status : undefined,
        finalUrl: "finalUrl" in row ? row.finalUrl : undefined,
        bytes: "bytes" in row ? row.bytes : 0,
        challenge: "challenge" in row ? row.challenge : undefined,
        removed: "removed" in row ? row.removed : undefined,
        title: "title" in row ? row.title : undefined,
        error: "error" in row ? row.error : undefined,
        detailInspection,
      });
      await new Promise((r) => setTimeout(r, 400));
    }
    olx.push({ id, canonical: target, probes });
  }

  const lunUrls = [`https://lun.ua/uk/realty/${LUN_ID}`, `https://lun.ua/realty/${LUN_ID}`];
  const lunProbes = [];
  for (const url of lunUrls) {
    const row = await probeHttp(url);
    let lunInspection: unknown;
    if (row.body && "status" in row && row.status === 200) {
      lunInspection = inspectLunHtml(row.body);
    }
    lunProbes.push({
      url: row.url,
      status: "status" in row ? row.status : undefined,
      finalUrl: "finalUrl" in row ? row.finalUrl : undefined,
      bytes: "bytes" in row ? row.bytes : 0,
      challenge: "challenge" in row ? row.challenge : undefined,
      removed: "removed" in row ? row.removed : undefined,
      title: "title" in row ? row.title : undefined,
      error: "error" in row ? row.error : undefined,
      listingCount:
        lunInspection && typeof lunInspection === "object" && "listings" in lunInspection
          ? (lunInspection as { listings: unknown[] }).listings.length
          : undefined,
      resultKind:
        lunInspection && typeof lunInspection === "object" && "resultKind" in lunInspection
          ? (lunInspection as { resultKind: string }).resultKind
          : undefined,
    });
  }

  const summary = {
    at: new Date().toISOString(),
    olx,
    lun: { id: LUN_ID, probes: lunProbes },
  };
  const out = join(OUT_DIR, `seller-detail-hold-${Date.now()}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
