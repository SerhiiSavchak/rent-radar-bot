/**
 * One bounded OLX offer-detail navigation (stock Playwright).
 * Does not intercept or retry /api/v1/offers. Not wired to Telegram.
 */

import { mkdirSync } from "node:fs";
import { chromium, type Browser, type Response } from "playwright";
import { classifyOlxBrowserProbe } from "../../probe/olx-browser-classify.ts";
import {
  OLX_PARSER_MAX_HTML_BYTES,
  sanitizeUrlForLog,
  truncateUtf8Bytes,
  writeOlxDetailCapture,
  type OlxDetailCapturePaths,
} from "./olx-browser.capture.ts";
import {
  inspectOlxOfferDetailHtml,
  type OlxOfferDetailInspection,
} from "./olx-browser.detail-inspect.ts";
import { OLX_OWNER_DETAIL_CANDIDATE } from "./olx-owner-detail.candidate.ts";

export type OlxOwnerDetailResult = {
  requestedUrl: string;
  finalUrl: string;
  sourceId: string;
  candidateProvenance: typeof OLX_OWNER_DETAIL_CANDIDATE;
  httpStatus?: number;
  accessibility: string;
  htmlInputKind: "main_document" | "none";
  inspection: OlxOfferDetailInspection;
  elapsedMs: number;
  timedOut: boolean;
  browserClosed: boolean;
  navigations: 1;
  offersApiIntercepted: false;
  capturePaths?: OlxDetailCapturePaths;
  notes: string[];
};

export type OlxOwnerDetailDeps = {
  timeoutMs: number;
  url?: string;
  sourceId?: string;
  launch?: () => Promise<Browser>;
  captureDir?: string;
  commit?: string;
};

export function isOlxOfferDetailHtmlResponse(input: {
  requestedUrl: string;
  responseUrl: string;
  contentType: string;
}): boolean {
  const contentType = input.contentType.toLowerCase();
  if (contentType && !contentType.includes("html") && !contentType.startsWith("text/plain")) {
    return false;
  }
  try {
    const requested = new URL(input.requestedUrl);
    const actual = new URL(input.responseUrl);
    const requestedHost = requested.hostname.replace(/^www\./, "");
    const actualHost = actual.hostname.replace(/^www\./, "");
    if (actualHost !== requestedHost) {
      return false;
    }
    if (!/(^|\.)olx\.ua$/i.test(requestedHost)) {
      return false;
    }
    return /\/d\/[^?]*(?:obyavlenie\/)?[^?]*ID[A-Za-z0-9]+\.html$/i.test(actual.pathname);
  } catch {
    return false;
  }
}

async function readGotoHtmlBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; originalBytes: number }> {
  const buf = await response.body();
  const originalBytes = buf.byteLength;
  const clipped = truncateUtf8Bytes(buf.toString("utf8"), maxBytes);
  return { text: clipped.text, truncated: clipped.truncated, originalBytes };
}

/**
 * One Chromium launch, one detail-page goto, always close.
 * No pagination, no retry, no /api/v1/offers fetch.
 */
