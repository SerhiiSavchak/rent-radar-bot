/**
 * Bounded OLX browser extraction check (no Telegram).
 *
 * Writes JSON under OUT_DIR (default ~/rent-radar-runtime/olx-browser-extract).
 * Optional diagnostic capture (HTML + script inventory + card fragments + network meta)
 * goes to a unique subdirectory when OLX_BROWSER_CAPTURE=true.
 *
 * Business resource benchmark (diagnostic only, still no Telegram and no SQLite):
 *   OLX_BROWSER_BUSINESS_BENCHMARK_MODE=full|hot
 *   OUT_DIR or OLX_BROWSER_OUT_DIR is required in that mode.
 *   full omits any Business snapshot timestamp, so the real full snapshot is due.
 *   hot passes a recent timestamp in memory only. The timestamp is not stored.
 *   Budgets stay the production acquisition limits (45s / 180s / 360s).
 *
 * Env:
 *   OLX_BROWSER_EXTRACT=true          required gate
 *   OUT_DIR                           benchmark output directory
 *   OLX_BROWSER_OUT_DIR               default $HOME/rent-radar-runtime/olx-browser-extract
 *   OLX_BROWSER_TIMEOUT_MS            navigation (page.goto) timeout; default 45000
 *   OLX_BROWSER_CATEGORY_BUDGET_MS    wall clock per category; default = TIMEOUT_MS
 *   OLX_BROWSER_TOTAL_BUDGET_MS       wall clock apartments+houses; default = 2*category+5000
 *   OLX_BROWSER_MAX_PAGES             default 1 (max 2); capture forces 1
 *   OLX_BROWSER_CAPTURE=true          write main-document + rendered HTML diagnostics
 *   OLX_BROWSER_COMMIT                optional git commit override
 *   OLX_BROWSER_BUSINESS_BENCHMARK_MODE  full | hot
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isOlxBusinessFullScanDue,
  OLX_PARSER_LOSS_REASONS,
  OLX_PRIVATE_CATEGORY_BUDGET_MS,
  OLX_PRIVATE_NAVIGATION_TIMEOUT_MS,
  OLX_PRIVATE_TOTAL_BUDGET_MS,
  olxParserLossCount,
} from "../sources/olx/olx-browser.coverage.ts";
import {
  extractOlxListingsViaBrowser,
  type OlxBrowserExtractResult,
  type OlxBusinessCategoryScan,
  type OlxPrivateCategoryScan,
} from "../sources/olx/olx-browser.extract.ts";

/** Recent enough that a hot benchmark stays inside the 30-minute snapshot window. */
export const OLX_BUSINESS_BENCHMARK_HOT_AGE_MS = 5 * 60 * 1000;

/** Production acquisition limits. The benchmark must not raise them. */
export const OLX_BUSINESS_BENCHMARK_BUDGETS = {
  navigationTimeoutMs: OLX_PRIVATE_NAVIGATION_TIMEOUT_MS,
  categoryBudgetMs: OLX_PRIVATE_CATEGORY_BUDGET_MS,
  totalBudgetMs: OLX_PRIVATE_TOTAL_BUDGET_MS,
} as const;

export type OlxBusinessBenchmarkMode = "full" | "hot";

export type OlxBusinessBenchmarkPlan = {
  benchmarkMode: OlxBusinessBenchmarkMode;
  /** Present only for hot. Diagnostic input; never persisted. */
  businessLastFullScanAt?: string;
  fullSnapshotDue: boolean;
  businessApartmentMode: "full" | "hot";
};

export function parseOlxBusinessBenchmarkMode(
  raw: string | undefined,
): OlxBusinessBenchmarkMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "full" || value === "hot") {
    return value;
  }
  throw new Error(
    `OLX_BROWSER_BUSINESS_BENCHMARK_MODE must be full or hot, received ${JSON.stringify(raw)}`,
  );
}

/**
 * full: no timestamp, so the production due-check selects a full apartment snapshot.
 * hot: an in-memory timestamp five minutes ago, so apartments stay on page 1.
 */
export function planOlxBusinessBenchmark(
  mode: OlxBusinessBenchmarkMode,
  now: Date,
): OlxBusinessBenchmarkPlan {
  if (mode === "full") {
    return {
      benchmarkMode: "full",
      fullSnapshotDue: isOlxBusinessFullScanDue(undefined, now),
      businessApartmentMode: "full",
    };
  }
  const lastFullScanAt = new Date(now.getTime() - OLX_BUSINESS_BENCHMARK_HOT_AGE_MS);
  const fullSnapshotDue = isOlxBusinessFullScanDue(lastFullScanAt, now);
  return {
    benchmarkMode: "hot",
    businessLastFullScanAt: lastFullScanAt.toISOString(),
    fullSnapshotDue,
    businessApartmentMode: fullSnapshotDue ? "full" : "hot",
  };
}

