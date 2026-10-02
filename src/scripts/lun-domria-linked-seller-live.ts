/**
 * Read-only proof for an exact LUN original DOM.RIA URL.
 * Fetches public pages and classifies the seller with the existing DOM.RIA parser.
 * Does not write SQLite, Telegram, or any production state.
 */
import { sellerRejectionReason } from "../filters/owner-filter.ts";
import { canonicalDomriaDetailTarget } from "../delivery/domria-detail-seller.ts";
import { extractInitialStateJson } from "../sources/domria/domria.parser.ts";
import { loadDomriaExactListing } from "../sources/domria/domria-newest.ts";
import { inspectLunHtml } from "../sources/lun/lun.parser.ts";
import { httpGet } from "../utils/http.ts";

const EXAMPLES = [
  {
    lunId: "4727172963",
    lunUrl: "https://lun.ua/realty/4727172963",
    domriaUrl:
      "https://dom.ria.com/uk/realty-dolgosrochnaya-arenda-kvartira-lvov-galitskiy-vagovaya-ulitsa-27193619.html",
  },
  {
    lunId: "4727172962",
    lunUrl: "https://lun.ua/realty/4727172962",
    domriaUrl:
      "https://dom.ria.com/uk/realty-dolgosrochnaya-arenda-kvartira-lvov-paseki-hlebnaya-ulitsa-33009485.html",
  },
] as const;

type FetchTrace = { url: string; status: number };

function domriaUrls(html: string): string[] {
  const found = new Set<string>();
  const pattern = /https?:\\?\/\\?\/(?:www\.)?dom\.ria\.com\\?\/[^"'\\\s<>]+/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[0].replace(/\\\//g, "/");
    const target = canonicalDomriaDetailTarget(raw);
    if (target) {
      found.add(target.url);
    }
  }
  return [...found];
}

async function publicGet(url: string): Promise<{ status: number; url: string; bodyText: string }> {
  const response = await httpGet(url, {
    timeoutMs: 20_000,
    maxRetries: 0,
    retryOn: () => false,
  });
  return { status: response.status, url: response.url, bodyText: response.bodyText };
}

async function verifyDomria(domriaUrl: string) {
  const target = canonicalDomriaDetailTarget(domriaUrl);
  const trace: FetchTrace[] = [];
  if (!target) {
    return { extractedId: null, trace, listing: undefined, failure: "url_not_exact" as const };
  }
  const loaded = await loadDomriaExactListing(
    target.id,
    async (url) => {
      const response = await publicGet(url);
      trace.push({ url: response.url, status: response.status });
      return response;
    },
    extractInitialStateJson,
    new Date(),
  );
  if (!loaded.ok) {
    return {
      extractedId: target.id,
      trace,
      listing: undefined,
      failure: loaded.parserFailure ? ("parser_failure" as const) : ("transport_failure" as const),
      status: loaded.status ?? null,
    };
  }
  const rejection = sellerRejectionReason(loaded.listing);
  return {
    extractedId: target.id,
    trace,
    failure: null,
    sellerType: loaded.listing.sellerType,
    sellerEvidence: loaded.listing.sellerEvidence ?? [],
    rejection: rejection ?? null,
    expectedDecision: rejection ? "reject_lun_terminal" : "allow_lun",
  };
}

async function oneExample(example: (typeof EXAMPLES)[number]) {
  let lunStatus = 0;
  let lunFinalUrl: string = example.lunUrl;
  let extracted: string[];
  try {
    const page = await publicGet(example.lunUrl);
    lunStatus = page.status;
    lunFinalUrl = page.url;
    extracted = page.status === 200 ? domriaUrls(page.bodyText) : [];
  } catch (error) {
    return {
      lunId: example.lunId,
      lunUrl: example.lunUrl,
      lunStatus,
      lunFinalUrl,
      disappeared: true,
      error: error instanceof Error ? error.message : "lun_fetch_failed",
    };
  }
  const expected = canonicalDomriaDetailTarget(example.domriaUrl);
  const pageHasExactKnownLink = Boolean(
    expected && extracted.some((url) => url.endsWith(`-${expected.id}.html`)),
  );
  const detail = await verifyDomria(example.domriaUrl);
  return {
    lunId: example.lunId,
    lunUrl: example.lunUrl,
    lunStatus,
    lunFinalUrl,
    disappeared: lunStatus === 404 || lunStatus === 410 || !pageHasExactKnownLink,
    pageHasExactKnownLink,
    extractedDomriaUrls: extracted,
    detail,
  };
}

async function fallbackFromCatalog() {
  const page = await publicGet("https://lun.ua/rent/lviv/flats");
  const inspection = inspectLunHtml(page.bodyText);
  const linked = inspection.listings
    .map((listing) => {
      const raw =
        typeof listing.metadata?.originalUrl === "string"
          ? listing.metadata.originalUrl
          : undefined;
      const target = canonicalDomriaDetailTarget(raw);
      return target
        ? { lunId: listing.sourceId, lunUrl: listing.url, domriaUrl: target.url, id: target.id }
        : undefined;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const first = linked[0];
  if (!first) {
    return { catalogStatus: page.status, exactDomriaLinks: 0, sample: null };
  }
  const detail = await verifyDomria(first.domriaUrl);
  return {
    catalogStatus: page.status,
    exactDomriaLinks: linked.length,
    sample: { ...first, detail },
  };
}

const examples = [];
for (const example of EXAMPLES) {
  examples.push(await oneExample(example));
}
const needsCurrentExample = examples.some((item) => item.disappeared || item.detail?.failure);
const report = {
  checkedAt: new Date().toISOString(),
  examples,
  ...(needsCurrentExample ? { fallback: await fallbackFromCatalog() } : {}),
};
console.log(JSON.stringify(report, null, 2));
