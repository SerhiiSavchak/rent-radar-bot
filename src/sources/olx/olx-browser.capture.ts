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

export type OlxByteClipRecord = {
  originalBytes: number;
  savedBytes: number;
  truncated: boolean;
};

export type OlxCaptureLimits = {
  /** Diagnostic HTML dump cap (not the production parser input cap). */
  maxHtmlBytes: number;
  maxScripts: number;
  maxCards: number;
  maxInlinePreviewChars: number;
  maxCardHtmlChars: number;
  maxNetworkMeta: number;
  /** Bounded complete ads/state JSON saved beside clipped HTML. */
  maxRelevantStateBytes: number;
};

export const DEFAULT_OLX_CAPTURE_LIMITS: OlxCaptureLimits = {
  maxHtmlBytes: 2_000_000,
  maxScripts: 80,
  maxCards: 8,
  maxInlinePreviewChars: 240,
  maxCardHtmlChars: 1_200,
  maxNetworkMeta: 40,
  maxRelevantStateBytes: 4_000_000,
};

/** Production parser may read the full navigation body up to this size. */
export const OLX_PARSER_MAX_HTML_BYTES = 8_000_000;

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

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return re.exec(attrs)?.[1] ?? null;
}

/**
 * Inventory <script> tags from HTML without executing them.
 * Uses indexOf scans (not nested [\s\S]*? regex) so large documents cannot stall the deadline.
 */
export function inventoryScriptsFromHtml(
  html: string,
  limits: OlxCaptureLimits = DEFAULT_OLX_CAPTURE_LIMITS,
): OlxScriptInventoryItem[] {
  const items: OlxScriptInventoryItem[] = [];
  const scan = html.length > 1_500_000 ? html.slice(0, 1_500_000) : html;
  let cursor = 0;
  let index = 0;
  while (items.length < limits.maxScripts) {
    const open = scan.indexOf("<script", cursor);
    if (open < 0) {
      break;
    }
    const tagEnd = scan.indexOf(">", open + 7);
    if (tagEnd < 0) {
      break;
    }
    const attrs = scan.slice(open + 7, tagEnd);
    const type = attrValue(attrs, "type");
    const id = attrValue(attrs, "id");
    const srcRaw = attrValue(attrs, "src");
    let body = "";
    let next = tagEnd + 1;
    if (!attrs.trimEnd().endsWith("/")) {
      const close = scan.indexOf("</script>", tagEnd + 1);
      if (close < 0) {
        break;
      }
      body = scan.slice(tagEnd + 1, close);
      next = close + 9;
    }
    const src = srcRaw ? sanitizeUrlForLog(srcRaw) : null;
    const inlineLength = src ? 0 : body.length;
    const item: OlxScriptInventoryItem = {
      index,
      type,
      id,
      src,
      inlineLength,
    };
    if (!src && inlineLength > 0) {
      item.inlinePreview = body.replace(/\s+/g, " ").trim().slice(0, limits.maxInlinePreviewChars);
    }
    items.push(item);
    index += 1;
    cursor = next;
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
  /** Complete evidenced ads/state JSON (parser-relevant), independent of HTML dump caps. */
  relevantStateJson?: string;
  scripts: OlxScriptInventoryItem[];
  cards: OlxCardFragment[];
  networkMeta: OlxNetworkCaptureMeta[];
  limits?: OlxCaptureLimits;
  skippedReason?: string;
};

export type OlxCategoryCapturePaths = {
  categoryDir: string;
  manifestPath: string;
  mainDocumentPath?: string;
  renderedHtmlPath?: string;
  relevantStatePath?: string;
  scriptsPath: string;
  cardsPath: string;
  networkMetaPath: string;
  truncation?: {
    mainDocument: OlxByteClipRecord;
    renderedHtml: OlxByteClipRecord;
    relevantState: OlxByteClipRecord;
  };
};

function clipRecord(text: string | undefined, maxBytes: number): {
  text?: string;
  record: OlxByteClipRecord;
} {
  if (text === undefined) {
    return { record: { originalBytes: 0, savedBytes: 0, truncated: false } };
  }
  const originalBytes = Buffer.byteLength(text, "utf8");
  const clipped = truncateUtf8Bytes(text, maxBytes);
  return {
    text: clipped.text,
    record: {
      originalBytes,
      savedBytes: clipped.bytes,
      truncated: clipped.truncated,
    },
  };
}

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

  const mainClip = clipRecord(input.mainDocumentHtml, limits.maxHtmlBytes);
  const renderedClip = clipRecord(input.renderedHtml, limits.maxHtmlBytes);
  const stateClip = clipRecord(input.relevantStateJson, limits.maxRelevantStateBytes);

  if (mainClip.text !== undefined) {
    const path = join(categoryDir, "main-document.html");
    writeFileSync(path, mainClip.text, { mode: 0o600 });
    paths.mainDocumentPath = path;
  }
  if (renderedClip.text !== undefined) {
    const path = join(categoryDir, "rendered.html");
    writeFileSync(path, renderedClip.text, { mode: 0o600 });
    paths.renderedHtmlPath = path;
  }
  if (stateClip.text !== undefined) {
    const path = join(categoryDir, "relevant-state.json");
    writeFileSync(path, stateClip.text, { mode: 0o600 });
    paths.relevantStatePath = path;
  }
  paths.truncation = {
    mainDocument: mainClip.record,
    renderedHtml: renderedClip.record,
    relevantState: stateClip.record,
  };

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
    ...(input.skippedReason ? { skippedReason: input.skippedReason } : {}),
    artifactPaths: {
      mainDocument: paths.mainDocumentPath ?? null,
      renderedHtml: paths.renderedHtmlPath ?? null,
      relevantState: paths.relevantStatePath ?? null,
      scripts: paths.scriptsPath,
      cards: paths.cardsPath,
      networkMeta: paths.networkMetaPath,
    },
    truncation: paths.truncation,
    counts: {
      scripts: input.scripts.length,
      cards: input.cards.length,
      networkMeta: input.networkMeta.length,
      mainDocumentBytes: mainClip.record.originalBytes,
      renderedHtmlBytes: renderedClip.record.originalBytes,
      relevantStateBytes: stateClip.record.originalBytes,
    },
    limits: {
      ...limits,
      parserMaxHtmlBytes: OLX_PARSER_MAX_HTML_BYTES,
      note: "maxHtmlBytes is the diagnostic dump cap; parserMaxHtmlBytes is production parser input.",
    },
    note: "Diagnostic capture only. Card fragments are not validated Listing objects.",
  };
  writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return paths;
}
