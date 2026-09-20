import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  isExactTrue,
  TelegramTestModeError,
  type TelegramTestSink,
} from "../outputs/telegram-test.sink.ts";

export const CANARY_META_KEY = "telegram_canary_sent_at";
export const CANARY_MESSAGE_MARKER = "CANARY — Rent Radar TEST";
export const DEFAULT_CANARY_DATABASE_FILENAME = "rent-radar-canary.sqlite";

export class TelegramCanaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramCanaryError";
  }
}

export type TelegramCanaryEnv = {
  TELEGRAM_TEST_MODE?: string;
  TELEGRAM_CANARY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_DRY_RUN?: string;
  DATABASE_PATH?: string;
  TELEGRAM_CANARY_DATABASE_PATH?: string;
};

export type TelegramCanaryReport = {
  sent: boolean;
  alreadySent: boolean;
  dryRun: boolean;
  chatId: string;
  databasePath: string;
  message: string;
  errorSafe?: string;
};

export function assertTelegramCanaryGuards(env: TelegramCanaryEnv): void {
  if (!isExactTrue(env.TELEGRAM_TEST_MODE)) {
    throw new TelegramTestModeError(
      'TELEGRAM_TEST_MODE must be exactly "true" to run the Telegram canary.',
    );
  }
  if (!isExactTrue(env.TELEGRAM_CANARY)) {
    throw new TelegramCanaryError(
      'TELEGRAM_CANARY must be exactly "true". The canary is off by default and never sends inventory.',
    );
  }
}

export function resolveCanaryDatabasePath(env: TelegramCanaryEnv = {}): string {
  const inventory = env.DATABASE_PATH?.trim() || "./data/rent-radar.sqlite";
  const canary =
    env.TELEGRAM_CANARY_DATABASE_PATH?.trim() || join(dirname(inventory), DEFAULT_CANARY_DATABASE_FILENAME);
  if (canary === inventory) {
    throw new TelegramCanaryError(
      "Canary database must be distinct from DATABASE_PATH so inventory is never touched.",
    );
  }
  return canary;
}

export function formatCanaryMessage(input: { chatId: string; sentAt: Date }): string {
  return [
    `🧪 <b>${CANARY_MESSAGE_MARKER}</b>`,
    "This is a single controlled delivery probe.",
    "It is not a listing and not inventory.",
    `chat_id: ${input.chatId}`,
    `sent_at: ${input.sentAt.toISOString()}`,
  ].join("\n");
}

export function readCanarySentAt(db: DatabaseSync): string | undefined {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(CANARY_META_KEY) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function markCanarySent(db: DatabaseSync, at: Date): void {
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(
    CANARY_META_KEY,
    at.toISOString(),
  );
}

export async function runTelegramCanary(deps: {
  env: TelegramCanaryEnv;
  sink: TelegramTestSink;
  db: DatabaseSync;
  databasePath: string;
  now?: () => Date;
}): Promise<TelegramCanaryReport> {
  assertTelegramCanaryGuards(deps.env);
  const now = deps.now ?? (() => new Date());
  const message = formatCanaryMessage({ chatId: deps.sink.chatId, sentAt: now() });
  const existing = readCanarySentAt(deps.db);
  if (existing) {
    return {
      sent: false,
      alreadySent: true,
      dryRun: deps.sink.dryRun,
      chatId: deps.sink.chatId,
      databasePath: deps.databasePath,
      message,
    };
  }

  const result = await deps.sink.sendText(message);
  if (!result.ok) {
    return {
      sent: false,
      alreadySent: false,
      dryRun: result.dryRun,
      chatId: deps.sink.chatId,
      databasePath: deps.databasePath,
      message,
      ...(result.errorSafe ? { errorSafe: result.errorSafe } : {}),
    };
  }

  markCanarySent(deps.db, now());
  return {
    sent: true,
    alreadySent: false,
    dryRun: result.dryRun,
    chatId: deps.sink.chatId,
    databasePath: deps.databasePath,
    message,
  };
}
