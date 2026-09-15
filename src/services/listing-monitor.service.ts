import type { Listing } from "../domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../domain/source.ts";
import { getConfig, hasTelegramConfig, type AppConfig } from "../config/env.ts";
import { applyListingFilters } from "../filters/listing-filter.ts";
import { ConsoleOutput, TelegramOutput, type ListingOutput } from "../outputs/console.output.ts";
import { hasSeenListing, saveListing } from "../storage/listing.repository.ts";
import { logger } from "../utils/logger.ts";

export class ListingMonitorService {
  constructor(
    private readonly adapters: ListingSourceAdapter[],
    private readonly config: AppConfig = getConfig(),
    private readonly output: ListingOutput = createDefaultOutput(),
  ) {}

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
    const results = await this.inspectAll();
    const fresh: Listing[] = [];
    for (const result of results) {
      const filtered = applyListingFilters(result.listings, this.config);
      for (const item of filtered) {
        if (!item.locationMatched) {
          continue;
        }
        if (hasSeenListing(item.listing)) {
          continue;
        }
        saveListing(item.listing);
        fresh.push(item.listing);
        await this.output.send(item.listing);
      }
    }
    return fresh;
  }
}

export function createDefaultOutput(config: AppConfig = getConfig()): ListingOutput {
  if (hasTelegramConfig(config) && config.telegramBotToken && config.telegramChatId) {
    return new TelegramOutput(config.telegramBotToken, config.telegramChatId, config.sourceTimeoutMs);
  }
  return new ConsoleOutput();
}
