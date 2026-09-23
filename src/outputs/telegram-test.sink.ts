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
  failureReason?: string;
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

const SOURCE_LABEL: Record<Listing["source"], string> = {
  olx: "OLX",
  domria: "DIM.RIA",
  lun: "LUN",
  rieltor: "RIELTOR",
};

const UK_MONTHS = [
  "січня",
  "лютого",
  "березня",
  "квітня",
  "травня",
  "червня",
  "липня",
  "серпня",
  "вересня",
  "жовтня",
  "листопада",
  "грудня",
];

function formatAmount(amount: number): string {
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const [whole, fraction] = String(absolute).split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const body = fraction ? `${grouped},${fraction}` : grouped;
  return negative ? `-${body}` : body;
}

function displayCurrency(currency: string | undefined): string | undefined {
  if (!currency) {
    return undefined;
  }
  const token = currency.trim().toUpperCase();
  if (token === "USD" || token === "$") {
    return "$";
  }
  if (token === "EUR" || token === "€") {
    return "€";
  }
  if (token === "UAH" || token === "ГРН" || token === "GRN") {
    return "грн";
  }
  return currency.trim();
}

export function formatPrice(listing: Listing): string {
  const price = listing.displayPrice ?? listing.price;
  if (!price) {
    return "Ціна не вказана";
  }
  const amount = formatAmount(price.amount);
  const currency = displayCurrency(price.currency);
  const period = price.period === "day" ? "день" : "місяць";
  if (!currency) {
    return `${amount} / ${period}`;
  }
  if (currency === "$" || currency === "€") {
    return `${currency}${amount} / ${period}`;
  }
  return `${amount} ${currency} / ${period}`;
}

export function formatSellerLabel(listing: Listing): string {
  if (listing.sellerType === "owner") {
    return "Власник підтверджений";
  }
  return "Власник не підтверджений";
}

function kyivParts(date: Date): { year: number; month: number; day: number; hour: string; minute: string } {
  const fmt = new Intl.DateTimeFormat("uk-UA", {
    timeZone: KYIV_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour ?? "00",
    minute: parts.minute ?? "00",
  };
}

export function formatClientPublishedAt(date: Date, now = new Date()): string {
  const published = kyivParts(date);
  const current = kyivParts(now);
  const clock = `${published.hour}:${published.minute}`;
  const publishedIndex = published.year * 372 + published.month * 31 + published.day;
  const currentIndex = current.year * 372 + current.month * 31 + current.day;
  if (publishedIndex === currentIndex) {
    return `сьогодні, ${clock}`;
  }
  if (publishedIndex === currentIndex - 1) {
    return `вчора, ${clock}`;
  }
  const month = UK_MONTHS[published.month - 1] ?? "";
  return `${published.day} ${month}, ${clock}`;
}

function propertyHeadline(listing: Listing): string {
  const rooms = listing.rooms !== undefined && Number.isFinite(listing.rooms) ? Math.round(listing.rooms) : undefined;
  if (listing.propertyType === "house") {
    return rooms ? `${rooms}-кімнатний будинок` : "Будинок";
  }
  if (listing.propertyType === "apartment") {
    if (rooms === 1) {
      return "1-кімнатна квартира";
    }
    return rooms ? `${rooms}-кімнатна квартира` : "Квартира";
  }
  return "Оголошення";
}

function propertyFacts(listing: Listing): string | undefined {
  const bits: string[] = [];
  if (listing.areaM2 !== undefined && Number.isFinite(listing.areaM2)) {
    bits.push(`${formatAmount(listing.areaM2)} м²`);
  }
  if (listing.rooms !== undefined && Number.isFinite(listing.rooms)) {
    const rooms = Math.round(listing.rooms);
    bits.push(`${rooms} ${rooms === 1 ? "кімната" : rooms < 5 ? "кімнати" : "кімнат"}`);
  }
  const floor = listing.metadata?.floor;
  const total = listing.metadata?.totalFloors;
  const floorNum = typeof floor === "number" ? floor : undefined;
  const totalNum = typeof total === "number" ? total : undefined;
  if (floorNum !== undefined && totalNum !== undefined) {
    bits.push(`${floorNum}/${totalNum} поверх`);
  } else if (floorNum !== undefined) {
    bits.push(`${floorNum} поверх`);
  }
  return bits.length > 0 ? bits.join(" · ") : undefined;
}

function locationLine(listing: Listing): string {
  const city = listing.location.city?.trim();
  const district = listing.location.district?.trim();
  if (city && district) {
    return `${city}, ${district}`;
  }
  return city || district || listing.location.raw;
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

export function formatListingTelegramHtml(
  listing: Listing,
  _options?: {
    deliveryKind?: ListingDeliveryKindOption;
    observationKind?: ListingDeliveryKindOption;
  },
): string {
  const facts = propertyFacts(listing);
  const published = listing.publishedAt
    ? `Опубліковано: ${formatClientPublishedAt(listing.publishedAt)}`
    : "Опубліковано: дата не вказана";
  const href = escapeHtml(listing.url);
  const html = [
    "🧪 <b>TEST</b>",
    "",
    `🏠 <b>${escapeHtml(propertyHeadline(listing))}</b>`,
    "",
    `💰 <b>${escapeHtml(formatPrice(listing))}</b>`,
    `📍 ${escapeHtml(locationLine(listing))}`,
    ...(facts ? [`📐 ${escapeHtml(facts)}`] : []),
    `👤 ${escapeHtml(formatSellerLabel(listing))}`,
    "",
    `🕒 ${escapeHtml(published)}`,
    `🌐 ${escapeHtml(SOURCE_LABEL[listing.source])}`,
    "",
    `🔗 <a href="${href}">Відкрити оголошення</a>`,
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
  return fitTelegramMessage(
    html.replaceAll(/<a href="([^"]*)">([^<]*)<\/a>/g, "$2 $1").replaceAll(/<\/?b>/g, ""),
  );
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
          ...(chunkResult.failureReason !== undefined
            ? { failureReason: chunkResult.failureReason }
            : {}),
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
    failureReason?: string;
    retryAfterMs?: number;
    parseError?: boolean;
  }> {
    let attempts = 0;
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    let lastClass: TelegramErrorClass | undefined;
    let lastReason: string | undefined;
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
        lastReason = classified.reason;
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
        lastReason = "network";
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
      ...(lastReason !== undefined ? { failureReason: lastReason } : {}),
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