function privateScanFields(scan: OlxPrivateCategoryScan | undefined) {
  return {
    status: scan?.status ?? null,
    expectedPages: scan?.expectedPages ?? null,
    fetchedPages: scan?.fetchedPages ?? [],
    totalElements: scan?.totalElements ?? null,
    uniqueListingIds: scan?.uniqueListingIds ?? null,
  };
}

function businessScanFields(scan: OlxBusinessCategoryScan | undefined) {
  return {
    mode: scan?.mode ?? null,
    status: scan?.status ?? null,
    fullCoverage: scan?.fullCoverage ?? null,
    pageCoverageComplete: scan?.pageCoverageComplete ?? null,
    parserCoverageHealthy: scan?.parserCoverageHealthy ?? null,
    expectedPages: scan?.expectedPages ?? null,
    fetchedPages: scan?.fetchedPages ?? [],
    totalElements: scan?.totalElements ?? null,
    uniqueListingIds: scan?.uniqueListingIds ?? null,
    ceilingExceeded: scan?.ceilingExceeded ?? null,
    failureDetails: scan?.failureDetails ?? [],
  };
}

function meaningfulParserFailures(result: OlxBrowserExtractResult): {
  meaningfulFailureCount: number;
  reasons: Record<string, number>;
} {
  const combined: Record<string, number> = {};
  for (const scan of [result.businessScan?.apartments, result.businessScan?.houses]) {
    for (const reason of OLX_PARSER_LOSS_REASONS) {
      const count = scan?.parser.rejectionReasonCounts[reason] ?? 0;
      if (count > 0) {
        combined[reason] = (combined[reason] ?? 0) + count;
      }
    }
  }
  return {
    meaningfulFailureCount: olxParserLossCount(combined),
    reasons: combined,
  };
}

