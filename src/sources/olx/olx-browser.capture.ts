/**
 * Bounded diagnostic capture helpers for OLX browser extract.
 * Writes artifacts outside the git worktree. Never persists cookies/auth headers.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type OlxScriptInventoryItem = {
  index: number;
  type: string | null;
  id: string | null;
  src: string | null;
  inlineLength: number;
  inlinePreview?: string;
};

export type OlxCardFragment = {
  index: number;
  href: string | null;
  textSample: string;
  outerHtmlSample: string;
};

export type OlxNetworkCaptureMeta = {
  url: string;
  status: number;
  contentType: string;
  matchedOffersApi: boolean;
  bodyBytes?: number;
  skippedReason?: string;
};

export type OlxCaptureLimits = {
  maxHtmlBytes: number;
  maxScripts: number;
  maxCards: number;
  maxInlinePreviewChars: number;
  maxCardHtmlChars: number;
  maxNetworkMeta: number;
};

export const DEFAULT_OLX_CAPTURE_LIMITS: OlxCaptureLimits = {
  maxHtmlBytes: 2_000_000,
  maxScripts: 80,
  maxCards: 8,
  maxInlinePreviewChars: 240,
  maxCardHtmlChars: 1_200,
  maxNetworkMeta: 40,
};

const ANALYTICS_HOST_RE =
  /(google-analytics|googletagmanager|doubleclick|criteo|newrelic|facebook|hotjar|scorecardresearch|olx-st\.com|ninja\.data\.olxcdn)/i;

export function isAnalyticsUrl(url: string): boolean {
  try {
    return ANALYTICS_HOST_RE.test(new URL(url).hostname);
  } catch {
    return ANALYTICS_HOST_RE.test(url);
  }
}

/** Strip cookies / authorization material from header maps before persistence. */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "cookie" ||
      lower === "set-cookie" ||
      lower === "authorization" ||
      lower === "proxy-authorization" ||
      lower.includes("api-key") ||
      lower.includes("x-api-key")
    ) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function sanitizeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|auth|cookie|session|key|secret|password/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString().slice(0, 400);
  } catch {
    return url.slice(0, 400);
  }
}

export function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return { text, truncated: false, bytes: buf.length };
  }
  return {
    text: buf.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
    bytes: maxBytes,
  };
}

/**
 * Inventory <script> tags from HTML without executing them.
 */
export function inventoryScriptsFromHtml(
  html: string,
  limits: OlxCaptureLimits = DEFAULT_OLX_CAPTURE_LIMITS,
): OlxScriptInventoryItem[] {
  const items: OlxScriptInventoryItem[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(html)) !== null && items.length < limits.maxScripts) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
    const id = /id\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
    const inlineLength = src ? 0 : body.length;
    const item: OlxScriptInventoryItem = {
      index,
      type,
      id,
      src: src ? sanitizeUrlForLog(src) : null,
      inlineLength,
    };
    if (!src && inlineLength > 0) {
      item.inlinePreview = body.replace(/\s+/g, " ").trim().slice(0, limits.maxInlinePreviewChars);
    }
    items.push(item);
    index += 1;
  }
  return items;
}

/**
 * Pull a few listing-card fragments + hrefs from rendered HTML (evidence only).
 */
export function extractCardFragmentsFromHtml(
  html: string,
  limits: OlxCaptureLimits = DEFAULT_OLX_CAPTURE_LIMITS,
): OlxCardFragment[] {
  const cards: OlxCardFragment[] = [];
  const cardRe = /<[^>]+data-cy=["']l-card["'][^>]*>[\s\S]*?(?=<[^>]+data-cy=["']l-card["']|$)/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = cardRe.exec(html)) !== null && cards.length < limits.maxCards) {
    const chunk = match[0] ?? "";
    const href =
      /href=["']([^"']*ID[A-Za-z0-9]+\.html[^"']*)["']/i.exec(chunk)?.[1] ??
      /href=["']([^"']+)["']/i.exec(chunk)?.[1] ??
      null;
    cards.push({
      index,
      href: href ? sanitizeUrlForLog(href) : null,
      textSample: chunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200),
      outerHtmlSample: chunk.slice(0, limits.maxCardHtmlChars),
    });
    index += 1;
  }
  if (cards.length === 0) {
    // Fallback: bare offer links (still not Listings).
    const linkRe = /href=["']([^"']*ID[A-Za-z0-9]+\.html[^"']*)["']/gi;
    while ((match = linkRe.exec(html)) !== null && cards.length < limits.maxCards) {
      const href = match[1] ?? null;
      cards.push({
        index: cards.length,
        href: href ? sanitizeUrlForLog(href) : null,
        textSample: "",
        outerHtmlSample: href ? `<a href="${href}">` : "",
      });
    }
  }
  return cards;
}