export async function inspectOlxOwnerDetailViaBrowser(
  deps: OlxOwnerDetailDeps,
): Promise<OlxOwnerDetailResult> {
  const url = deps.url?.trim() || OLX_OWNER_DETAIL_CANDIDATE.url;
  const sourceId = deps.sourceId?.trim() || OLX_OWNER_DETAIL_CANDIDATE.sourceId;
  const timeoutMs = Math.max(1, deps.timeoutMs);
  const commit = deps.commit ?? "unknown";
  const notes: string[] = [
    "transport=stock_playwright_chromium",
    "opt_in_only=true",
    "not_wired_to_telegram=true",
    "navigations=1",
    "offers_api_not_intercepted=true",
    `timeoutMs=${timeoutMs}`,
    `candidateCapture=${OLX_OWNER_DETAIL_CANDIDATE.captureId}`,
    `candidateCommit=${OLX_OWNER_DETAIL_CANDIDATE.generatingCommit}`,
  ];
  if (deps.captureDir) {
    mkdirSync(deps.captureDir, { recursive: true, mode: 0o700 });
  }

  const launch = deps.launch ?? (() => chromium.launch({ headless: true }));
  const browser = await launch();
  const started = Date.now();
  let timedOut = false;
  let finalUrl = url;
  let httpStatus: number | undefined;
  let mainDocumentHtml: string | undefined;
  let htmlInputKind: "main_document" | "none" = "none";
  let capturePaths: OlxDetailCapturePaths | undefined;
  let inspection: OlxOfferDetailInspection | undefined;

  try {
    const context = await browser.newContext({ locale: "uk-UA" });
    try {
      const page = await context.newPage();
      // Intentionally no page.on("response"): do not retry the blocked offers API.
      let response: Response | null = null;
      try {
        response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timeout/i.test(message)) {
          timedOut = true;
          notes.push("navigation_timeout");
        } else {
          notes.push(`navigation_error:${message.slice(0, 120)}`);
        }
      }

      if (response) {
        httpStatus = response.status();
        const responseUrl = response.url();
        const contentType = response.headers()["content-type"] ?? "";
        if (
          !isOlxOfferDetailHtmlResponse({
            requestedUrl: url,
            responseUrl,
            contentType,
          })
        ) {
          notes.push(`navigation_response_not_offer_html:${sanitizeUrlForLog(responseUrl)}`);
        } else {
          try {
            const body = await Promise.race([
              readGotoHtmlBody(response, OLX_PARSER_MAX_HTML_BYTES),
              new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("body_read_timeout")), timeoutMs);
              }),
            ]);
            mainDocumentHtml = body.text;
            htmlInputKind = "main_document";
            if (body.truncated) {
              notes.push(`main_document_truncated:originalBytes=${body.originalBytes}`);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/timeout/i.test(message)) {
              timedOut = true;
            }
            notes.push(`body_read_failed:${message.slice(0, 80)}`);
          }
        }
      }

      try {
        finalUrl = page.url();
      } catch {
        timedOut = true;
      }
      const title = await page.title().catch(() => "");
      const classified = classifyOlxBrowserProbe({
        requestedUrl: url,
        finalUrl,
        title,
        bodyText: mainDocumentHtml ?? "",
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      });
      notes.push(`accessibility=${classified.outcome}`);
      await page.close().catch(() => undefined);
    } finally {
      await context.close().catch(() => undefined);
    }

    inspection = inspectOlxOfferDetailHtml(mainDocumentHtml ?? "", sourceId);
    if (deps.captureDir) {
      capturePaths = writeOlxDetailCapture({
        captureDir: deps.captureDir,
        commit,
        startedAt: new Date(started).toISOString(),
        requestedUrl: url,
        finalUrl,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        sourceId,
        ...(mainDocumentHtml !== undefined ? { mainDocumentHtml } : {}),
        ...(timedOut ? { skippedReason: "timeout" } : {}),
      });
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const elapsedMs = Date.now() - started;
  if (elapsedMs > timeoutMs) {
    timedOut = true;
  }
  const resolvedInspection =
    inspection ?? inspectOlxOfferDetailHtml(mainDocumentHtml ?? "", sourceId);

  return {
    requestedUrl: url,
    finalUrl,
    sourceId,
    candidateProvenance: OLX_OWNER_DETAIL_CANDIDATE,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    accessibility: resolvedInspection.offerRecordFound ? "browser_accessible" : "parser_failure",
    htmlInputKind,
    inspection: resolvedInspection,
    elapsedMs,
    timedOut,
    browserClosed: true,
    navigations: 1,
    offersApiIntercepted: false,
    ...(capturePaths ? { capturePaths } : {}),
    notes,
  };
}
