/**
 * Read-only OLX Private catalog check. No Telegram. No production DB writes.
 *
 * Prints one JSON object on stdout:
 * commit, apartments/houses expected and fetched pages, totalElements,
 * unique listing ids, businessLeakCount, parser/navigation failures, elapsedMs, complete.
 *
 * Required:
 *   OLX_PRIVATE_CATALOG_VERIFY=true
 *
 * Does not deploy, restart systemd, or touch Telegram credentials.
 * One run is not a Source Layer PASS. PASS needs three separate successful runs.
 */
import { execSync } from "node:child_process";
import { extractOlxListingsViaBrowser } from "../sources/olx/olx-browser.extract.ts";
import { buildOlxPrivateCatalogReport } from "../sources/olx/olx-private-catalog.report.ts";
import { resolveOlxBrowserBudgets } from "../sources/olx/olx-browser.source.ts";

if (process.env.OLX_PRIVATE_CATALOG_VERIFY !== "true") {
  console.error(
    JSON.stringify({
      ok: false,
      error: "Set OLX_PRIVATE_CATALOG_VERIFY=true to run this read-only catalog check",
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

const budgets = resolveOlxBrowserBudgets();
const commit = resolveCommit();
const started = Date.now();

try {
  const result = await extractOlxListingsViaBrowser({
    timeoutMs: budgets.timeoutMs,
    categoryBudgetMs: budgets.categoryBudgetMs,
    totalBudgetMs: budgets.totalBudgetMs,
    commit,
  });
  const report = buildOlxPrivateCatalogReport({
    commit,
    elapsedMs: Date.now() - started,
    result,
  });
  console.log(JSON.stringify(report, null, 2));
  const leaksRejected = report.businessLeakCount === 0 || report.healthDegraded;
  const pass =
    report.complete &&
    report.parserFailures.length === 0 &&
    report.navigationFailures.length === 0 &&
    leaksRejected;
  process.exit(pass ? 0 : 1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(
    JSON.stringify(
      {
        commit,
        apartmentsExpectedPages: null,
        apartmentsFetchedPages: [],
        apartmentsTotalElements: null,
        housesExpectedPages: null,
        housesFetchedPages: [],
        housesTotalElements: null,
        uniqueListingIds: 0,
        businessLeakCount: 0,
        parserFailures: [],
        navigationFailures: [message.slice(0, 180)],
        otherFailures: ["extract_threw"],
        elapsedMs: Date.now() - started,
        complete: false,
        healthDegraded: true,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
