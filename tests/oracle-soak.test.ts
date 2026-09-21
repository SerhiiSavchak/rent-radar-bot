import { describe, expect, it, vi } from "vitest";
import { classifyOlxBrowserProbe } from "../src/probe/olx-browser-classify.ts";
import {
  classifyCycleStatus,
  decideSoakVerdict,
  maxFailureStreaks,
} from "../src/probe/oracle-soak/classify.ts";
import { runOracleSoak } from "../src/probe/oracle-soak/run-soak.ts";
import { runSoakScheduler } from "../src/probe/oracle-soak/scheduler.ts";
import { assertNoSecretMaterial, sanitizeSoakText } from "../src/probe/oracle-soak/sanitize.ts";
import type { SoakCycleReport, SoakSourceResult } from "../src/probe/oracle-soak/types.ts";
import { soakCycleReportSchema, soakSummarySchema } from "../src/probe/oracle-soak/types.ts";
import type { SourceFetchResult } from "../src/domain/source.ts";
import type { OlxBrowserProbeResult } from "../src/probe/olx-browser-probe.ts";

function httpOk(source: "domria" | "lun" | "rieltor" | "olx", count = 2): SourceFetchResult {
  return {
    listings: Array.from({ length: count }, (_, i) => ({
      source: source === "olx" ? "olx" : source,
      sourceId: `${source}-${i}`,
      title: "x",
      url: `https://example.test/${source}/${i}`,
      propertyType: "apartment" as const,
      sellerType: "unknown" as const,
      location: { raw: "Львів" },
      discoveredAt: new Date("2026-09-17T00:00:00.000Z"),
    })),
    transport: "http",
    dataKind: "LIVE DATA",
    resultKind: "ok",
    httpStatus: 200,
    health: {
      source: source === "olx" ? "olx" : source,
      healthy: true,
      checkedAt: new Date(),
      resultKind: "ok",
      httpStatus: 200,
      transport: "http",
    },
  };
}

function httpBlockedOlx(): SourceFetchResult {
  return {
    listings: [],
    transport: "public JSON API api/v1/offers",
    dataKind: "LIVE DATA",
    resultKind: "http_error",
    httpStatus: 403,
    rawNotes: [
      "https://www.olx.ua/api/v1/offers/?x=1 -> 403 content-type=text/html; server=CloudFront",
      "api_key=supersecretvalue should be redacted",
    ],
    health: {
      source: "olx",
      healthy: false,
      checkedAt: new Date(),
      resultKind: "http_error",
      httpStatus: 403,
      transport: "public JSON API api/v1/offers",
      message: "OLX CloudFront/WAF returned 403",
    },
  };
}

function browserOk(): OlxBrowserProbeResult {
  return {
    overallSuccess: true,
    browserClosed: true,
    apartments: {
      category: "apartments",
      requestedUrl: "https://www.olx.ua/a",
      finalUrl: "https://www.olx.ua/a",
      httpStatus: 200,
      title: "apt",
      bodyChars: 10,
      bodySample: "x",
      outcome: "browser_accessible",
      success: true,
      challengeIndicators: [],
      listingSignals: ["data_cy_l_card"],
      notes: ["ok"],
      elapsedMs: 5,
    },
    houses: {
      category: "houses",
      requestedUrl: "https://www.olx.ua/h",
      finalUrl: "https://www.olx.ua/h",
      httpStatus: 200,
      title: "house",
      bodyChars: 10,
      bodySample: "x",
      outcome: "browser_accessible",
      success: true,
      challengeIndicators: [],
      listingSignals: ["data_cy_l_card"],
      notes: ["ok"],
      elapsedMs: 5,
    },
  };
}

function source(partial: Partial<SoakSourceResult> & Pick<SoakSourceResult, "source" | "success" | "required">): SoakSourceResult {
  return {
    transport: "http",
    classification: partial.success ? "ok" : "http_error",
    extractedCount: partial.success ? 1 : 0,
    elapsedMs: 1,
    ...partial,
  };
}

