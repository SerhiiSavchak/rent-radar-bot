/**
 * Source-layer live evidence: LUN pagination / deeper catalog discovery.
 * Not production. Writes sanitized JSON under EVIDENCE_DIR.
 *
 * Explores candidate page URLs and RSC/HTML markers for next-page links.
 * PASS = distinct listing ids on page2 vs page1 across ≥3 cycles with parse ok.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpGet } from "../utils/http.ts";
import { inspectLunHtml } from "../sources/lun/lun.parser.ts";

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR?.trim() ||
  join(process.cwd(), "evidence", "source-layer-live", "lun-pagination");
const CYCLES = Math.max(1, Number(process.env.LIVE_PROBE_CYCLES ?? "3") || 3);
const FLATS = "https://lun.ua/rent/lviv/flats";

const CANDIDATES = [
  { label: "page1", url: FLATS },
  { label: "page2_query", url: `${FLATS}?page=2` },
  { label: "page2_path", url: `${FLATS}/page/2` },
  { label: "offset24", url: `${FLATS}?offset=24` },
  { label: "page2_uk", url: "https://lun.ua/uk/rent/lviv/flats?page=2" },
];

function extractNextHints(html: string): string[] {
  const hints: string[] = [];
  const patterns = [
    /rel=["']next["'][^>]*href=["']([^"']+)/gi,
    /href=["']([^"']*page[=/]2[^"']*)["']/gi,
    /"page"\s*:\s*2/g,
    /"nextPage"\s*:\s*"([^"]+)"/gi,
    /"hasNextPage"\s*:\s*true/gi,
    /cursor[=:]["']?([A-Za-z0-9_-]{8,})/gi,
  ];
  for (const re of patterns) {
    const copy = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = copy.exec(html)) !== null) {
      hints.push(m[1] ? `${re.source.slice(0, 24)}→${m[1].slice(0, 80)}` : re.source.slice(0, 40));
      if (hints.length >= 12) return hints;
    }
  }
  return hints;
}

async function sample(label: string, url: string) {
  const response = await httpGet(url, {
    timeoutMs: 25_000,
    maxRetries: 0,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "uk-UA,uk;q=0.9",
    },
  });
  const inspection = inspectLunHtml(response.bodyText);
  const ids = inspection.listings.map((l) => l.sourceId).filter(Boolean);
  return {
    label,
    url,
    status: response.status,
    finalUrl: response.url,
    resultKind: inspection.resultKind,
    rawCardCount: inspection.rawCardCount,
    validatedCardCount: inspection.validatedCardCount,
    ids,
    idSample: ids.slice(0, 8),
    idCount: ids.length,
    nextHints: extractNextHints(response.bodyText),
    bodyMarker:
      response.bodyText.includes("__next_f") || response.bodyText.includes("self.__next_f")
        ? "next_rsc"
        : "other",
  };
}

async function oneCycle(cycle: number) {
  const rows = [];
  for (const c of CANDIDATES) {
    rows.push(await sample(c.label, c.url));
    await new Promise((r) => setTimeout(r, 700));
  }
  const page1 = rows.find((r) => r.label === "page1");
  const deeper = rows.filter((r) => r.label !== "page1");
  const page1Ids = new Set(page1?.ids ?? []);
  const distinctDeeper = deeper.map((r) => {
    const novel = (r.ids ?? []).filter((id) => !page1Ids.has(id));
    return {
      label: r.label,
      status: r.status,
      validatedCardCount: r.validatedCardCount,
      novelIdCount: novel.length,
      novelIds: novel.slice(0, 5),
      sameAsPage1:
        r.idCount > 0 &&
        r.ids.every((id) => page1Ids.has(id)) &&
        r.idCount === (page1?.idCount ?? -1),
    };
  });
  const paginationWorks = distinctDeeper.some(
    (d) => d.status === 200 && d.validatedCardCount > 0 && d.novelIdCount >= 3,
  );
  return {
    cycle,
    at: new Date().toISOString(),
    page1: page1
      ? {
          status: page1.status,
          validatedCardCount: page1.validatedCardCount,
          idCount: page1.idCount,
          nextHints: page1.nextHints,
        }
      : null,
    candidates: distinctDeeper,
    rows: rows.map((r) => ({
      label: r.label,
      status: r.status,
      resultKind: r.resultKind,
      validatedCardCount: r.validatedCardCount,
      nextHints: r.nextHints,
    })),
    verdict: {
      paginationListingEvidence: paginationWorks,
      status: paginationWorks ? "PASS" : "BLOCKED_OR_UNSUPPORTED",
    },
  };
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const cycles = [];
  for (let i = 1; i <= CYCLES; i += 1) {
    console.error(`lun-pagination cycle ${i}/${CYCLES}`);
    cycles.push(await oneCycle(i));
    if (i < CYCLES) await new Promise((r) => setTimeout(r, 1_500));
  }
  const pass = cycles.every((c) => c.verdict.paginationListingEvidence);
  const summary = {
    probe: "lun-pagination",
    commit: process.env.RENT_RADAR_COMMIT ?? "unknown",
    cycles: CYCLES,
    paginationStatus: pass ? "PASS" : "BLOCKED_OR_UNSUPPORTED",
    note: "PASS = live ?page=2 returns novel ids vs page1 (≥3 cycles). Adapter LUN_POLL_PAGE_BUDGET=2 uses buildLunCategoryPageUrl.",
    cyclesDetail: cycles,
  };
  const out = join(EVIDENCE_DIR, `summary-${Date.now()}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({ written: out, paginationStatus: summary.paginationStatus }, null, 2),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
