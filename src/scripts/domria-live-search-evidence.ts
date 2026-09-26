/**
 * Source-layer live evidence: DIM.RIA searchEngine + historical-failure diagnostics.
 * Not production. Repeated cycles; classifies body shape; does NOT claim historical PF resolved.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpGet } from "../utils/http.ts";
import {
  buildDomriaNewestSearchUrl,
  classifyDomriaSearchBody,
  parseDomriaSearchIds,
} from "../sources/domria/domria-newest.ts";

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR?.trim() ||
  join(process.cwd(), "evidence", "source-layer-live", "domria-search");
const CYCLES = Math.max(1, Number(process.env.LIVE_PROBE_CYCLES ?? "3") || 3);

async function oneCycle(cycle: number) {
  const apartmentUrl = buildDomriaNewestSearchUrl("apartment");
  const houseUrl = buildDomriaNewestSearchUrl("house");
  const page1Url = apartmentUrl.replace(/([?&])page=0/, "$1page=1");
  const samples = [];
  for (const [label, url] of [
    ["apartment_p0", apartmentUrl],
    ["house_p0", houseUrl],
    ["apartment_p1", page1Url],
  ] as const) {
    const response = await httpGet(url, {
      timeoutMs: 20_000,
      maxRetries: 0,
      headers: { Accept: "application/json", "user-agent": "Mozilla/5.0" },
    });
    const bodyClass = classifyDomriaSearchBody(response.bodyText);
    const parsed = parseDomriaSearchIds(response.bodyText);
    samples.push({
      label,
      status: response.status,
      contentType: response.headers["content-type"] ?? null,
      bodyKind: bodyClass.kind,
      bodyPreview: bodyClass.preview,
      parseOk: parsed.ok,
      ...(parsed.ok
        ? { idCount: parsed.ids.length, empty: parsed.empty === true }
        : { reason: parsed.reason }),
      // Bounded diagnostic for recurrence — not a historical root cause claim.
      diagnosticHint:
        bodyClass.kind === "html"
          ? "searchEngine returned HTML (challenge/interstitial/error page) — not catalog JSON"
          : bodyClass.kind === "json_missing_items"
            ? "JSON without items array — structural parser_failure class"
            : bodyClass.kind === "json_ok"
              ? "catalog JSON with items"
              : bodyClass.kind,
    });
    await new Promise((r) => setTimeout(r, 600));
  }
  const apt = samples.find((s) => s.label === "apartment_p0");
  const liveOk = apt?.status === 200 && apt.parseOk === true && apt.bodyKind === "json_ok";
  return {
    cycle,
    at: new Date().toISOString(),
    samples,
    verdict: {
      currentLiveSearchOk: Boolean(liveOk),
      // Explicit: repeated current success does not resolve Sep 25 historical PF.
      historicalParserFailureResolved: false,
      historicalNote:
        "Evidence for Sep 25 underlying failure was not retained; current OK cycles must not be labeled as historical resolution.",
    },
  };
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const cycles = [];
  for (let i = 1; i <= CYCLES; i += 1) {
    console.error(`domria-search cycle ${i}/${CYCLES}`);
    cycles.push(await oneCycle(i));
    if (i < CYCLES) await new Promise((r) => setTimeout(r, 1_000));
  }
  const currentPass = cycles.every((c) => c.verdict.currentLiveSearchOk);
  const summary = {
    probe: "domria-searchengine-repeated",
    commit: process.env.RENT_RADAR_COMMIT ?? "unknown",
    cycles: CYCLES,
    currentLiveStatus: currentPass ? "PASS_CURRENT" : "FAIL_CURRENT",
    historicalStatus: "UNRESOLVED",
    note: "PASS_CURRENT is only about repeated live searchEngine JSON now. Historical Sep 25 cause remains UNRESOLVED.",
    cyclesDetail: cycles,
  };
  const out = join(EVIDENCE_DIR, `summary-${Date.now()}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        written: out,
        currentLiveStatus: summary.currentLiveStatus,
        historicalStatus: summary.historicalStatus,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
