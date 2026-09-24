import { createHash } from "node:crypto";
import { isRieltorChallengeHtml } from "./rieltor-classify.ts";

export type RieltorBlockFingerprint = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  server?: string;
  cfRay?: string;
  via?: string;
  xCache?: string;
  retryAfter?: string;
  contentType?: string;
  contentLength?: string;
  setCookieNames: string[];
  title?: string;
  bodySha256: string;
  challenge: "challenge_html" | "http_status";
};

function header(headers: Record<string, string>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, 180);
}

export function setCookieNames(headers: Record<string, string>): string[] {
  const raw = headers["set-cookie"] ?? headers["Set-Cookie"] ?? "";
  if (!raw) {
    return [];
  }
  const names: string[] = [];
  for (const part of raw.split(/,(?=\s*[^;,]+=)/)) {
    const name = part.trim().split("=", 1)[0]?.trim();
    if (name && !names.includes(name)) {
      names.push(name.slice(0, 80));
    }
  }
  return names;
}

function htmlTitle(bodyText: string): string | undefined {
  const match = bodyText.match(/<title[^>]*>([^<]{0,120})/i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 120) : undefined;
}

/** Structured 403/block diagnostic. Cookie values and the HTML body stay out. */
export function fingerprintRieltorBlock(input: {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}): RieltorBlockFingerprint {
  const body = input.bodyText ?? "";
  const fingerprint: RieltorBlockFingerprint = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    setCookieNames: setCookieNames(input.headers),
    bodySha256: createHash("sha256").update(body).digest("hex"),
    challenge: isRieltorChallengeHtml(body) ? "challenge_html" : "http_status",
  };
  const server = header(input.headers, "server");
  const cfRay = header(input.headers, "cf-ray");
  const via = header(input.headers, "via");
  const xCache = header(input.headers, "x-cache");
  const retryAfter = header(input.headers, "retry-after");
  const contentType = header(input.headers, "content-type");
  const contentLength = header(input.headers, "content-length");
  const title = htmlTitle(body);
  if (server) {
    fingerprint.server = server;
  }
  if (cfRay) {
    fingerprint.cfRay = cfRay;
  }
  if (via) {
    fingerprint.via = via;
  }
  if (xCache) {
    fingerprint.xCache = xCache;
  }
  if (retryAfter) {
    fingerprint.retryAfter = retryAfter;
  }
  if (contentType) {
    fingerprint.contentType = contentType;
  }
  if (contentLength) {
    fingerprint.contentLength = contentLength;
  }
  if (title) {
    fingerprint.title = title;
  }
  return fingerprint;
}