export type OlxCategoryCaptureWriteInput = {
  captureDir: string;
  category: "apartments" | "houses";
  commit: string;
  startedAt: string;
  requestedUrl: string;
  finalUrl: string;
  httpStatus?: number;
  mainDocumentHtml?: string;
  renderedHtml?: string;
  scripts: OlxScriptInventoryItem[];
  cards: OlxCardFragment[];
  networkMeta: OlxNetworkCaptureMeta[];
  limits?: OlxCaptureLimits;
};

export type OlxCategoryCapturePaths = {
  categoryDir: string;
  manifestPath: string;
  mainDocumentPath?: string;
  renderedHtmlPath?: string;
  scriptsPath: string;
  cardsPath: string;
  networkMetaPath: string;
};

export function writeOlxCategoryCapture(
  input: OlxCategoryCaptureWriteInput,
): OlxCategoryCapturePaths {
  const limits = input.limits ?? DEFAULT_OLX_CAPTURE_LIMITS;
  const categoryDir = join(input.captureDir, input.category);
  mkdirSync(categoryDir, { recursive: true, mode: 0o700 });

  const paths: OlxCategoryCapturePaths = {
    categoryDir,
    manifestPath: join(categoryDir, "manifest.json"),
    scriptsPath: join(categoryDir, "scripts.json"),
    cardsPath: join(categoryDir, "cards.json"),
    networkMetaPath: join(categoryDir, "network-meta.json"),
  };

  if (input.mainDocumentHtml !== undefined) {
    const clipped = truncateUtf8Bytes(input.mainDocumentHtml, limits.maxHtmlBytes);
    const path = join(categoryDir, "main-document.html");
    writeFileSync(path, clipped.text, { mode: 0o600 });
    paths.mainDocumentPath = path;
  }
  if (input.renderedHtml !== undefined) {
    const clipped = truncateUtf8Bytes(input.renderedHtml, limits.maxHtmlBytes);
    const path = join(categoryDir, "rendered.html");
    writeFileSync(path, clipped.text, { mode: 0o600 });
    paths.renderedHtmlPath = path;
  }

  writeFileSync(paths.scriptsPath, `${JSON.stringify(input.scripts, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(paths.cardsPath, `${JSON.stringify(input.cards, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(paths.networkMetaPath, `${JSON.stringify(input.networkMeta, null, 2)}\n`, {
    mode: 0o600,
  });

  const manifest = {
    category: input.category,
    commit: input.commit,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    requestedUrl: sanitizeUrlForLog(input.requestedUrl),
    finalUrl: sanitizeUrlForLog(input.finalUrl),
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
    artifactPaths: {
      mainDocument: paths.mainDocumentPath ?? null,
      renderedHtml: paths.renderedHtmlPath ?? null,
      scripts: paths.scriptsPath,
      cards: paths.cardsPath,
      networkMeta: paths.networkMetaPath,
    },
    counts: {
      scripts: input.scripts.length,
      cards: input.cards.length,
      networkMeta: input.networkMeta.length,
      mainDocumentBytes: input.mainDocumentHtml
        ? Buffer.byteLength(input.mainDocumentHtml, "utf8")
        : 0,
      renderedHtmlBytes: input.renderedHtml ? Buffer.byteLength(input.renderedHtml, "utf8") : 0,
    },
    limits,
    note: "Diagnostic capture only. Card fragments are not validated Listing objects.",
  };
  writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return paths;
}
