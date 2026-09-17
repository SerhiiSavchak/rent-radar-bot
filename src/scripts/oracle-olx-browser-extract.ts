/**
 * Bounded OLX browser extraction check (no Telegram).
 *
 * Writes JSON under OUT_DIR (default ~/rent-radar-runtime/olx-browser-extract).
 * Optional diagnostic capture (HTML + script inventory + card fragments + network meta)
 * goes to a unique subdirectory when OLX_BROWSER_CAPTURE=true.
 *
 * Env:
 *   OLX_BROWSER_EXTRACT=true          required gate
 *   OLX_BROWSER_OUT_DIR               default $HOME/rent-radar-runtime/olx-browser-extract
 *   OLX_BROWSER_TIMEOUT_MS            navigation (page.goto) timeout; default 45000
 *   OLX_BROWSER_CATEGORY_BUDGET_MS    wall clock per category; default = TIMEOUT_MS
 *   OLX_BROWSER_TOTAL_BUDGET_MS       wall clock apartments+houses; default = 2*category+5000
 *   OLX_BROWSER_MAX_PAGES             default 1 (max 2); capture forces 1
 *   OLX_BROWSER_CAPTURE=true          write main-document + rendered HTML diagnostics
 *   OLX_BROWSER_COMMIT                optional git commit override
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractOlxListingsViaBrowser } from "../sources/olx/olx-browser.extract.ts";

if (process.env.OLX_BROWSER_EXTRACT !== "true") {
  console.error(
    JSON.stringify({
      ok: false,
      error: 'Set OLX_BROWSER_EXTRACT=true to run this opt-in extraction check',
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
  join(homedir(), "rent-radar-runtime", "olx-browser-extract");
const timeoutMs = Math.max(5_000, Number(process.env.OLX_BROWSER_TIMEOUT_MS ?? "45000"));
const categoryBudgetMs = Math.max(
  5_000,
  Number(process.env.OLX_BROWSER_CATEGORY_BUDGET_MS ?? String(timeoutMs)),
);
const totalBudgetMs = Math.max(
  categoryBudgetMs + 5_000,
  Number(process.env.OLX_BROWSER_TOTAL_BUDGET_MS ?? String(categoryBudgetMs * 2 + 5_000)),
);
const captureEnabled = process.env.OLX_BROWSER_CAPTURE === "true";
const maxPages = captureEnabled
  ? 1
  : Math.max(1, Math.min(2, Number(process.env.OLX_BROWSER_MAX_PAGES ?? "1")));
const commit = resolveCommit();
const runId = `${Date.now()}`;
const captureDir = captureEnabled ? join(outDir, `capture-${runId}`) : undefined;

mkdirSync(outDir, { recursive: true, mode: 0o700 });
if (captureDir) {
  mkdirSync(captureDir, { recursive: true, mode: 0o700 });
}

const startedAt = new Date().toISOString();
console.log(
  JSON.stringify({
    message: "olx-browser-extract.start",
    outDir,
    captureEnabled,
    captureDir: captureDir ?? null,
    timeoutMs,
    categoryBudgetMs,
    totalBudgetMs,
    maxPages,
    commit,
    note: "No Telegram. timeoutMs=navigation only; category/total budgets bound wall clock. Accessibility ≠ extraction.",
    startedAt,
  }),
);

try {
  const result = await extractOlxListingsViaBrowser({
    timeoutMs,
    categoryBudgetMs,
    totalBudgetMs,
    maxPagesPerCategory: maxPages,
    commit,
    ...(captureDir ? { captureDir } : {}),
  });

  const summary = {
    message: "olx-browser-extract.done",
    startedAt,
    finishedAt: new Date().toISOString(),
    commit,
    accessibilityOk: result.accessibilityOk,
    extractionOk: result.extractionOk,
    validatedListingCount: result.listings.length,
    budgets: result.budgets,
    captureRootDir: result.captureRootDir ?? null,
    apartments: {
      accessibility: result.apartments.accessibility,
      accessibilityOk: result.apartments.accessibilityOk,
      apiResponsesCaptured: result.apartments.apiResponsesCaptured,
      rawOfferCount: result.apartments.rawOfferCount,
      validatedListingCount: result.apartments.validatedListingCount,
      extractSource: result.apartments.extractSource,
      htmlInputKind: result.apartments.htmlInputKind,
      htmlDiagnostics: result.apartments.htmlDiagnostics,
      networkJsonProbes: result.apartments.networkJsonProbes,
      rejections: result.apartments.rejections,
      elapsedMs: result.apartments.elapsedMs,
      timedOut: result.apartments.timedOut ?? false,
      requestedUrl: result.apartments.requestedUrl,
      finalUrl: result.apartments.finalUrl,
      capturePaths: result.apartments.capturePaths ?? null,
      ...(result.apartments.httpStatus !== undefined
        ? { httpStatus: result.apartments.httpStatus }
        : {}),
    },
    houses: {
      accessibility: result.houses.accessibility,
      accessibilityOk: result.houses.accessibilityOk,
      apiResponsesCaptured: result.houses.apiResponsesCaptured,
      rawOfferCount: result.houses.rawOfferCount,
      validatedListingCount: result.houses.validatedListingCount,
      extractSource: result.houses.extractSource,
      htmlInputKind: result.houses.htmlInputKind,
      htmlDiagnostics: result.houses.htmlDiagnostics,
      networkJsonProbes: result.houses.networkJsonProbes,
      rejections: result.houses.rejections,
      elapsedMs: result.houses.elapsedMs,
      timedOut: result.houses.timedOut ?? false,
      requestedUrl: result.houses.requestedUrl,
      finalUrl: result.houses.finalUrl,
      capturePaths: result.houses.capturePaths ?? null,
      ...(result.houses.httpStatus !== undefined ? { httpStatus: result.houses.httpStatus } : {}),
    },
    sampleListings: result.listings.slice(0, 5).map((l) => ({
      sourceId: l.sourceId,
      url: l.url,
      price: l.price,
      propertyType: l.propertyType,
      sellerType: l.sellerType,
      sellerEvidence: l.sellerEvidence?.slice(0, 3),
      city: l.location.city,
      latitude: l.location.latitude ?? null,
      longitude: l.location.longitude ?? null,
      publishedAt: l.publishedAt?.toISOString() ?? null,
      refreshedAt: l.refreshedAt?.toISOString() ?? null,
    })),
    notes: result.notes,
    browserClosed: result.browserClosed,
  };

  const outPath = join(outDir, `extract-${runId}.json`);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, outPath }));
  process.exitCode = result.extractionOk ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const failPath = join(outDir, `extract-fail-${runId}.json`);
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
  console.error(JSON.stringify({ message: "olx-browser-extract.failed", error: message, failPath }));
  process.exitCode = 1;
}
