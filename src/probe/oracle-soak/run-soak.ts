import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceFetchResult } from "../../domain/source.ts";
import type { OlxBrowserProbeResult } from "../olx-browser-probe.ts";
import {
  buildPerSourceSuccessRate,
  buildSummaryNote,
  classifyCycleStatus,
  classifyHttpAdapterResult,
  decideSoakVerdict,
  maxFailureStreaks,
} from "./classify.ts";
import { defaultSleep, runSoakScheduler } from "./scheduler.ts";
import { sanitizeSoakNotes, sanitizeSoakText } from "./sanitize.ts";
import type {
  SoakCycleReport,
  SoakMemorySnapshot,
  SoakSourceResult,
  SoakSummary,
} from "./types.ts";
import { soakCycleReportSchema, soakSummarySchema } from "./types.ts";

export type SoakConfig = {
  cycles: number;
  intervalMs: number;
  outDir: string;
  sourceTimeoutMs: number;
  browserTimeoutMs: number;
  browserCrashLimit: number;
  commit: string;
};

export type SoakSourceAdapters = {
  inspectDomria: () => Promise<SourceFetchResult>;
  inspectLun: () => Promise<SourceFetchResult>;
  inspectRieltorOwners: () => Promise<SourceFetchResult>;
  inspectOlxHttp: () => Promise<SourceFetchResult>;
  probeOlxBrowser: () => Promise<OlxBrowserProbeResult>;
};

export type SoakRuntimeDeps = {
  now: () => Date;
  memory: () => SoakMemorySnapshot;
  sleep: (ms: number) => Promise<void>;
  writeJson: (path: string, data: unknown) => void;
  mkdirp: (dir: string) => void;
  onSignal?: (handler: () => void) => () => void;
};

function memFromProcess(): SoakMemorySnapshot {
  const mem = process.memoryUsage();
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    externalBytes: mem.external,
  };
}