export function summarizeOlxBusinessBenchmark(input: {
  pid: number;
  commit: string;
  plan: OlxBusinessBenchmarkPlan;
  startedAt: string;
  finishedAt: string;
  result: OlxBrowserExtractResult;
}) {
  const { result, plan } = input;
  const pagesFetched =
    (result.privateScan?.apartments.fetchedPages.length ?? 0) +
    (result.privateScan?.houses.fetchedPages.length ?? 0) +
    (result.businessScan?.apartments.fetchedPages.length ?? 0) +
    (result.businessScan?.houses.fetchedPages.length ?? 0);
  return {
    message: "olx-business-benchmark.done",
    pid: input.pid,
    commit: input.commit,
    benchmarkMode: plan.benchmarkMode,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    wallClockMs: result.wallClockMs,
    budgetExceeded: result.budgetExceeded,
    browserClosed: result.browserClosed,
    budgets: OLX_BUSINESS_BENCHMARK_BUDGETS,
    privateApartments: privateScanFields(result.privateScan?.apartments),
    privateHouses: privateScanFields(result.privateScan?.houses),
    businessApartments: businessScanFields(result.businessScan?.apartments),
    businessHouses: businessScanFields(result.businessScan?.houses),
    businessFullScan: {
      previousTimestampInput: plan.businessLastFullScanAt ?? null,
      due: result.businessFullScan?.due ?? null,
      succeeded: result.businessFullScan?.succeeded ?? null,
      pagesExpected: result.businessFullScan?.pagesExpected ?? null,
      pagesFetched: result.businessFullScan?.pagesFetched ?? null,
      ageStatus: result.businessFullScan?.ageStatus ?? null,
    },
    parser: meaningfulParserFailures(result),
    total: {
      listingsReturned: result.listings.length,
      pagesFetched,
    },
  };
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

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

async function runBenchmark(input: {
  mode: OlxBusinessBenchmarkMode;
  outDir: string;
  commit: string;
}): Promise<number> {
  const started = new Date();
  const plan = planOlxBusinessBenchmark(input.mode, started);
  const startedAt = started.toISOString();
  const runId = `${Date.now()}`;
  mkdirSync(input.outDir, { recursive: true, mode: 0o700 });
  console.log(
    JSON.stringify({
      message: "olx-business-benchmark.start",
      pid: process.pid,
      commit: input.commit,
      benchmarkMode: plan.benchmarkMode,
      businessApartmentMode: plan.businessApartmentMode,
      fullSnapshotDue: plan.fullSnapshotDue,
      previousTimestampInput: plan.businessLastFullScanAt ?? null,
      startedAt,
      budgets: OLX_BUSINESS_BENCHMARK_BUDGETS,
      outDir: input.outDir,
      note: "No Telegram. No SQLite. Business timestamp is memory-only.",
    }),
  );
  try {
    const result = await extractOlxListingsViaBrowser({
      timeoutMs: OLX_BUSINESS_BENCHMARK_BUDGETS.navigationTimeoutMs,
      categoryBudgetMs: OLX_BUSINESS_BENCHMARK_BUDGETS.categoryBudgetMs,
      totalBudgetMs: OLX_BUSINESS_BENCHMARK_BUDGETS.totalBudgetMs,
      commit: input.commit,
      ...(plan.businessLastFullScanAt
        ? { businessLastFullScanAt: plan.businessLastFullScanAt }
        : {}),
    });
    const summary = summarizeOlxBusinessBenchmark({
      pid: process.pid,
      commit: input.commit,
      plan,
      startedAt,
      finishedAt: new Date().toISOString(),
      result,
    });
    const outPath = join(input.outDir, `business-benchmark-${plan.benchmarkMode}-${runId}.json`);
    writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...summary, outPath }));
    return result.extractionOk ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    const failPath = join(input.outDir, `business-benchmark-fail-${runId}.json`);
    const failure = {
      message: "olx-business-benchmark.failed",
      ok: false,
      pid: process.pid,
      commit: input.commit,
      benchmarkMode: plan.benchmarkMode,
      startedAt,
      finishedAt,
      wallClockMs: Date.parse(finishedAt) - started.getTime(),
      error: message,
      failPath,
    };
    writeFileSync(failPath, `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
    console.error(JSON.stringify(failure));
    return 1;
  }
}

async function runLegacyExtract(input: { outDir: string; commit: string }): Promise<number> {
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
  const runId = `${Date.now()}`;
  const captureDir = captureEnabled ? join(input.outDir, `capture-${runId}`) : undefined;
  mkdirSync(input.outDir, { recursive: true, mode: 0o700 });
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true, mode: 0o700 });
  }
  const startedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      message: "olx-browser-extract.start",
      outDir: input.outDir,
      captureEnabled,
      captureDir: captureDir ?? null,
      timeoutMs,
      categoryBudgetMs,
      totalBudgetMs,
      maxPages,
      commit: input.commit,
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
      commit: input.commit,
      ...(captureDir ? { captureDir } : {}),
    });
    const summary = {
      message: "olx-browser-extract.done",
      startedAt,
      finishedAt: new Date().toISOString(),
      commit: input.commit,
      accessibilityOk: result.accessibilityOk,
      extractionOk: result.extractionOk,
      validatedListingCount: result.listings.length,
      budgets: result.budgets,
      wallClockMs: result.wallClockMs,
      budgetExceeded: result.budgetExceeded,
      timing: result.timing,
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
        budgetExceeded: result.apartments.budgetExceeded ?? false,
        timing: result.apartments.timing ?? null,
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
        budgetExceeded: result.houses.budgetExceeded ?? false,
        timing: result.houses.timing ?? null,
        requestedUrl: result.houses.requestedUrl,
        finalUrl: result.houses.finalUrl,
        capturePaths: result.houses.capturePaths ?? null,
        ...(result.houses.httpStatus !== undefined ? { httpStatus: result.houses.httpStatus } : {}),
      },
      sampleListings: result.listings.slice(0, 5).map((listing) => ({
        sourceId: listing.sourceId,
        url: listing.url,
        price: listing.price,
        propertyType: listing.propertyType,
        sellerType: listing.sellerType,
        sellerEvidence: listing.sellerEvidence?.slice(0, 3),
        city: listing.location.city,
        latitude: listing.location.latitude ?? null,
        longitude: listing.location.longitude ?? null,
        publishedAt: listing.publishedAt?.toISOString() ?? null,
        refreshedAt: listing.refreshedAt?.toISOString() ?? null,
      })),
      notes: result.notes,
      browserClosed: result.browserClosed,
    };
    const outPath = join(input.outDir, `extract-${runId}.json`);
    writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...summary, outPath }));
    return result.extractionOk ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failPath = join(input.outDir, `extract-fail-${runId}.json`);
    writeFileSync(
      failPath,
      `${JSON.stringify(
        {
          ok: false,
          error: message,
          commit: input.commit,
          captureDir: captureDir ?? null,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.error(JSON.stringify({ message: "olx-browser-extract.failed", error: message, failPath }));
    return 1;
  }
}

async function main(): Promise<void> {
  if (process.env.OLX_BROWSER_EXTRACT !== "true") {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Set OLX_BROWSER_EXTRACT=true to run this opt-in extraction check",
      }),
    );
    process.exitCode = 2;
    return;
  }
  let mode: OlxBusinessBenchmarkMode | undefined;
  try {
    mode = parseOlxBusinessBenchmarkMode(process.env.OLX_BROWSER_BUSINESS_BENCHMARK_MODE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 2;
    return;
  }
  const commit = resolveCommit();
  if (mode) {
    const outDir = process.env.OUT_DIR?.trim() || process.env.OLX_BROWSER_OUT_DIR?.trim();
    if (!outDir) {
      console.error(
        JSON.stringify({
          ok: false,
          error: "Set OUT_DIR or OLX_BROWSER_OUT_DIR for the business benchmark",
        }),
      );
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runBenchmark({ mode, outDir, commit });
    return;
  }
  const outDir =
    process.env.OLX_BROWSER_OUT_DIR?.trim() ||
    process.env.OUT_DIR?.trim() ||
    join(homedir(), "rent-radar-runtime", "olx-browser-extract");
  process.exitCode = await runLegacyExtract({ outDir, commit });
}

if (isDirectExecution()) {
  await main();
}
