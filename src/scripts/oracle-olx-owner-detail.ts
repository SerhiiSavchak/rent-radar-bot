/**
 * Bounded OLX offer-detail owner diagnostic (no Telegram).
 *
 * Writes JSON under OUT_DIR (default ~/rent-radar-runtime/olx-owner-detail).
 * One navigation of the recorded baab323 self-declared candidate URL.
 *
 * Env:
 *   OLX_BROWSER_OWNER_DETAIL=true     required gate
 *   OLX_BROWSER_OUT_DIR               default $HOME/rent-radar-runtime/olx-owner-detail
 *   OLX_BROWSER_TIMEOUT_MS            navigation timeout; default 45000
 *   OLX_BROWSER_CAPTURE=true          write clipped main-document HTML outside git
 *   OLX_BROWSER_COMMIT                optional git commit override
 *   OLX_OWNER_DETAIL_URL              optional URL override (tests only)
 *   OLX_OWNER_DETAIL_SOURCE_ID        optional id override (tests only)
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectOlxOwnerDetailViaBrowser } from "../sources/olx/olx-browser.owner-detail.ts";
import { OLX_OWNER_DETAIL_CANDIDATE } from "../sources/olx/olx-owner-detail.candidate.ts";

if (process.env.OLX_BROWSER_OWNER_DETAIL !== "true") {
  console.error(
    JSON.stringify({
      ok: false,
      error: "Set OLX_BROWSER_OWNER_DETAIL=true to run this opt-in owner-detail diagnostic",
    }),
  );
  process.exit(2);
}

function resolveCommit(): string {
  if (process.env.OLX_BROWSER_COMMIT?.trim()) {
    return process.env.OLX_BROWSER_COMMIT.trim();
  }
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const outDir =
  process.env.OLX_BROWSER_OUT_DIR?.trim() ||
  join(homedir(), "rent-radar-runtime", "olx-owner-detail");
const timeoutMs = Math.max(5_000, Number(process.env.OLX_BROWSER_TIMEOUT_MS ?? "45000"));
const captureEnabled = process.env.OLX_BROWSER_CAPTURE === "true";
const commit = resolveCommit();
const runId = `${Date.now()}`;
const captureDir = captureEnabled ? join(outDir, `capture-${runId}`) : undefined;
const urlOverride = process.env.OLX_OWNER_DETAIL_URL?.trim();
const sourceIdOverride = process.env.OLX_OWNER_DETAIL_SOURCE_ID?.trim();

mkdirSync(outDir, { recursive: true, mode: 0o700 });
if (captureDir) {
  mkdirSync(captureDir, { recursive: true, mode: 0o700 });
}

const startedAt = new Date().toISOString();
console.log(
  JSON.stringify({
    message: "olx-owner-detail.start",
    outDir,
    captureEnabled,
    captureDir: captureDir ?? null,
    timeoutMs,
    commit,
    candidate: {
      sourceId: OLX_OWNER_DETAIL_CANDIDATE.sourceId,
      captureId: OLX_OWNER_DETAIL_CANDIDATE.captureId,
      generatingCommit: OLX_OWNER_DETAIL_CANDIDATE.generatingCommit,
    },
    note: "No Telegram. One detail navigation. Does not intercept /api/v1/offers.",
    startedAt,
  }),
);

try {
  const result = await inspectOlxOwnerDetailViaBrowser({
    timeoutMs,
    commit,
    ...(captureDir ? { captureDir } : {}),
    ...(urlOverride ? { url: urlOverride } : {}),
    ...(sourceIdOverride ? { sourceId: sourceIdOverride } : {}),
  });

  const summary = {
    message: "olx-owner-detail.done",
    startedAt,
    finishedAt: new Date().toISOString(),
    commit,
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    sourceId: result.sourceId,
    candidateProvenance: result.candidateProvenance,
    httpStatus: result.httpStatus ?? null,
    accessibility: result.accessibility,
    htmlInputKind: result.htmlInputKind,
    inspection: result.inspection,
    elapsedMs: result.elapsedMs,
    timedOut: result.timedOut,
    browserClosed: result.browserClosed,
    navigations: result.navigations,
    offersApiIntercepted: result.offersApiIntercepted,
    captureDir: captureDir ?? null,
    capturePaths: result.capturePaths ?? null,
    notes: result.notes,
    strongerThanCatalogSelfDeclared: result.inspection.strongerThanCatalogSelfDeclared,
    defaultOwnerGateWouldAccept: result.inspection.defaultOwnerGateWouldAccept,
    investigationClosedIfNoStrongerEvidence: !result.inspection.strongerThanCatalogSelfDeclared,
  };

  const outPath = join(outDir, `owner-detail-${runId}.json`);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, outPath }));
  process.exitCode = result.browserClosed ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const failPath = join(outDir, `owner-detail-fail-${runId}.json`);
  writeFileSync(
    failPath,
    `${JSON.stringify(
      {
        ok: false,
        error: message,
        commit,
        captureDir: captureDir ?? null,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.error(JSON.stringify({ message: "olx-owner-detail.failed", error: message, failPath }));
  process.exitCode = 1;
}