function mapRequiredHttp(
  source: "domria" | "lun" | "rieltor",
  result: SourceFetchResult,
  elapsedMs: number,
): SoakSourceResult {
  const extractedCount = result.listings.length;
  const kind = result.resultKind ?? result.health.resultKind ?? "unknown";
  let classification = classifyHttpAdapterResult({
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    resultKind: kind,
    extractedCount,
  }).classification;

  if (kind === "parser_failure") {
    classification = "parser_failure";
  }

  const success =
    kind === "parser_failure"
      ? false
      : (kind === "ok" && extractedCount > 0) || kind === "valid_empty";

  const notes = result.rawNotes ? sanitizeSoakNotes(result.rawNotes) : undefined;
  // Only attach errorSafe for real failures — not success health messages misclassified via missing resultKind.
  const errorSafe =
    !success && result.health.message && !/^DIM\.RIA returned \d+ listings/i.test(result.health.message)
      ? sanitizeSoakText(result.health.message)
      : !success && kind === "unknown" && extractedCount > 0
        ? sanitizeSoakText(
            `missing resultKind with ${extractedCount} listings (adapter must set resultKind=ok|valid_empty|…)`,
          )
        : !success && result.health.message
          ? sanitizeSoakText(result.health.message)
          : undefined;

  return {
    source,
    required: true,
    success,
    transport: result.transport,
    classification: success ? (kind === "valid_empty" ? "valid_empty" : "ok") : classification,
    resultKind: kind,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    extractedCount,
    elapsedMs,
    ...(errorSafe !== undefined ? { errorSafe } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

function mapOlxHttpDiagnostic(result: SourceFetchResult, elapsedMs: number): SoakSourceResult {
  const kind = result.resultKind ?? "http_error";
  const classification =
    result.httpStatus === 403 || result.httpStatus === 429
      ? "transport_blocked"
      : kind === "parser_failure"
        ? "parser_failure"
        : classifyHttpAdapterResult({
            ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
            resultKind: kind,
            extractedCount: result.listings.length,
          }).classification;

  const notes = sanitizeSoakNotes([
    ...(result.rawNotes ?? []).slice(0, 4),
    "olx_http is diagnostic-only; not a soak success path",
  ]);

  return {
    source: "olx_http",
    required: false,
    success: false,
    transport: result.transport,
    classification,
    resultKind: kind,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    extractedCount: result.listings.length,
    elapsedMs,
    ...(notes !== undefined ? { notes } : {}),
  };
}

function mapOlxBrowser(result: OlxBrowserProbeResult, elapsedMs: number): SoakSourceResult {
  const success = result.overallSuccess;
  const classification = success
    ? "browser_accessible"
    : result.apartments.outcome === "transport_blocked" || result.houses.outcome === "transport_blocked"
      ? "transport_blocked"
      : result.apartments.outcome === "challenge_detected" || result.houses.outcome === "challenge_detected"
        ? "challenge_detected"
        : "parser_failure";

  const notes = sanitizeSoakNotes([
    `apartments:${result.apartments.outcome}`,
    `houses:${result.houses.outcome}`,
    `browserClosed=${result.browserClosed}`,
    ...result.apartments.notes.slice(0, 2),
    ...result.houses.notes.slice(0, 2),
  ]);

  return {
    source: "olx_browser",
    required: true,
    success,
    transport: "playwright-chromium",
    classification,
    resultKind: classification,
    extractedCount: (result.apartments.success ? 1 : 0) + (result.houses.success ? 1 : 0),
    elapsedMs,
    ...(notes !== undefined ? { notes } : {}),
    ...(!success
      ? {
          errorSafe: sanitizeSoakText(
            `apartments=${result.apartments.outcome}; houses=${result.houses.outcome}`,
          ),
        }
      : {}),
  };
}

async function safeInspect(
  label: string,
  fn: () => Promise<SourceFetchResult>,
): Promise<
  { ok: true; result: SourceFetchResult; elapsedMs: number } | { ok: false; errorSafe: string; elapsedMs: number }
> {
  const started = Date.now();
  try {
    const result = await fn();
    return { ok: true, result, elapsedMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      errorSafe: sanitizeSoakText(`${label}: ${error instanceof Error ? error.message : String(error)}`),
      elapsedMs: Date.now() - started,
    };
  }
}

function failedSource(
  source: SoakSourceResult["source"],
  required: boolean,
  elapsedMs: number,
  errorSafe: string,
  classification = "http_error",
): SoakSourceResult {
  return {
    source,
    required,
    success: false,
    transport: source === "olx_browser" ? "playwright-chromium" : "http",
    classification,
    extractedCount: 0,
    elapsedMs,
    errorSafe,
  };
}

export async function runOracleSoak(options: {
  config: SoakConfig;
  adapters: SoakSourceAdapters;
  runtime?: Partial<SoakRuntimeDeps>;
}): Promise<{ summary: SoakSummary; cycles: SoakCycleReport[] }> {
  const runtime: SoakRuntimeDeps = {
    now: options.runtime?.now ?? (() => new Date()),
    memory: options.runtime?.memory ?? memFromProcess,
    sleep: options.runtime?.sleep ?? defaultSleep,
    writeJson:
      options.runtime?.writeJson ??
      ((path, data) => {
        writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
      }),
    mkdirp: options.runtime?.mkdirp ?? ((dir) => mkdirSync(dir, { recursive: true })),
    ...(options.runtime?.onSignal ? { onSignal: options.runtime.onSignal } : {}),
  };

  runtime.mkdirp(options.config.outDir);

  let stopRequested = false;
  let abortedBySignal = false;
  const detachSignals: Array<() => void> = [];

  const requestStop = () => {
    stopRequested = true;
    abortedBySignal = true;
  };

  if (runtime.onSignal) {
    detachSignals.push(runtime.onSignal(requestStop));
  } else if (typeof process !== "undefined" && typeof process.on === "function") {
    const handler = () => requestStop();
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    detachSignals.push(() => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    });
  }

  const cycles: SoakCycleReport[] = [];
  let browserCrashStreak = 0;
  let fatalStop = false;
  let fatalReason: string | undefined;
  const soakStarted = runtime.now();

  try {
    const sched = await runSoakScheduler({
      cycles: options.config.cycles,
      intervalMs: options.config.intervalMs,
      sleep: runtime.sleep,
      shouldStop: () => stopRequested,
      runCycle: async (cycle) => {
        const startedAt = runtime.now();
        const memoryBefore = runtime.memory();
        const sources: SoakSourceResult[] = [];

        const domria = await safeInspect("domria", options.adapters.inspectDomria);
        sources.push(
          domria.ok
            ? mapRequiredHttp("domria", domria.result, domria.elapsedMs)
            : failedSource("domria", true, domria.elapsedMs, domria.errorSafe),
        );

        const lun = await safeInspect("lun", options.adapters.inspectLun);
        sources.push(
          lun.ok
            ? mapRequiredHttp("lun", lun.result, lun.elapsedMs)
            : failedSource("lun", true, lun.elapsedMs, lun.errorSafe),
        );

        const rieltor = await safeInspect("rieltor", options.adapters.inspectRieltorOwners);
        sources.push(
          rieltor.ok
            ? mapRequiredHttp("rieltor", rieltor.result, rieltor.elapsedMs)
            : failedSource("rieltor", true, rieltor.elapsedMs, rieltor.errorSafe),
        );

        const olxHttp = await safeInspect("olx_http", options.adapters.inspectOlxHttp);
        sources.push(
          olxHttp.ok
            ? mapOlxHttpDiagnostic(olxHttp.result, olxHttp.elapsedMs)
            : {
                ...failedSource("olx_http", false, olxHttp.elapsedMs, olxHttp.errorSafe, "transport_blocked"),
                notes: ["olx_http diagnostic failed to run"],
              },
        );

        const browserStarted = Date.now();
        try {
          const browserResult = await options.adapters.probeOlxBrowser();
          sources.push(mapOlxBrowser(browserResult, Date.now() - browserStarted));
          if (!browserResult.browserClosed) {
            browserCrashStreak += 1;
          } else {
            browserCrashStreak = 0;
          }
        } catch (error) {
          browserCrashStreak += 1;
          sources.push(
            failedSource(
              "olx_browser",
              true,
              Date.now() - browserStarted,
              sanitizeSoakText(`browser crash/error: ${error instanceof Error ? error.message : String(error)}`),
            ),
          );
        }

        const endedAt = runtime.now();
        const memoryAfter = runtime.memory();
        const status = classifyCycleStatus(sources);
        const report: SoakCycleReport = {
          experiment: "oracle-soak",
          cycle,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          status,
          elapsedMs: endedAt.getTime() - startedAt.getTime(),
          memoryBefore,
          memoryAfter,
          sources,
        };

        const parsed = soakCycleReportSchema.safeParse(report);
        if (!parsed.success) {
          fatalStop = true;
          fatalReason = "cycle_evidence_schema_invalid";
          report.fatal = true;
          report.fatalReason = fatalReason;
        }

        cycles.push(report);
        runtime.writeJson(join(options.config.outDir, `cycle-${cycle}.json`), report);

        if (browserCrashStreak >= options.config.browserCrashLimit) {
          fatalStop = true;
          fatalReason = `repeated_browser_crashes:${browserCrashStreak}`;
          return { stopFatal: true as const, stopReason: fatalReason };
        }
        if (fatalStop) {
          return {
            stopFatal: true as const,
            ...(fatalReason !== undefined ? { stopReason: fatalReason } : {}),
          };
        }
        return;
      },
    });

    if (sched.overlapDetected) {
      fatalStop = true;
      fatalReason = "overlapping_cycle_guard";
    }

    const soakEnded = runtime.now();
    const verdict = decideSoakVerdict({
      cycles,
      cyclesRequested: options.config.cycles,
      stoppedEarly: sched.stoppedEarly || fatalStop,
      abortedBySignal,
      fatalStop,
    });

    const summary: SoakSummary = {
      experiment: "oracle-soak",
      startedAt: soakStarted.toISOString(),
      endedAt: soakEnded.toISOString(),
      commit: options.config.commit,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        totalElapsedMs: soakEnded.getTime() - soakStarted.getTime(),
      },
      config: {
        cyclesRequested: options.config.cycles,
        intervalMs: options.config.intervalMs,
        outDir: options.config.outDir,
      },
      totals: {
        cyclesAttempted: cycles.length,
        complete: cycles.filter((c) => c.status === "complete").length,
        degraded: cycles.filter((c) => c.status === "degraded").length,
        failed: cycles.filter((c) => c.status === "failed").length,
      },
      perSourceSuccessRate: buildPerSourceSuccessRate(cycles),
      repeatedFailureStreaks: maxFailureStreaks(cycles),
      maxRssBytes: Math.max(
        0,
        ...cycles.flatMap((c) => [c.memoryBefore.rssBytes, c.memoryAfter.rssBytes]),
      ),
      maxCycleDurationMs: Math.max(0, ...cycles.map((c) => c.elapsedMs)),
      stoppedEarly: sched.stoppedEarly || fatalStop || abortedBySignal,
      ...(fatalReason || sched.stopReason
        ? { stopReason: fatalReason ?? sched.stopReason }
        : {}),
      verdict,
      note: buildSummaryNote(verdict),
    };

    soakSummarySchema.parse(summary);
    runtime.writeJson(join(options.config.outDir, "summary.json"), summary);

    return { summary, cycles };
  } finally {
    for (const detach of detachSignals) {
      detach();
    }
  }
}
