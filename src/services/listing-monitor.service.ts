import type { Listing } from "../domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../domain/source.ts";
import { getConfig, hasTelegramConfig, type AppConfig } from "../config/env.ts";
import { ConsoleOutput, TelegramOutput, type ListingOutput } from "../outputs/console.output.ts";
import { logger } from "../utils/logger.ts";

export class ListingMonitorService {
  constructor(private readonly adapters: ListingSourceAdapter[]) {}

  async inspectAll(): Promise<SourceFetchResult[]> {
    const settled = await Promise.allSettled(this.adapters.map((adapter) => adapter.inspectLatest()));
    return settled.map((item, index) => {
      const source = this.adapters[index]?.source ?? "unknown";
      if (item.status === "fulfilled") {
        return item.value;
      }
      const message = item.reason instanceof Error ? item.reason.message : String(item.reason);
      logger.error("source.failed", { source, message });
      return {
        listings: [],
        transport: "n/a",
        dataKind: "LIVE DATA" as const,
        rawNotes: [message],
        health: {
          source: this.adapters[index]?.source ?? "olx",
          healthy: false,
          checkedAt: new Date(),
          message,
        },
      };
    });
  }

  async collectNewListings(): Promise<Listing[]> {
    throw new Error(
      "ListingMonitorService.collectNewListings() is disabled. Canonical production poll is src/scripts/test-telegram-poll.ts: durable state, pending outbox, then Telegram. A listing is marked sent only after delivery succeeds.",
    );
  }
}

export function createDefaultOutput(config: AppConfig = getConfig()): ListingOutput {
  if (hasTelegramConfig(config) && config.telegramBotToken && config.telegramChatId) {
    return new TelegramOutput(config.telegramBotToken, config.telegramChatId, config.sourceTimeoutMs);
  }
  return new ConsoleOutput();
}
