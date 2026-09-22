import type { DatabaseSync } from "node:sqlite";
import type { SourceHealthWrite } from "../delivery/delivery-ports.ts";

/** One current row per source. Names match FetchResultKind plus transport/browser failures. */
export const SOURCE_HEALTH_STATUSES = [
  "ok",
  "valid_empty",
  "parser_failure",
  "http_error",
  "rate_limited",
  "transport_failure",
  "browser_failure",
  "disabled",
] as const;

export type SourceHealthStatus = (typeof SOURCE_HEALTH_STATUSES)[number];

export type SourceHealthRow = {
  source: string;
  status: SourceHealthStatus;
  checkedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastListingCount: number | null;
  lastHttpStatus: number | null;
  lastErrorSafe: string | null;
  updatedAt: string;
};

const PLAYWRIGHT_TRANSPORT = "stock_playwright_chromium";

const HTML_DOCUMENT = /<!doctype\b|<html\b|<head\b|<body\b/i;

type PreviousHealth = {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
};

export function isHealthySourceStatus(status: SourceHealthStatus): boolean {
  return status === "ok" || status === "valid_empty";
}

export function isFailureSourceStatus(status: SourceHealthStatus): boolean {
  return (
    status === "parser_failure" ||
    status === "http_error" ||
    status === "rate_limited" ||
    status === "transport_failure" ||
    status === "browser_failure"
  );
}

/**
 * Map a poll attempt onto the durable status.
 * parser_failure is returned before any empty/ok fallback.
 * HTTP 429 is rate_limited even when the attempt was labeled transport_blocked.
 */
export function normalizeSourceHealthStatus(input: SourceHealthWrite): SourceHealthStatus {
  const kind = input.resultKind ?? "";
  if (kind === "parser_failure") {
    return "parser_failure";
  }
  if (kind === "parser_failed") {
    return input.source === "olx" && input.transport === PLAYWRIGHT_TRANSPORT
      ? "browser_failure"
      : "transport_failure";
  }
  if (kind === "browser_failure") {
    return "browser_failure";
  }
  if (kind === "disabled") {
    return "disabled";
  }
  if (kind === "rate_limited" || input.httpStatus === 429) {
    return "rate_limited";
  }
  if (kind === "valid_empty") {
    return "valid_empty";
  }
  if (kind === "ok") {
    return (input.listingCount ?? 0) > 0 ? "ok" : "parser_failure";
  }
  if (kind === "http_error") {
    return "http_error";
  }
  if (kind === "transport_failure" || kind === "transport_blocked") {
    return "transport_failure";
  }
  if (input.transport === PLAYWRIGHT_TRANSPORT) {
    return "browser_failure";
  }
  if (input.httpStatus !== undefined && input.httpStatus >= 400) {
    return "http_error";
  }
  return "transport_failure";
}

/** Short, secret-free text. HTML documents are replaced with the status name. */
export function safeStoredError(input: string | undefined, status: string): string | null {
  if (!input) {
    return null;
  }
  const collapsed = input.split("\u0000").join("").replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return null;
  }
  if (HTML_DOCUMENT.test(collapsed)) {
    return status.slice(0, 400);
  }
  const redacted = collapsed
    .replace(/api\.telegram\.org\/bot[^\s/]+/gi, "api.telegram.org/bot[redacted]")
    .replace(/\bbot\d{5,}:[A-Za-z0-9_-]{10,}\b/g, "[redacted-bot-token]")
    .replace(/TELEGRAM_BOT_TOKEN=\S+/gi, "TELEGRAM_BOT_TOKEN=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api_key=[^&\s]+/gi, "api_key=redacted");
  return redacted.slice(0, 400);
}

export function readSourceHealth(db: DatabaseSync, source: string): SourceHealthRow | undefined {
  const row = db
    .prepare(
      `SELECT source,
              status,
              checked_at AS checkedAt,
              last_success_at AS lastSuccessAt,
              last_failure_at AS lastFailureAt,
              consecutive_failures AS consecutiveFailures,
              last_listing_count AS lastListingCount,
              last_http_status AS lastHttpStatus,
              last_error_safe AS lastErrorSafe,
              updated_at AS updatedAt
       FROM source_health
       WHERE source = ?`,
    )
    .get(source) as
    | {
        source: string;
        status: string;
        checkedAt: string;
        lastSuccessAt: string | null;
        lastFailureAt: string | null;
        consecutiveFailures: number;
        lastListingCount: number | null;
        lastHttpStatus: number | null;
        lastErrorSafe: string | null;
        updatedAt: string;
      }
    | undefined;
  if (!row) {
    return undefined;
  }
  return {
    source: row.source,
    status: row.status as SourceHealthStatus,
    checkedAt: row.checkedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    consecutiveFailures: Number(row.consecutiveFailures),
    lastListingCount: row.lastListingCount === null ? null : Number(row.lastListingCount),
    lastHttpStatus: row.lastHttpStatus === null ? null : Number(row.lastHttpStatus),
    lastErrorSafe: row.lastErrorSafe,
    updatedAt: row.updatedAt,
  };
}

export function writeSourceHealth(
  db: DatabaseSync,
  input: SourceHealthWrite,
  at = new Date(),
): SourceHealthRow {
  const status = normalizeSourceHealthStatus(input);
  const checkedAt = at.toISOString();
  const listingCount = input.listingCount === undefined ? null : input.listingCount;
  const httpStatus = input.httpStatus === undefined ? null : input.httpStatus;
  const errorSafe = isFailureSourceStatus(status) ? safeStoredError(input.errorSafe, status) : null;

  db.exec("BEGIN IMMEDIATE;");
  try {
    const previous = db
      .prepare(
        `SELECT last_success_at AS lastSuccessAt,
                last_failure_at AS lastFailureAt,
                consecutive_failures AS consecutiveFailures
         FROM source_health
         WHERE source = ?`,
      )
      .get(input.source) as PreviousHealth | undefined;
    let consecutive = previous ? Number(previous.consecutiveFailures) : 0;
    let lastSuccess = previous?.lastSuccessAt ?? null;
    let lastFailure = previous?.lastFailureAt ?? null;
    if (isHealthySourceStatus(status)) {
      consecutive = 0;
      lastSuccess = checkedAt;
    } else if (isFailureSourceStatus(status)) {
      consecutive += 1;
      lastFailure = checkedAt;
    }
    db.prepare(
      `INSERT INTO source_health (
         source, status, checked_at, last_success_at, last_failure_at,
         consecutive_failures, last_listing_count, last_http_status, last_error_safe, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         status = excluded.status,
         checked_at = excluded.checked_at,
         last_success_at = excluded.last_success_at,
         last_failure_at = excluded.last_failure_at,
         consecutive_failures = excluded.consecutive_failures,
         last_listing_count = excluded.last_listing_count,
         last_http_status = excluded.last_http_status,
         last_error_safe = excluded.last_error_safe,
         updated_at = excluded.updated_at`,
    ).run(
      input.source,
      status,
      checkedAt,
      lastSuccess,
      lastFailure,
      consecutive,
      listingCount,
      httpStatus,
      errorSafe,
      checkedAt,
    );
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  }

  const written = readSourceHealth(db, input.source);
  if (!written) {
    throw new Error(`source health row missing after write for ${input.source}`);
  }
  return written;
}
