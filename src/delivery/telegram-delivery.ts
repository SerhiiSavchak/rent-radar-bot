export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TRANSIENT_BACKOFF_BASE_MS = 2 * 60 * 1000;
export const TRANSIENT_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
/** In-process 429 wait. Longer Retry-After is persisted instead of blocking the poll. */
export const IN_PROCESS_RETRY_AFTER_CAP_MS = 3_000;

export type TelegramErrorClass = "transient" | "permanent" | "operator_action";

export const TELEGRAM_PAUSE_UNTIL_KEY = "telegram_delivery_pause_until";
export const TELEGRAM_PAUSE_REASON_KEY = "telegram_delivery_pause_reason";
export const TELEGRAM_PAUSE_FAILURES_KEY = "telegram_delivery_pause_failures";
export const CHANNEL_PAUSE_BASE_MS = 10 * 60 * 1000;
export const CHANNEL_PAUSE_CAP_MS = 6 * 60 * 60 * 1000;

export type TelegramFailureClass = {
  errorClass: TelegramErrorClass;
  parseError: boolean;
  reason: string;
};

export function readTelegramRetryAfterMs(
  headerValue: string | null,
  body: string,
): number | undefined {
  const header = headerValue === null ? Number.NaN : Number(headerValue);
  if (Number.isFinite(header) && header >= 0) {
    return Math.round(header * 1000);
  }
  try {
    const parsed = JSON.parse(body) as { parameters?: { retry_after?: unknown } };
    const seconds = parsed.parameters?.retry_after;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function classifyTelegramFailure(
  status: number | undefined,
  body: string,
): TelegramFailureClass {
  if (status === undefined) {
    return { errorClass: "transient", parseError: false, reason: "network" };
  }
  if (status === 429 || status >= 500) {
    return { errorClass: "transient", parseError: false, reason: `HTTP ${status}` };
  }
  const text = body.toLowerCase();
  if (
    status === 400 &&
    (text.includes("can't parse") || text.includes("cant parse") || text.includes("parse entities"))
  ) {
    return { errorClass: "transient", parseError: true, reason: "parse_entities" };
  }
  if (status === 401) {
    return { errorClass: "operator_action", parseError: false, reason: "unauthorized" };
  }
  if (status === 403) {
    return { errorClass: "operator_action", parseError: false, reason: "forbidden" };
  }
  if (status === 400 && text.includes("chat not found")) {
    return { errorClass: "operator_action", parseError: false, reason: "chat_not_found" };
  }
  if (status >= 400 && status < 500) {
    return { errorClass: "permanent", parseError: false, reason: `HTTP ${status}` };
  }
  return { errorClass: "transient", parseError: false, reason: "unknown" };
}

/** Channel outage pause: 10m, 20m, 40m, … capped at 6h. failureCount starts at 1. */
export function channelPauseDelayMs(failureCount: number): number {
  const exponent = Math.min(8, Math.max(0, failureCount - 1));
  return Math.min(CHANNEL_PAUSE_CAP_MS, CHANNEL_PAUSE_BASE_MS * 2 ** exponent);
}

/** Conservative delay. attemptCount is the count already stored after claimForSend. */
export function transientNextDelayMs(attemptCount: number, retryAfterMs = 0): number {
  const exponent = Math.min(8, Math.max(0, attemptCount - 1));
  const exponential = Math.min(TRANSIENT_BACKOFF_CAP_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** exponent);
  return Math.max(exponential, retryAfterMs);
}

/** Keep the last line (the listing URL) inside Telegram's sendMessage limit. */
export function fitTelegramMessage(text: string, maxLen = TELEGRAM_MESSAGE_LIMIT): string {
  if (text.length <= maxLen) {
    return text;
  }
  const parts = text.split("\n");
  const tail = parts[parts.length - 1] ?? "";
  const head = parts.slice(0, -1).join("\n");
  const room = maxLen - tail.length - 1;
  if (room < 1) {
    return tail.slice(0, maxLen);
  }
  const clipped = head.slice(0, Math.max(0, room - 1)).trimEnd();
  return `${clipped}…\n${tail}`;
}
