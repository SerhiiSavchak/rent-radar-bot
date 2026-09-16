/**
 * Unattended Oracle Phase 1 soak: DIM.RIA + LUN + RIELTOR (owners) + OLX browser.
 * OLX direct HTTP is recorded as diagnostic-only (known CloudFront 403).
 *
 * Env:
 *   SOAK_CYCLES          default 12
 *   SOAK_INTERVAL_MS     default 600000 (10 minutes between cycles)
 *   SOAK_OUT_DIR         default evidence/phase-1/oracle-soak
 *   SOAK_BROWSER_TIMEOUT_MS default 45000
 *   SOAK_BROWSER_CRASH_LIMIT default 3
 *   SOAK_COMMIT          optional override for summary.commit
 */

import { execSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";
import { probeOlxBrowserOnce } from "../probe/olx-browser-probe.ts";
import { runOracleSoak } from "../probe/oracle-soak/run-soak.ts";
import { DomriaSource } from "../sources/domria/domria.source.ts";
import { LunSource } from "../sources/lun/lun.source.ts";
import { OlxSource } from "../sources/olx/olx.source.ts";
import { RieltorSource } from "../sources/rieltor/rieltor.source.ts";

loadDotenv();

function resolveCommit(): string {
  if (process.env.SOAK_COMMIT && process.env.SOAK_COMMIT.trim()) {
    return process.env.SOAK_COMMIT.trim();
  }
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const cycles = Math.max(1, Number(process.env.SOAK_CYCLES ?? "12"));
const intervalMs = Math.max(0, Number(process.env.SOAK_INTERVAL_MS ?? String(10 * 60_000)));
const outDir = process.env.SOAK_OUT_DIR ?? "evidence/phase-1/oracle-soak";
const browserTimeoutMs = Math.max(5_000, Number(process.env.SOAK_BROWSER_TIMEOUT_MS ?? "45000"));
const browserCrashLimit = Math.max(1, Number(process.env.SOAK_BROWSER_CRASH_LIMIT ?? "3"));
const limit = Math.max(1, Number(process.env.SOAK_LIMIT ?? "10"));

const domria = new DomriaSource();
const lun = new LunSource();
const rieltor = new RieltorSource();
const olxHttp = new OlxSource();

console.log(
  JSON.stringify({
    message: "oracle-soak.start",
    cycles,
    intervalMs,
    outDir,
    browserTimeoutMs,
    commit: resolveCommit(),
    note: "No Telegram/DB/scheduler changes. No WAF bypass. OLX success path = stock Chromium only.",
    startedAt: new Date().toISOString(),
  }),
);

const { summary } = await runOracleSoak({
  config: {
    cycles,
    intervalMs,
    outDir,
    sourceTimeoutMs: 30_000,
    browserTimeoutMs,
    browserCrashLimit,
    commit: resolveCommit(),
  },
  adapters: {
    inspectDomria: () => domria.inspectLatest({ limit }),
    inspectLun: () => lun.inspectLatest({ limit }),
    inspectRieltorOwners: () =>
      rieltor.inspectLatest({
        limit,
        preferOwners: true,
      }),
    inspectOlxHttp: () =>
      olxHttp.inspectLatest({
        limit,
        includeApartments: true,
        includeHouses: false,
      }),
    probeOlxBrowser: () => probeOlxBrowserOnce({ timeoutMs: browserTimeoutMs }),
  },
});

console.log(
  JSON.stringify({
    message: "oracle-soak.done",
    verdict: summary.verdict,
    totals: summary.totals,
    stoppedEarly: summary.stoppedEarly,
    stopReason: summary.stopReason,
    note: summary.note,
    summaryPath: `${outDir}/summary.json`,
    finishedAt: new Date().toISOString(),
  }),
);

process.exitCode =
  summary.verdict === "PASS" ? 0 : summary.verdict === "ABORTED" ? 130 : 1;
