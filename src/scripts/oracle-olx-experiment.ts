import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { Listing } from "../domain/listing.ts";
import type { SourceFetchResult } from "../domain/source.ts";
import { classifyOlxExperimentCategory } from "../probe/olx-experiment-classify.ts";
import { OlxSource } from "../sources/olx/olx.source.ts";

loadDotenv();

/**
 * Hosted OLX feasibility experiment (Oracle Always Free VM or any Node 22 host).
 * Reports apartments and houses separately. Writes JSON evidence after each cycle.
 * Does not send Telegram, touch SQLite, or install a browser.
 *
 * Env:
 *   OLX_EXPERIMENT_CYCLES      default 1 (use 3 on the VM after first PASS)
 *   OLX_EXPERIMENT_INTERVAL_MS default 600000 (10 minutes)
 *   OLX_EXPERIMENT_OUT_DIR     default evidence/phase-1/oracle-olx
 *   OLX_EXPERIMENT_LIMIT       default 10
 */

const cycles = Math.max(1, Number(process.env.OLX_EXPERIMENT_CYCLES ?? "1"));
const intervalMs = Math.max(0, Number(process.env.OLX_EXPERIMENT_INTERVAL_MS ?? String(10 * 60_000)));
const outDir = process.env.OLX_EXPERIMENT_OUT_DIR ?? "evidence/phase-1/oracle-olx";
const limit = Math.max(1, Number(process.env.OLX_EXPERIMENT_LIMIT ?? "10"));

type CategorySummary = {
  category: "apartments" | "houses";
  resultKind: string;
  httpStatus?: number;
  contentType?: string;
  blocked: boolean;
  healthy: boolean;
  extracted: number;
  elapsedMs: number;
  sellerTypes: Record<string, number>;
  propertyTypes: Record<string, number>;
  cities: string[];
  withCoordinates: number;
  sampleIds: string[];
  sampleCities: string[];
  privateAccountEvidenceCount: number;
  notes: string[];
  success: boolean;
  failureReason?: string;
};

function sanitizeNotes(notes: string[]): string[] {
  return notes.map((note) =>
    note
      .replace(/api_key=[^&\s]+/gi, "api_key=redacted")
      .replace(/Body starts:[\s\S]{0,180}/g, "Body starts: [redacted]")
      .slice(0, 240),
  );
}

function contentTypeFromNotes(notes: string[]): string | undefined {
  const jsonHit = notes.find((note) => /-> 200 /.test(note) && /content-type=application\/json/i.test(note));
  const match = (jsonHit ?? notes.join("\n")).match(/content-type=([^;]+)/i);
  return match?.[1]?.trim();
}

function tally(listings: Listing[]) {
  const sellerTypes: Record<string, number> = {};
  const propertyTypes: Record<string, number> = {};
  const cities = new Set<string>();
  let withCoordinates = 0;
  let privateAccountEvidenceCount = 0;
  for (const listing of listings) {
    sellerTypes[listing.sellerType] = (sellerTypes[listing.sellerType] ?? 0) + 1;
    propertyTypes[listing.propertyType] = (propertyTypes[listing.propertyType] ?? 0) + 1;
    if (listing.location.city) {
      cities.add(listing.location.city);
    }
    if (listing.location.latitude !== undefined && listing.location.longitude !== undefined) {
      withCoordinates += 1;
    }
    if (listing.sellerEvidence?.some((item) => /private account/i.test(item))) {
      privateAccountEvidenceCount += 1;
    }
  }
  return {
    sellerTypes,
    propertyTypes,
    cities: [...cities],
    withCoordinates,
    privateAccountEvidenceCount,
  };
}

function summarize(
  category: "apartments" | "houses",
  result: SourceFetchResult,
): CategorySummary {
  const notes = result.rawNotes ?? [];
  const kind = result.resultKind ?? result.health.resultKind ?? "unknown";
  const tallied = tally(result.listings);
  const sample = result.listings.slice(0, 5);
  const contentType = contentTypeFromNotes(notes);
  const classification = classifyOlxExperimentCategory({
    notes,
    resultKind: kind,
    listingCount: result.listings.length,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
  });

  return {
    category,
    resultKind: kind,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    blocked: classification.blocked,
    healthy: result.health.healthy,
    extracted: result.listings.length,
    elapsedMs: result.health.latencyMs ?? 0,
    ...tallied,
    sampleIds: sample.map((item) => item.sourceId),
    sampleCities: sample.map((item) => item.location.city ?? item.location.raw).filter(Boolean),
    notes: sanitizeNotes(notes),
    success: classification.success,
    ...(classification.failureReason !== undefined ? { failureReason: classification.failureReason } : {}),
  };
}

async function runCategory(
  source: OlxSource,
  category: "apartments" | "houses",
): Promise<CategorySummary> {
  const result = await source.inspectLatest({
    limit,
    includeApartments: category === "apartments",
    includeHouses: category === "houses",
  });
  return summarize(category, result);
}

function memorySnapshot() {
  const mem = process.memoryUsage();
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    externalBytes: mem.external,
  };
}

mkdirSync(outDir, { recursive: true });
const source = new OlxSource();
let exitFail = false;

console.log(
  JSON.stringify({
    message: "oracle-olx-experiment.start",
    cycles,
    intervalMs,
    outDir,
    limit,
    node: process.version,
    commitHint: "run from intended git checkout",
    startedAt: new Date().toISOString(),
  }),
);

for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const cycleStarted = Date.now();
  const beforeMem = memorySnapshot();
  const apartments = await runCategory(source, "apartments");
  if (apartments.blocked) {
    console.error("Apartments blocked (403/429). Stopping further apartment hammering and houses may still be tried once.");
  }
  const houses = await runCategory(source, "houses");
  if (houses.blocked) {
    console.error("Houses blocked (403/429). Stopping further cycles.");
  }
  const afterMem = memorySnapshot();
  const report = {
    experiment: "oracle-always-free-olx",
    cycle,
    capturedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      elapsedMs: Date.now() - cycleStarted,
      memoryBefore: beforeMem,
      memoryAfter: afterMem,
      peakRssBytesApprox: Math.max(beforeMem.rssBytes, afterMem.rssBytes),
    },
    apartments,
    houses,
    overallSuccess: apartments.success && houses.success,
  };
  const path = join(outDir, `cycle-${cycle}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ message: "oracle-olx-experiment.cycle", path, ...report }, null, 2));

  if (!apartments.success || !houses.success) {
    exitFail = true;
  }
  if (apartments.blocked && houses.blocked) {
    break;
  }
  if (cycle < cycles && apartments.success && houses.success) {
    console.log(`sleeping ${intervalMs} ms before cycle ${cycle + 1}`);
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  } else if (cycle < cycles && (!apartments.success || !houses.success)) {
    console.log("Skipping remaining cycles because a category did not return valid relevant listings.");
    break;
  }
}

console.log(
  JSON.stringify({
    message: "oracle-olx-experiment.done",
    finishedAt: new Date().toISOString(),
    exitFail,
    note: "Three successful cycles = preliminary hosted access only; not multi-day reliability.",
  }),
);
process.exitCode = exitFail ? 1 : 0;
