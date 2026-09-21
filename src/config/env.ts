import { z } from "zod";
import type { PropertyType } from "../domain/listing.ts";
import type { SellerPolicy } from "../filters/owner-filter.ts";

const optionalString = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.string().optional(),
);

const booleanFromEnv = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") {
      return fallback;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const lowered = value.toLowerCase();
      if (lowered === "true" || lowered === "1") {
        return true;
      }
      if (lowered === "false" || lowered === "0") {
        return false;
      }
    }
    return value;
  }, z.boolean());

const optionalPositiveInt = z.preprocess((value) => {
  if (value === "" || value === undefined || value === null) {
    return undefined;
  }
  return value;
}, z.coerce.number().int().positive().optional());

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TARGET_CITY: z.string().default("Lviv"),
  TARGET_LAT: z.coerce.number().default(49.8397),
  TARGET_LNG: z.coerce.number().default(24.0297),
  TARGET_RADIUS_KM: z.coerce.number().positive().default(15),
  GEO_UNKNOWN_POLICY: z.enum(["exclude", "include"]).default("exclude"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(120),
  LUN_POLL_INTERVAL_SECONDS: optionalPositiveInt,
  DOMRIA_POLL_INTERVAL_SECONDS: optionalPositiveInt,
  SOURCE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  SOURCE_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  SOURCE_FAILURES_BEFORE_UNHEALTHY: z.coerce.number().int().positive().default(3),
  ENABLE_DOMRIA: booleanFromEnv(true),
  ENABLE_LUN: booleanFromEnv(true),
  ENABLE_OLX: booleanFromEnv(false),
  ENABLE_OLX_BROWSER: booleanFromEnv(false),
  ENABLE_RIELTOR: booleanFromEnv(true),
  OWNER_ONLY: booleanFromEnv(true),
  OWNER_ACCEPT_SELF_DECLARED: booleanFromEnv(false),
  /**
   * Approved default: reject confirmed intermediaries, keep unknown/self-declared.
   * OWNER_ONLY=true does not restore the old gate unless this is owner_only.
   */
  SELLER_POLICY: z.enum(["reject_intermediaries", "owner_only"]).default("reject_intermediaries"),
  PROPERTY_TYPES: z.string().default("apartment,house"),
  MAX_LISTING_AGE_MINUTES: optionalPositiveInt,
  DOMRIA_API_KEY: optionalString,
  DOMRIA_USE_PUBLIC_HTML_FALLBACK: booleanFromEnv(true),
  DOMRIA_MAX_INFO_PER_POLL: z.coerce.number().int().min(0).max(20).default(2),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  ADMIN_TELEGRAM_CHAT_ID: optionalString,
  DATABASE_PATH: z.string().default("./data/rent-radar.sqlite"),
  FIRST_RUN_MODE: z.enum(["seed", "preview", "send"]).default("seed"),
  TELEGRAM_STRICT_NEW_PUBLICATIONS: booleanFromEnv(true),
  TELEGRAM_INITIAL_PREVIEW_LIMIT: z.coerce.number().int().min(1).max(10).default(3),
  DRY_RUN: booleanFromEnv(false),
});

export type GeoUnknownPolicy = "exclude" | "include";
export type FirstRunMode = "seed" | "preview" | "send";

export type AppConfig = {
  nodeEnv: string;
  logLevel: "debug" | "info" | "warn" | "error";
  targetCity: string;
  targetLat: number;
  targetLng: number;
  targetRadiusKm: number;
  geoUnknownPolicy: GeoUnknownPolicy;
  pollIntervalSeconds: number;
  lunPollIntervalSeconds: number;
  domriaPollIntervalSeconds: number;
  sourceTimeoutMs: number;
  sourceMaxRetries: number;
  sourceFailuresBeforeUnhealthy: number;
  enableDomria: boolean;
  enableLun: boolean;
  enableOlx: boolean;
  /** When true, Telegram/collection uses Playwright extract and never the blocked OLX HTTP API. */
  enableOlxBrowser: boolean;
  enableRieltor: boolean;
  ownerOnly: boolean;
  /** Opt-in for the legacy owner_only policy only. Ignored by reject_intermediaries. */
  ownerAcceptSelfDeclared: boolean;
  /**
   * Default reject_intermediaries. OWNER_ONLY=true cannot silently restore owner_only.
   */
  sellerPolicy: SellerPolicy;
  propertyTypes: PropertyType[];
  maxListingAgeMinutes?: number;
  domriaApiKey?: string;
  domriaUsePublicHtmlFallback: boolean;
  domriaMaxInfoPerPoll: number;
  telegramBotToken?: string;
  telegramChatId?: string;
  adminTelegramChatId?: string;
  databasePath: string;
  firstRunMode: FirstRunMode;
  telegramStrictNewPublications: boolean;
  telegramInitialPreviewLimit: number;
  dryRun: boolean;
};

let cached: AppConfig | undefined;