describe("soak scheduler", () => {
  it("runs sequential cycles with interval and never overlaps", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const ends: number[] = [];
    let active = 0;
    let maxActive = 0;

    const schedPromise = runSoakScheduler({
      cycles: 3,
      intervalMs: 10_000,
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      shouldStop: () => false,
      runCycle: async (cycle) => {
        starts.push(cycle);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 1000);
        });
        active -= 1;
        ends.push(cycle);
      },
    });

    // cycle1 (1s) + interval(10s) + cycle2 (1s) + interval + cycle3 (1s)
    await vi.runAllTimersAsync();
    const result = await schedPromise;
    expect(result.cyclesAttempted).toBe(3);
    expect(result.overlapDetected).toBe(false);
    expect(maxActive).toBe(1);
    expect(starts).toEqual([1, 2, 3]);
    expect(ends).toEqual([1, 2, 3]);
    vi.useRealTimers();
  });

  it("stops on shouldStop between cycles", async () => {
    vi.useFakeTimers();
    let stop = false;
    const schedPromise = runSoakScheduler({
      cycles: 5,
      intervalMs: 1000,
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      shouldStop: () => stop,
      runCycle: async (cycle) => {
        if (cycle === 1) {
          stop = true;
        }
      },
    });
    await vi.runAllTimersAsync();
    const result = await schedPromise;
    expect(result.cyclesAttempted).toBe(1);
    expect(result.stoppedEarly).toBe(true);
    vi.useRealTimers();
  });
});

describe("soak classification", () => {
  it("marks complete / degraded / failed from required sources", () => {
    expect(
      classifyCycleStatus([
        source({ source: "domria", required: true, success: true }),
        source({ source: "lun", required: true, success: true }),
        source({ source: "rieltor", required: true, success: true }),
        source({ source: "olx_browser", required: true, success: true }),
        source({ source: "olx_http", required: false, success: false, classification: "transport_blocked" }),
      ]),
    ).toBe("complete");

    expect(
      classifyCycleStatus([
        source({ source: "domria", required: true, success: true }),
        source({ source: "lun", required: true, success: false }),
        source({ source: "rieltor", required: true, success: true }),
        source({ source: "olx_browser", required: true, success: true }),
      ]),
    ).toBe("degraded");

    expect(
      classifyCycleStatus([
        source({ source: "domria", required: true, success: false }),
        source({ source: "lun", required: true, success: false }),
        source({ source: "rieltor", required: true, success: false }),
        source({ source: "olx_browser", required: true, success: false }),
      ]),
    ).toBe("failed");
  });

  it("keeps transport_blocked vs parser_failure vs browser_accessible distinct", () => {
    expect(
      classifyOlxBrowserProbe({
        requestedUrl: "u",
        finalUrl: "u",
        httpStatus: 403,
        title: "ERROR",
        bodyText: "Generated by cloudfront",
      }).outcome,
    ).toBe("transport_blocked");
    expect(
      classifyOlxBrowserProbe({
        requestedUrl: "u",
        finalUrl: "u",
        httpStatus: 200,
        title: "OLX",
        bodyText: "<html></html>",
      }).outcome,
    ).toBe("parser_failure");
    expect(
      classifyOlxBrowserProbe({
        requestedUrl: "u",
        finalUrl: "u",
        httpStatus: 200,
        title: "OLX",
        bodyText: '<div data-cy="l-card"><a href="/d/x-ID11gWHG.html">a</a></div>',
      }).outcome,
    ).toBe("browser_accessible");
  });
});

