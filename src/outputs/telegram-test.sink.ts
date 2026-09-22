import {
  classifyTelegramFailure,
  fitTelegramMessage,
  IN_PROCESS_RETRY_AFTER_CAP_MS,
  readTelegramRetryAfterMs,
  type TelegramErrorClass,
} from "../delivery/telegram-delivery.ts";
import type { Listing } from "../domain/listing.ts";

/** Telegram Bot API hard limit for sendMessage text. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export type TelegramTestEnv = {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_TEST_MODE?: string;
  TELEGRAM_DRY_RUN?: string;
};

export type TelegramTestSinkOptions = {
  botToken: string;
  chatId: string;
  /** Must be exactly true — otherwise send is refused. */
  testMode: boolean;
  dryRun: boolean;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type TelegramSendResult = {
  ok: boolean;
  dryRun: boolean;
  status?: number;
  attempts: number;
  chatId: string;
  messageCount: number;
  errorSafe?: string;
  errorClass?: TelegramErrorClass;
  retryAfterMs?: number;
  parseError?: boolean;
  bodies?: string[];
};

export class TelegramTestModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramTestModeError";
  }
}

export function isExactTrue(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Resolve TEST Telegram config. Refuses unless TELEGRAM_TEST_MODE is exactly "true".
 * Does not read any hard-coded chat/token (developer must supply via env).
 */
export function resolveTelegramTestConfig(env: TelegramTestEnv = process.env): {
  botToken: string;
  chatId: string;
  testMode: true;
  dryRun: boolean;
} {
  if (!isExactTrue(env.TELEGRAM_TEST_MODE)) {
    throw new TelegramTestModeError(
      'TELEGRAM_TEST_MODE must be exactly "true" to enable the test Telegram sink. Refusing send.',
    );
  }
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = env.TELEGRAM_CHAT_ID?.trim() ?? "";
  if (!botToken) {
    throw new TelegramTestModeError("TELEGRAM_BOT_TOKEN is required when TELEGRAM_TEST_MODE=true.");
  }
  if (!chatId) {
    throw new TelegramTestModeError("TELEGRAM_CHAT_ID is required when TELEGRAM_TEST_MODE=true.");
  }
  return {
    botToken,
    chatId,
    testMode: true,
    dryRun: isExactTrue(env.TELEGRAM_DRY_RUN),
  };
}

/** Never log raw tokens or full api.telegram.org/bot<token>/... URLs. */
export function redactTelegramSecrets(text: string, botToken?: string): string {
  let out = text;
  if (botToken && botToken.length > 0) {
    out = out.split(botToken).join("[TELEGRAM_BOT_TOKEN_REDACTED]");
  }
  out = out.replace(
    /api\.telegram\.org\/bot[^/\s"']+/gi,
    "api.telegram.org/bot[TELEGRAM_BOT_TOKEN_REDACTED]",
  );
  out = out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot[TELEGRAM_BOT_TOKEN_REDACTED]");
  return out;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatPrice(listing: Listing): string {
  if (!listing.price) {
    return "Ціна не вказана";
  }
  const currency = listing.price.currency?.trim();
  if (!currency) {
    return `${listing.price.amount} (валюта не вказана)`;
  }
  return `${listing.price.amount} ${currency}/${listing.price.period ?? "unknown"}`;
}

export function formatSellerLabel(listing: Listing): string {
  if (listing.metadata?.ownerEvidenceLevel === "self_declared") {
    return "Самозаява «від власника» в тексті — не позначка майданчика";
  }
  if (listing.sellerType === "owner") {
    return "Власник — за позначкою майданчика";
  }
  if (listing.sellerType === "agent") {
    return "Посередник / агент (не власник)";
  }
  if (listing.sellerType === "business") {
    return "Бізнес / забудовник (не власник)";
  }
  return "Власник не підтверджено";
}

export type ListingDeliveryKindOption =
  "initial_preview" | "new_publication" | "first_noticed" | "initial_inventory" | "newly_observed";

/** @deprecated use ListingDeliveryKindOption */
export type ListingObservationKind = ListingDeliveryKindOption;

const KYIV_TZ = "Europe/Kyiv";

export function formatKyivDateTime(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "невідомо";
  }
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: KYIV_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function headlineFor(kind: ListingDeliveryKindOption | undefined): string {
  switch (kind) {
    case "initial_preview":
      return "📋 <b>TEST · Початкова добірка</b>";
    case "first_noticed":
      return "👀 <b>TEST · Вперше помічено</b>";
    case "new_publication":
      return "🆕 <b>TEST · Нова публікація</b>";
    case "initial_inventory":
      return "📋 <b>TEST · Початкова добірка</b>";
    case "newly_observed":
    default:
      return "👀 <b>TEST · Вперше помічено</b>";
  }
}

export function formatListingTelegramHtml(
  listing: Listing,
  options?: {
    deliveryKind?: ListingDeliveryKindOption;
    observationKind?: ListingDeliveryKindOption;
  },
): string {
  const cityArea = [listing.location.city, listing.location.district, listing.location.raw]
    .filter((item): item is string => Boolean(item))
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .join(" · ");
  const kind = options?.deliveryKind ?? options?.observationKind ?? "new_publication";
  const publishedLine = listing.publishedAt
    ? `Опубліковано: ${formatKyivDateTime(listing.publishedAt)} (Київ)`
    : "Опубліковано: невідомо (майданчик не надав дату)";
  const refreshedLine = listing.refreshedAt
    ? `Оновлено на майданчику: ${formatKyivDateTime(listing.refreshedAt)} (Київ)`
    : undefined;
  const firstSeenLine = listing.firstSeenAt
    ? `Вперше помічено ботом: ${formatKyivDateTime(listing.firstSeenAt)} (Київ)`
    : undefined;
  const html = [
    headlineFor(kind),
    "",
    escapeHtml(listing.title),
    "",
    `💰 ${escapeHtml(formatPrice(listing))}`,
    `📍 ${escapeHtml(cityArea || listing.location.raw)}`,
    `👤 ${escapeHtml(formatSellerLabel(listing))}`,
    `🕒 ${escapeHtml(publishedLine)}`,
    ...(refreshedLine ? [`🔄 ${escapeHtml(refreshedLine)}`] : []),
    ...(firstSeenLine ? [`👁 ${escapeHtml(firstSeenLine)}`] : []),
    `📦 ${escapeHtml(listing.source)} · ${escapeHtml(listing.propertyType)}`,
    "",
    escapeHtml(listing.url),
  ].join("\n");
  return fitTelegramMessage(html);
}

export function formatListingTelegramPlain(
  listing: Listing,
  options?: {
    deliveryKind?: ListingDeliveryKindOption;
    observationKind?: ListingDeliveryKindOption;
  },
): string {
  const html = formatListingTelegramHtml(listing, options);
  return fitTelegramMessage(html.replaceAll(/<\/?b>/g, ""));
}

/**
 * Split on newline boundaries when possible; never exceed maxLen per chunk.
 */
export function splitTelegramMessage(text: string, maxLen = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < Math.floor(maxLen * 0.5)) {
      cut = maxLen;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class TelegramTestSink {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TelegramTestSinkOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get chatId(): string {
    return this.options.chatId;
  }

  get dryRun(): boolean {
    return this.options.dryRun;
  }

  assertAllowed(): void {
    if (this.options.testMode !== true) {
      throw new TelegramTestModeError("TelegramTestSink refuses send: testMode is not true.");
    }
  }

  async sendText(text: string): Promise<TelegramSendResult> {
    return this.sendPrepared(text, this.options.chatId, true);
  }

  async sendListing(
    listing: Listing,
    options?: {
      deliveryKind?: ListingDeliveryKindOption;
      observationKind?: ListingDeliveryKindOption;
    },
  ): Promise<TelegramSendResult> {
    const htmlResult = await this.sendText(formatListingTelegramHtml(listing, options));
    if (htmlResult.ok || !htmlResult.parseError) {
      return htmlResult;
    }
    const plain = await this.sendPlainText(formatListingTelegramPlain(listing, options));
    return { ...plain, attempts: htmlResult.attempts + plain.attempts };
  }

  async sendAdminText(chatId: string, text: string): Promise<TelegramSendResult> {
    return this.sendPlainText(fitTelegramMessage(text), chatId);
  }

  private async sendPlainText(
    text: string,
    chatId = this.options.chatId,
  ): Promise<TelegramSendResult> {
    return this.sendPrepared(text, chatId, false);
  }

  private async sendPrepared(
    text: string,
    chatId: string,
    html: boolean,
  ): Promise<TelegramSendResult> {
    this.assertAllowed();
    const chunks = splitTelegramMessage(text);
    if (this.options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        attempts: 0,
        chatId,
        messageCount: chunks.length,
        bodies: chunks,
      };
    }
    let attempts = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      const chunkResult = await this.sendChunk(chunk, chatId, html);
      attempts += chunkResult.attempts;
      if (!chunkResult.ok) {
        return {
          ok: false,
          dryRun: false,
          ...(chunkResult.status !== undefined ? { status: chunkResult.status } : {}),
          attempts,
          chatId,
          messageCount: i,
          ...(chunkResult.errorSafe !== undefined ? { errorSafe: chunkResult.errorSafe } : {}),
          ...(chunkResult.errorClass !== undefined ? { errorClass: chunkResult.errorClass } : {}),
          ...(chunkResult.retryAfterMs !== undefined
            ? { retryAfterMs: chunkResult.retryAfterMs }
            : {}),
          ...(chunkResult.parseError ? { parseError: true } : {}),
        };
      }
    }
    return { ok: true, dryRun: false, attempts, chatId, messageCount: chunks.length };
  }

  private async sendChunk(
    text: string,
    chatId: string,
    html: boolean,
  ): Promise<{
    ok: boolean;
    attempts: number;
    status?: number;
    errorSafe?: string;
    errorClass?: TelegramErrorClass;
    retryAfterMs?: number;
    parseError?: boolean;
  }> {
    let attempts = 0;
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    let lastClass: TelegramErrorClass | undefined;
    let lastRetryAfterMs: number | undefined;
    let lastParseError = false;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      attempts += 1;
      try {
        const url = `https://api.telegram.org/bot${this.options.botToken}/sendMessage`;
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...(html ? { parse_mode: "HTML" as const } : {}),
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        lastStatus = response.status;
        if (response.ok) {
          return { ok: true, attempts, status: response.status };
        }
        const rawBody = await response.text();
        lastError = redactTelegramSecrets(
          `Telegram HTTP ${response.status}: ${rawBody.slice(0, 200)}`,
          this.options.botToken,
        );
        const classified = classifyTelegramFailure(response.status, rawBody);
        lastClass = classified.errorClass;
        lastParseError = classified.parseError;
        if (response.status === 429) {
          const retryAfterMs = readTelegramRetryAfterMs(
            response.headers.get("retry-after"),
            rawBody,
          );
          lastRetryAfterMs = retryAfterMs;
          const shortEnough =
            retryAfterMs !== undefined && retryAfterMs <= IN_PROCESS_RETRY_AFTER_CAP_MS;
          const unspecified = retryAfterMs === undefined;
          if ((shortEnough || unspecified) && attempt < this.options.maxRetries) {
            await this.sleep(shortEnough ? retryAfterMs : Math.min(8_000, 500 * 2 ** attempt));
            continue;
          }
          break;
        }
        if (response.status >= 500 && attempt < this.options.maxRetries) {
          await this.sleep(Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        break;
      } catch (error) {
        lastError = redactTelegramSecrets(
          error instanceof Error ? error.message : String(error),
          this.options.botToken,
        );
        lastClass = "transient";
        lastParseError = false;
        if (attempt < this.options.maxRetries) {
          await this.sleep(Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
      }
    }

    return {
      ok: false,
      attempts,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      ...(lastError !== undefined ? { errorSafe: lastError } : {}),
      ...(lastClass !== undefined ? { errorClass: lastClass } : {}),
      ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
      ...(lastParseError ? { parseError: true } : {}),
    };
  }
}

export function createTelegramTestSinkFromEnv(
  env: TelegramTestEnv = process.env,
  overrides: Partial<TelegramTestSinkOptions> = {},
): TelegramTestSink {
  const resolved = resolveTelegramTestConfig(env);
  return new TelegramTestSink({
    botToken: resolved.botToken,
    chatId: resolved.chatId,
    testMode: true,
    dryRun: resolved.dryRun,
    timeoutMs: overrides.timeoutMs ?? 15_000,
    maxRetries: overrides.maxRetries ?? 2,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
  });
}