function parsePropertyTypes(raw: string): PropertyType[] {
  const allowed: PropertyType[] = ["apartment", "house"];
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is PropertyType => allowed.includes(item as PropertyType));
  if (values.length === 0) {
    throw new Error("PROPERTY_TYPES must include apartment and/or house");
  }
  return [...new Set(values)];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const lunPoll = parsed.LUN_POLL_INTERVAL_SECONDS ?? parsed.POLL_INTERVAL_SECONDS;
  const officialDomria = Boolean(parsed.DOMRIA_API_KEY);
  const domriaPoll =
    parsed.DOMRIA_POLL_INTERVAL_SECONDS ?? (officialDomria ? 10_800 : Math.max(parsed.POLL_INTERVAL_SECONDS, 300));

  const config: AppConfig = {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    targetCity: parsed.TARGET_CITY,
    targetLat: parsed.TARGET_LAT,
    targetLng: parsed.TARGET_LNG,
    targetRadiusKm: parsed.TARGET_RADIUS_KM,
    geoUnknownPolicy: parsed.GEO_UNKNOWN_POLICY,
    pollIntervalSeconds: parsed.POLL_INTERVAL_SECONDS,
    lunPollIntervalSeconds: lunPoll,
    domriaPollIntervalSeconds: domriaPoll,
    sourceTimeoutMs: parsed.SOURCE_TIMEOUT_MS,
    sourceMaxRetries: parsed.SOURCE_MAX_RETRIES,
    sourceFailuresBeforeUnhealthy: parsed.SOURCE_FAILURES_BEFORE_UNHEALTHY,
    enableDomria: parsed.ENABLE_DOMRIA,
    enableLun: parsed.ENABLE_LUN,
    enableOlx: parsed.ENABLE_OLX,
    enableOlxBrowser: parsed.ENABLE_OLX_BROWSER,
    enableRieltor: parsed.ENABLE_RIELTOR,
    ownerOnly: parsed.OWNER_ONLY,
    ownerAcceptSelfDeclared: parsed.OWNER_ACCEPT_SELF_DECLARED,
    sellerPolicy: parsed.SELLER_POLICY,
    propertyTypes: parsePropertyTypes(parsed.PROPERTY_TYPES),
    domriaUsePublicHtmlFallback: parsed.DOMRIA_USE_PUBLIC_HTML_FALLBACK,
    domriaMaxInfoPerPoll: parsed.DOMRIA_MAX_INFO_PER_POLL,
    databasePath: parsed.DATABASE_PATH,
    firstRunMode: parsed.FIRST_RUN_MODE,
    telegramStrictNewPublications: parsed.TELEGRAM_STRICT_NEW_PUBLICATIONS,
    telegramInitialPreviewLimit: parsed.TELEGRAM_INITIAL_PREVIEW_LIMIT,
    dryRun: parsed.DRY_RUN,
  };
  if (parsed.MAX_LISTING_AGE_MINUTES) {
    config.maxListingAgeMinutes = parsed.MAX_LISTING_AGE_MINUTES;
  }
  if (parsed.DOMRIA_API_KEY) {
    config.domriaApiKey = parsed.DOMRIA_API_KEY;
  }
  if (parsed.TELEGRAM_BOT_TOKEN) {
    config.telegramBotToken = parsed.TELEGRAM_BOT_TOKEN;
  }
  if (parsed.TELEGRAM_CHAT_ID) {
    config.telegramChatId = parsed.TELEGRAM_CHAT_ID;
  }
  if (parsed.ADMIN_TELEGRAM_CHAT_ID) {
    config.adminTelegramChatId = parsed.ADMIN_TELEGRAM_CHAT_ID;
  }
  return config;
}

export function getConfig(): AppConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}

export function hasTelegramConfig(config: AppConfig = getConfig()): boolean {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}

/** Owner-only catalog query. False under the approved default, even if OWNER_ONLY=true. */
export function usesOwnerOnlySourceFilter(config: Pick<AppConfig, "sellerPolicy" | "ownerOnly">): boolean {
  return config.sellerPolicy === "owner_only" && config.ownerOnly;
}

export function estimateDomriaMonthlyRequests(config: AppConfig = getConfig()): {
  searchesPerPoll: number;
  infoPerPoll: number;
  pollsPerDay: number;
  requestsPerDay: number;
  requestsPerMonth: number;
  freeTierHourlyLimit: number;
  freeTierMonthlyLimit: number;
  compatibleWithFreeTier: boolean;
  note: string;
} {
  const searchesPerPoll = 2;
  const infoPerPoll = config.domriaMaxInfoPerPoll;
  const pollsPerDay = 86_400 / config.domriaPollIntervalSeconds;
  const requestsPerDay = (searchesPerPoll + infoPerPoll) * pollsPerDay;
  const requestsPerMonth = requestsPerDay * 30;
  const compatible = requestsPerMonth <= 1000 && (searchesPerPoll + infoPerPoll) * (3600 / config.domriaPollIntervalSeconds) <= 30;
  return {
    searchesPerPoll,
    infoPerPoll,
    pollsPerDay,
    requestsPerDay,
    requestsPerMonth,
    freeTierHourlyLimit: 30,
    freeTierMonthlyLimit: 1000,
    compatibleWithFreeTier: compatible,
    note: officialNote(config, compatible, requestsPerMonth),
  };
}

function officialNote(config: AppConfig, compatible: boolean, monthly: number): string {
  if (!config.domriaApiKey) {
    return "Official API is unused until DOMRIA_API_KEY is set. HTML fallback does not consume developers.ria.com quota.";
  }
  if (compatible) {
    return `Estimated ${Math.round(monthly)} official API requests/month at DOMRIA_POLL_INTERVAL_SECONDS=${config.domriaPollIntervalSeconds}.`;
  }
  return `INCOMPATIBLE with free DIM.RIA quota (~1000/month, 30/hour). Estimated ${Math.round(monthly)} requests/month at ${config.domriaPollIntervalSeconds}s interval with ${config.domriaMaxInfoPerPoll} info calls/poll. Increase DOMRIA_POLL_INTERVAL_SECONDS.`;
}
