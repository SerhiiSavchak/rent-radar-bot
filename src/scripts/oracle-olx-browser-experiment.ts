/**
 * Isolated OLX browser probe for Oracle Always Free (or any Node 22 host).
 * Thin wrapper around shared stock Chromium probe — no production OlxSource.
 *
 * Env:
 *   OLX_BROWSER_OUT_DIR   default evidence/phase-1/oracle-olx-browser
 *   OLX_BROWSER_TIMEOUT_MS default 45000
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeOlxBrowserOnce } from "../probe/olx-browser-probe.ts";

const outDir = process.env.OLX_BROWSER_OUT_DIR ?? "evidence/phase-1/oracle-olx-browser";
const timeoutMs = Math.max(5_000, Number(process.env.OLX_BROWSER_TIMEOUT_MS ?? "45000"));

mkdirSync(outDir, { recursive: true });

console.log(
  JSON.stringify({
    message: "oracle-olx-browser-experiment.start",
    outDir,
    timeoutMs,
    node: process.version,
    note: "Stock Playwright Chromium only; no bypass techniques.",
    startedAt: new Date().toISOString(),
  }),
);

const result = await probeOlxBrowserOnce({ timeoutMs });

const report = {
  experiment: "oracle-olx-browser",
  cycle: 1,
  capturedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  constraints: {
    proxies: false,
    stealthPlugins: false,
    captchaSolving: false,
    ipRotation: false,
    fingerprintSpoofing: false,
    wafBypass: false,
    productionAdapterTouched: false,
  },
  apartments: result.apartments,
  houses: result.houses,
  overallSuccess: result.overallSuccess,
  browserClosed: result.browserClosed,
  overallOutcomes: {
    apartments: result.apartments.outcome,
    houses: result.houses.outcome,
  },
};

const path = join(outDir, "cycle-1.json");
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  JSON.stringify({
    message: "oracle-olx-browser-experiment.done",
    path,
    overallSuccess: report.overallSuccess,
    overallOutcomes: report.overallOutcomes,
    finishedAt: new Date().toISOString(),
  }),
);

process.exitCode = report.overallSuccess ? 0 : 1;
