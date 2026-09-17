/**
 * Bounded OLX browser extraction check (no Telegram).
 *
 * Writes JSON under OUT_DIR (default ~/rent-radar-runtime/olx-browser-extract)
 * to avoid untracked files inside the git worktree.
 *
 * Env:
 *   OLX_BROWSER_EXTRACT=true   required gate
 *   OLX_BROWSER_OUT_DIR        default $HOME/rent-radar-runtime/olx-browser-extract
 *   OLX_BROWSER_TIMEOUT_MS     default 45000
 *   OLX_BROWSER_MAX_PAGES      default 1 (max 2)
 */

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

const outDir =
  process.env.OLX_BROWSER_OUT_DIR?.trim() ||
  join(homedir(), "rent-radar-runtime", "olx-browser-extract");
const timeoutMs = Math.max(5_000, Number(process.env.OLX_BROWSER_TIMEOUT_MS ?? "45000"));
const maxPages = Math.max(1, Math.min(2, Number(process.env.OLX_BROWSER_MAX_PAGES ?? "1")));

mkdirSync(outDir, { recursive: true, mode: 0o700 });

const startedAt = new Date().toISOString();
console.log(
  JSON.stringify({
    message: "olx-browser-extract.start",
    outDir,
    timeoutMs,
    maxPages,
    note: "No Telegram. Accessibility ≠ extraction success.",
    startedAt,
  }),
);

try {
  const result = await extractOlxListingsViaBrowser({
    timeoutMs,
    maxPagesPerCategory: maxPages,
  });

  const summary = {
    message: "olx-browser-extract.done",
    startedAt,
    finishedAt: new Date().toISOString(),
    accessibilityOk: result.accessibilityOk,
    extractionOk: result.extractionOk,
    validatedListingCount: result.listings.length,
    apartments: {
      accessibility: result.apartments.accessibility,
      accessibilityOk: result.apartments.accessibilityOk,
      apiResponsesCaptured: result.apartments.apiResponsesCaptured,
      rawOfferCount: result.apartments.rawOfferCount,
      validatedListingCount: result.apartments.validatedListingCount,
      rejections: result.apartments.rejections,
      elapsedMs: result.apartments.elapsedMs,
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
      rejections: result.houses.rejections,
      elapsedMs: result.houses.elapsedMs,
      ...(result.houses.httpStatus !== undefined ? { httpStatus: result.houses.httpStatus } : {}),
    },
    sampleListings: result.listings.slice(0, 5).map((l) => ({
      sourceId: l.sourceId,
      url: l.url,
      price: l.price,
      propertyType: l.propertyType,
      sellerType: l.sellerType,
      city: l.location.city,
      publishedAt: l.publishedAt?.toISOString() ?? null,
    })),
    notes: result.notes,
    browserClosed: result.browserClosed,
  };

  const outPath = join(outDir, `extract-${Date.now()}.json`);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, outPath }));
  process.exitCode = result.extractionOk ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const failPath = join(outDir, `extract-fail-${Date.now()}.json`);
  writeFileSync(
    failPath,
    `${JSON.stringify({ ok: false, error: message, finishedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.error(JSON.stringify({ message: "olx-browser-extract.failed", error: message, failPath }));
  process.exitCode = 1;
}