describe("runOracleSoak", () => {
  it("isolates per-source failures and marks cycle degraded", async () => {
    const files = new Map<string, unknown>();
    let clock = 1_000_000;
    const { summary, cycles } = await runOracleSoak({
      config: {
        cycles: 2,
        intervalMs: 0,
        outDir: "evidence/phase-1/oracle-soak-test",
        sourceTimeoutMs: 1000,
        browserTimeoutMs: 1000,
        browserCrashLimit: 3,
        commit: "testcommit",
      },
      adapters: {
        inspectDomria: async () => httpOk("domria"),
        inspectLun: async () => {
          throw new Error("lun down");
        },
        inspectRieltorOwners: async () => httpOk("rieltor"),
        inspectOlxHttp: async () => httpBlockedOlx(),
        probeOlxBrowser: async () => browserOk(),
      },
      runtime: {
        now: () => {
          clock += 1000;
          return new Date(clock);
        },
        memory: () => ({ rssBytes: 100, heapUsedBytes: 50, externalBytes: 1 }),
        sleep: async () => undefined,
        mkdirp: () => undefined,
        writeJson: (path, data) => {
          files.set(path, data);
        },
        onSignal: () => () => undefined,
      },
    });

    expect(cycles).toHaveLength(2);
    expect(cycles[0]?.status).toBe("degraded");
    expect(cycles[0]?.sources.find((s) => s.source === "lun")?.success).toBe(false);
    expect(cycles[0]?.sources.find((s) => s.source === "domria")?.success).toBe(true);
    expect(cycles[0]?.sources.find((s) => s.source === "olx_http")?.classification).toBe("transport_blocked");
    expect(cycles[0]?.sources.find((s) => s.source === "olx_http")?.required).toBe(false);
    expect(cycles[0]?.sources.find((s) => s.source === "olx_browser")?.classification).toBe("browser_accessible");
    expect(summary.verdict).toBe("DEGRADED");
    expect(summary.maxRssBytes).toBe(100);
    expect(summary.maxCycleDurationMs).toBeGreaterThan(0);
    const cycleKey = [...files.keys()].find((k) => k.replace(/\\/g, "/").endsWith("oracle-soak-test/cycle-1.json"));
    const summaryKey = [...files.keys()].find((k) => k.replace(/\\/g, "/").endsWith("oracle-soak-test/summary.json"));
    expect(cycleKey).toBeTruthy();
    expect(summaryKey).toBeTruthy();
    soakCycleReportSchema.parse(cycles[0]);
    soakSummarySchema.parse(summary);
  });

  it("stops fatally after repeated browser crashes", async () => {
    const { summary, cycles } = await runOracleSoak({
      config: {
        cycles: 12,
        intervalMs: 0,
        outDir: "tmp-soak",
        sourceTimeoutMs: 1000,
        browserTimeoutMs: 1000,
        browserCrashLimit: 2,
        commit: "x",
      },
      adapters: {
        inspectDomria: async () => httpOk("domria"),
        inspectLun: async () => httpOk("lun"),
        inspectRieltorOwners: async () => httpOk("rieltor"),
        inspectOlxHttp: async () => httpBlockedOlx(),
        probeOlxBrowser: async () => {
          throw new Error("chromium exploded");
        },
      },
      runtime: {
        now: (() => {
          let t = 0;
          return () => new Date((t += 1));
        })(),
        memory: () => ({ rssBytes: 1, heapUsedBytes: 1, externalBytes: 0 }),
        sleep: async () => undefined,
        mkdirp: () => undefined,
        writeJson: () => undefined,
        onSignal: () => () => undefined,
      },
    });

    expect(cycles.length).toBe(2);
    expect(summary.stoppedEarly).toBe(true);
    expect(summary.verdict).toBe("FAIL");
    expect(summary.stopReason).toMatch(/repeated_browser_crashes/);
  });

  it("cleans up on SIGINT and records ABORTED", async () => {
    let signalHandler: (() => void) | undefined;
    let cycle = 0;
    const { summary } = await runOracleSoak({
      config: {
        cycles: 5,
        intervalMs: 0,
        outDir: "tmp-soak",
        sourceTimeoutMs: 1000,
        browserTimeoutMs: 1000,
        browserCrashLimit: 3,
        commit: "x",
      },
      adapters: {
        inspectDomria: async () => httpOk("domria"),
        inspectLun: async () => httpOk("lun"),
        inspectRieltorOwners: async () => httpOk("rieltor"),
        inspectOlxHttp: async () => httpBlockedOlx(),
        probeOlxBrowser: async () => {
          cycle += 1;
          if (cycle === 1) {
            signalHandler?.();
          }
          return browserOk();
        },
      },
      runtime: {
        now: (() => {
          let t = 0;
          return () => new Date((t += 1));
        })(),
        memory: () => ({ rssBytes: 1, heapUsedBytes: 1, externalBytes: 0 }),
        sleep: async () => undefined,
        mkdirp: () => undefined,
        writeJson: () => undefined,
        onSignal: (handler) => {
          signalHandler = handler;
          return () => {
            signalHandler = undefined;
          };
        },
      },
    });

    expect(summary.verdict).toBe("ABORTED");
    expect(summary.stoppedEarly).toBe(true);
  });

  it("records browserClosed cleanup and PASS when all cycles complete", async () => {
    let browserCalls = 0;
    const { summary } = await runOracleSoak({
      config: {
        cycles: 2,
        intervalMs: 0,
        outDir: "tmp-soak",
        sourceTimeoutMs: 1000,
        browserTimeoutMs: 1000,
        browserCrashLimit: 3,
        commit: "abc123",
      },
      adapters: {
        inspectDomria: async () => httpOk("domria"),
        inspectLun: async () => httpOk("lun"),
        inspectRieltorOwners: async () => httpOk("rieltor"),
        inspectOlxHttp: async () => httpBlockedOlx(),
        probeOlxBrowser: async () => {
          browserCalls += 1;
          return browserOk();
        },
      },
      runtime: {
        now: (() => {
          let t = 0;
          return () => new Date((t += 5));
        })(),
        memory: () => ({ rssBytes: 42, heapUsedBytes: 10, externalBytes: 0 }),
        sleep: async () => undefined,
        mkdirp: () => undefined,
        writeJson: () => undefined,
        onSignal: () => () => undefined,
      },
    });
    expect(browserCalls).toBe(2);
    expect(summary.verdict).toBe("PASS");
    expect(summary.commit).toBe("abc123");
    expect(summary.note).toMatch(/Does not prove multi-day/);
  });

  it("redacts secrets from evidence notes", async () => {
    const files = new Map<string, unknown>();
    await runOracleSoak({
      config: {
        cycles: 1,
        intervalMs: 0,
        outDir: "tmp-soak",
        sourceTimeoutMs: 1000,
        browserTimeoutMs: 1000,
        browserCrashLimit: 3,
        commit: "x",
      },
      adapters: {
        inspectDomria: async () => httpOk("domria"),
        inspectLun: async () => httpOk("lun"),
        inspectRieltorOwners: async () => httpOk("rieltor"),
        inspectOlxHttp: async () => httpBlockedOlx(),
        probeOlxBrowser: async () => browserOk(),
      },
      runtime: {
        now: () => new Date(1),
        memory: () => ({ rssBytes: 1, heapUsedBytes: 1, externalBytes: 0 }),
        sleep: async () => undefined,
        mkdirp: () => undefined,
        writeJson: (path, data) => files.set(path, data),
        onSignal: () => () => undefined,
      },
    });
    const cycleKey = [...files.keys()].find((k) => k.replace(/\\/g, "/").endsWith("tmp-soak/cycle-1.json"));
    expect(cycleKey).toBeTruthy();
    const cycle = files.get(cycleKey!) as SoakCycleReport;
    const blob = JSON.stringify(cycle);
    expect(blob).not.toContain("supersecretvalue");
    expect(blob).toContain("api_key=redacted");
    expect(assertNoSecretMaterial(blob)).toEqual([]);
    expect(sanitizeSoakText("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).toContain(
      "[redacted-private-key]",
    );
  });
});

describe("failure streaks + verdict helpers", () => {
  it("tracks repeated failure streaks", () => {
    const cycles: SoakCycleReport[] = [
      {
        experiment: "oracle-soak",
        cycle: 1,
        startedAt: "a",
        endedAt: "b",
        status: "degraded",
        elapsedMs: 1,
        memoryBefore: { rssBytes: 1, heapUsedBytes: 1, externalBytes: 0 },
        memoryAfter: { rssBytes: 1, heapUsedBytes: 1, externalBytes: 0 },
        sources: [
          source({ source: "lun", required: true, success: false }),
          source({ source: "domria", required: true, success: true }),
        ],
      },
      {
        experiment: "oracle-soak",
        cycle: 2,
        startedAt: "a",
        endedAt: "b",
        status: "degraded",
        elapsedMs: 1,
        memoryBefore: { rssBytes: 1, heapUsedBytes: 1, externalBytes: 0 },
        memoryAfter: { rssBytes: 1, heapUsedBytes: 1, externalBytes: 0 },
        sources: [
          source({ source: "lun", required: true, success: false }),
          source({ source: "domria", required: true, success: true }),
        ],
      },
    ];
    expect(maxFailureStreaks(cycles).lun).toBe(2);
    expect(
      decideSoakVerdict({
        cycles,
        cyclesRequested: 2,
        stoppedEarly: false,
        abortedBySignal: false,
        fatalStop: false,
      }),
    ).toBe("DEGRADED");
  });
});
