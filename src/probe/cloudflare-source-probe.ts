import type { FetchResultKind } from "../domain/source.ts";
import { OlxSource } from "../sources/olx/olx.source.ts";
import { runAllFixtureParses, type FixtureParseResult } from "./fixtures.ts";

export type ProbeTransportNote = {
  httpStatus?: number;
  contentType?: string;
  bytes?: number;
  elapsedMs: number;
  cpuMs: number | null;
  cpuMsSource: "not_available_in_handler" | "workers_invocation_log";
};

export type LiveSourceProbeResult = {
  source: string;
  mode: "live-olx";
  resultKind?: FetchResultKind;
  httpStatus?: number;
  contentType?: string | undefined;
  bytes?: number;
  elapsedMs: number;
  cpuMs: null;
  cpuMsNote: string;
  extracted: number;
  accepted: number;
  sellerTypes: Record<string, number>;
  cities: string[];
  propertyTypes: Record<string, number>;
  withCoordinates: number;
  blocked: boolean;
  notes: string[];
};

export type ProbeReport = {
  generatedAt: string;
  runtime: "local-node" | "cloudflare-workers";
  cpuWarning: string;
  fixtures: FixtureParseResult[];
  liveOlx?: LiveSourceProbeResult;
};

const CPU_WARNING =
  "elapsedMs is wall time on this runtime. It is NOT Cloudflare production CPU time. Waiting on fetch does not count as Workers CPU; parsing HTML/JSON does.";

export function runFixtureProbe(runtime: ProbeReport["runtime"] = "local-node"): ProbeReport {
  return {
    generatedAt: new Date().toISOString(),
    runtime,
    cpuWarning: CPU_WARNING,
    fixtures: runAllFixtureParses(),
  };
}

export async function runLiveOlxProbe(): Promise<LiveSourceProbeResult> {
  const started = Date.now();
  const source = new OlxSource();
  const result = await source.inspectLatest({ limit: 10, includeApartments: true, includeHouses: true });
  const sellerTypes: Record<string, number> = {};
  const propertyTypes: Record<string, number> = {};
  const cities = new Set<string>();
  let withCoordinates = 0;
  for (const listing of result.listings) {
    sellerTypes[listing.sellerType] = (sellerTypes[listing.sellerType] ?? 0) + 1;
    propertyTypes[listing.propertyType] = (propertyTypes[listing.propertyType] ?? 0) + 1;
    if (listing.location.city) {
      cities.add(listing.location.city);
    }
    if (listing.location.latitude !== undefined && listing.location.longitude !== undefined) {
      withCoordinates += 1;
    }
  }
  const status = result.httpStatus;
  const blocked = status === 403 || status === 429;
  const contentType = contentTypeFromNotes(result.rawNotes ?? []);
  const resultKind = result.resultKind ?? result.health.resultKind;
  return {
    source: "olx",
    mode: "live-olx",
    ...(resultKind !== undefined ? { resultKind } : {}),
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    elapsedMs: Date.now() - started,
    cpuMs: null,
    cpuMsNote:
      "Workers CPU time is not exposed to the handler. On a hosted deploy, read cpuTime from wrangler tail / Workers Logs. Local elapsedMs is wall time.",
    extracted: result.listings.length,
    accepted: result.listings.length,
    sellerTypes,
    cities: [...cities],
    propertyTypes,
    withCoordinates,
    blocked,
    notes: sanitizeNotes(result.rawNotes ?? []),
  };
}

function contentTypeFromNotes(notes: string[]): string | undefined {
  const jsonHit = notes.find((note) => /-> 200 /.test(note) && /content-type=application\/json/i.test(note));
  const match = (jsonHit ?? notes.join("\n")).match(/content-type=([^;]+)/i);
  return match?.[1]?.trim();
}

function sanitizeNotes(notes: string[]): string[] {
  return notes.map((note) =>
    note
      .replace(/api_key=[^&\s]+/gi, "api_key=redacted")
      .replace(/Body starts:[\s\S]{0,180}/g, "Body starts: [redacted]"),
  );
}
