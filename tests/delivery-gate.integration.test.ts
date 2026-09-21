import { describe, expect, it, vi } from "vitest";
import { createCollectionAdapters } from "../src/collection/create-source-adapters.ts";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { InMemoryListingDedupe } from "../src/delivery/listing-dedupe-memory.ts";
import { InMemorySourceBaseline } from "../src/delivery/source-baseline-memory.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { formatSellerLabel } from "../src/outputs/telegram-test.sink.ts";
import {
  emptyOlxBrowserExtractResult,
  mapOlxBrowserExtractToFetchResult,
  OLX_BROWSER_TRANSPORT,
  OlxBrowserSource,
} from "../src/sources/olx/olx-browser.source.ts";
import { OlxSource } from "../src/sources/olx/olx.source.ts";

function gateConfig(extra: Record<string, string> = {}) {
  resetConfigCache();
  return loadConfig({
    OWNER_ONLY: "true",
    OWNER_ACCEPT_SELF_DECLARED: "false",
    ENABLE_DOMRIA: "true",
    ENABLE_LUN: "true",
    ENABLE_OLX: "false",
    ENABLE_OLX_BROWSER: "true",
    ENABLE_RIELTOR: "true",
    PROPERTY_TYPES: "apartment,house",
    TARGET_LAT: "49.8397",
    TARGET_LNG: "24.0297",
    TARGET_RADIUS_KM: "15",
    GEO_UNKNOWN_POLICY: "include",
    FIRST_RUN_MODE: "seed",
    TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
    ...extra,
  });
}

function listing(overrides: Partial<Listing> & Pick<Listing, "source" | "sourceId" | "url">): Listing {
  return {
    title: "Оренда",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: new Date("2026-09-19T20:00:00.000Z"),
    ...overrides,
  };
}

function sourceResult(
  source: Listing["source"],
  listings: Listing[],
  extra: Partial<SourceFetchResult> = {},
): SourceFetchResult {
  const resultKind = extra.resultKind ?? (listings.length > 0 ? "ok" : "valid_empty");
  return {
    listings,
    transport: extra.transport ?? "http",
    dataKind: "LIVE DATA",
    resultKind,
    httpStatus: extra.httpStatus ?? 200,
    rawNotes: extra.rawNotes ?? [],
    health: {
      source,
      healthy: resultKind === "ok" || resultKind === "valid_empty",
      checkedAt: new Date(),
      resultKind,
      httpStatus: extra.httpStatus ?? 200,
      transport: extra.transport ?? "http",
      ...(extra.health?.message ? { message: extra.health.message } : {}),
    },
    ...extra,
  };
}

function stubAdapter(
  source: Listing["source"],
  inspect: () => Promise<SourceFetchResult>,
): ListingSourceAdapter {
  return {
    source,
    fetchLatest: async () => (await inspect()).listings,
    inspectLatest: inspect,
    healthCheck: async () => ({ source, healthy: true, checkedAt: new Date() }),
  };
}

function dryRunSink(fetchImpl: typeof fetch) {
  return new TelegramTestSink({
    botToken: "123:dry-run-token-not-real",
    chatId: "424242",
    testMode: true,
    dryRun: true,
    timeoutMs: 1000,
    maxRetries: 0,
    fetchImpl,
  });
}

describe("collection adapter wiring", () => {
  it("defaults keep ENABLE_OLX and ENABLE_OLX_BROWSER off", () => {
    const config = loadConfig({});
    expect(config.enableOlx).toBe(false);
    expect(config.enableOlxBrowser).toBe(false);
    expect(createCollectionAdapters(config).some((adapter) => adapter.source === "olx")).toBe(false);
  });

  it("uses the browser adapter and omits OLX HTTP when browser mode is on", () => {
    const httpInspect = vi.fn();
    const adapters = createCollectionAdapters(gateConfig(), {
      olxBrowser: new OlxBrowserSource({
        extract: async () => emptyOlxBrowserExtractResult({ extractionOk: true, listings: [] }),
      }),
      olxHttp: stubAdapter("olx", async () => {
        httpInspect();
        return sourceResult("olx", [], { httpStatus: 403, resultKind: "http_error", transport: "HTTP HTML" });
      }),
    });
    expect(adapters.filter((adapter) => adapter.source === "olx")).toHaveLength(1);
    expect(adapters.find((adapter) => adapter.source === "olx")).toBeInstanceOf(OlxBrowserSource);
    expect(httpInspect).not.toHaveBeenCalled();
  });

  it("keeps the HTTP adapter only when browser mode is off and ENABLE_OLX is true", () => {
    const adapters = createCollectionAdapters(
      gateConfig({ ENABLE_OLX: "true", ENABLE_OLX_BROWSER: "false" }),
      { olxHttp: new OlxSource() },
    );
    expect(adapters.find((adapter) => adapter.source === "olx")).toBeInstanceOf(OlxSource);
  });
});

describe("OLX browser result mapping", () => {
  it("does not report HTTP 403 as a browser catalog success", () => {
    const mapped = mapOlxBrowserExtractToFetchResult(
      emptyOlxBrowserExtractResult({
        extractionOk: false,
        accessibilityOk: false,
        apartments: {
          ...emptyOlxBrowserExtractResult().apartments,
          httpStatus: 403,
        },
      }),
      { startedMs: Date.now() },
    );
    expect(mapped.resultKind).toBe("http_error");
    expect(mapped.health.healthy).toBe(false);
    expect(mapped.httpStatus).toBe(403);
    expect(mapped.transport).toBe(OLX_BROWSER_TRANSPORT);
    expect(mapped.health.message).toContain("transport_blocked");
    expect(mapped.rawNotes?.some((note) => note.includes("no_http_api_fallback=true"))).toBe(true);
  });
});

describe("end-to-end delivery gate", () => {
  const olxOwner = listing({
    source: "olx",
    sourceId: "olx-owner-1",
    url: "https://www.olx.ua/d/uk/obyavlenie/owner-ID11aaaa.html",
    title: "Квартира від власника (платформа)",
    sellerType: "owner",
    publishedAt: new Date("2026-09-18T10:00:00.000Z"),
    metadata: { ownerEvidenceLevel: "platform_confirmed" },
  });
  const olxBusiness = listing({
    source: "olx",
    sourceId: "olx-biz-1",
    url: "https://www.olx.ua/d/uk/obyavlenie/biz-ID11bbbb.html",
    title: "Бізнес",
    sellerType: "business",
    metadata: { ownerEvidenceLevel: "intermediary" },
  });
  const olxSelfDeclared = listing({
    source: "olx",
    sourceId: "olx-self-1",
    url: "https://www.olx.ua/d/uk/obyavlenie/self-ID11cccc.html",
    title: "Від власника",
    sellerType: "unknown",
    metadata: { ownerEvidenceLevel: "self_declared" },
  });
  const rieltorOwner = listing({
    source: "rieltor",
    sourceId: "13043370",
    url: "https://rieltor.ua/lvov/flats-rent/view/13043370/",
    title: "Зелена вул., 10",
    sellerType: "owner",
    sellerEvidence: ["platform seller type = owner", "Власник"],
    metadata: { ownerEvidenceLevel: "platform_confirmed" },
  });
  const rieltorOwnerNoDate = listing({
    source: "rieltor",
    sourceId: "13043371",
    url: "https://rieltor.ua/lvov/flats-rent/view/13043371/",
    title: "Без дати",
    sellerType: "owner",
    metadata: { ownerEvidenceLevel: "platform_confirmed" },
  });
  const lunOwner = listing({
    source: "lun",
    sourceId: "lun-1",
    url: "https://lun.ua/uk/realty/1",
    sellerType: "owner",
    publishedAt: new Date("2026-09-18T11:00:00.000Z"),
  });
  const domriaOwner = listing({
    source: "domria",
    sourceId: "domria-1",
    url: "https://dom.ria.com/uk/realty/1.html",
    sellerType: "owner",
    publishedAt: new Date("2026-09-18T12:00:00.000Z"),
  });

  it("runs a four-source Telegram dry-run: collector, filters, dedupe, seed baseline, no real send", async () => {
    const httpOlxInspect = vi.fn();
    const telegramFetch = vi.fn(async () => {
      throw new Error("Telegram HTTP must not run in dry-run");
    });
    const inspectCalls: string[] = [];

    const config = gateConfig();
    const adapters = createCollectionAdapters(config, {
      domria: stubAdapter("domria", async () => {
        inspectCalls.push("domria");
        return sourceResult("domria", [domriaOwner]);
      }),
      lun: stubAdapter("lun", async () => {
        inspectCalls.push("lun");
        return sourceResult("lun", [lunOwner]);
      }),
      rieltor: stubAdapter("rieltor", async () => {
        inspectCalls.push("rieltor");
        return sourceResult("rieltor", [rieltorOwner, rieltorOwnerNoDate], {
          transport: "public HTML catalog cards + optional JSON-LD",
          rawNotes: [
            "https://rieltor.ua/lvov/flats-rent/?f-owners=1 -> 200",
            "apartment p1 kind=ok declared=4 cards=4 validated=4",
            "https://rieltor.ua/lvov/houses-rent/?f-owners=1 -> 200",
            "house p1 kind=valid_empty declared=0 cards=0 validated=0",
          ],
        });
      }),
      olxBrowser: new OlxBrowserSource({
        extract: async () => {
          inspectCalls.push("olx-browser");
          return emptyOlxBrowserExtractResult({
            extractionOk: true,
            accessibilityOk: true,
            listings: [olxOwner, olxBusiness, olxSelfDeclared],
            apartments: {
              ...emptyOlxBrowserExtractResult().apartments,
              accessibility: "browser_accessible",
              accessibilityOk: true,
              validatedListingCount: 3,
              listings: [olxOwner, olxBusiness, olxSelfDeclared],
              httpStatus: 200,
              htmlInputKind: "main_document",
              extractSource: "prerendered_state",
            },
          });
        },
      }),
      olxHttp: stubAdapter("olx", async () => {
        httpOlxInspect();
        return sourceResult("olx", [], {
          httpStatus: 403,
          resultKind: "http_error",
          transport: "HTTP HTML",
        });
      }),
    });

    expect(adapters.map((adapter) => adapter.source).sort()).toEqual(["domria", "lun", "olx", "rieltor"]);
    expect(adapters.find((adapter) => adapter.source === "olx")).toBeInstanceOf(OlxBrowserSource);

    const sink = dryRunSink(telegramFetch as unknown as typeof fetch);
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const now = () => new Date("2026-09-19T21:00:00.000Z");

    const seed = await runTelegramTestCycle(
      { adapters, config, sink, dedupe, baseline, now, firstRunMode: "seed" },
      1,
    );

    expect(inspectCalls.sort()).toEqual(["domria", "lun", "olx-browser", "rieltor"]);
    expect(httpOlxInspect).not.toHaveBeenCalled();
    expect(telegramFetch).not.toHaveBeenCalled();
    const formatted = await sink.sendText("dry-run four-source gate");
    expect(formatted.dryRun).toBe(true);
    expect(formatted.ok).toBe(true);
    expect(seed.sentOk).toBe(0);
    expect(sink.chatId).toBe("424242");
    expect(seed.deliveryMode).toBe("inventory_seed");
    expect(seed.hasSourceFailures).toBe(false);
    expect(seed.sourceAttempts.every((attempt) => attempt.enabled && attempt.ok)).toBe(true);

    const olxAttempt = seed.sourceAttempts.find((attempt) => attempt.source === "olx");
    expect(olxAttempt?.listingCount).toBe(3);
    expect(olxAttempt?.transport).toBe(OLX_BROWSER_TRANSPORT);
    expect(olxAttempt?.capability).toContain("no HTTP api/v1/offers fallback");
    expect(olxAttempt?.resultKind).toBe("ok");

    const rieltorAttempt = seed.sourceAttempts.find((attempt) => attempt.source === "rieltor");
    expect(rieltorAttempt?.resultKind).toBe("ok");
    expect(rieltorAttempt?.listingCount).toBe(2);

    expect(dedupe.hasSeen(olxOwner)).toBe(true);
    expect(dedupe.hasSeen(rieltorOwner)).toBe(true);
    expect(dedupe.hasSeen(olxBusiness)).toBe(false);
    expect(dedupe.hasSeen(olxSelfDeclared)).toBe(false);
    expect(formatSellerLabel(olxSelfDeclared)).toContain("Самозаява");
    expect(formatSellerLabel(rieltorOwner)).toContain("за позначкою майданчика");

    const replay = await runTelegramTestCycle(
      { adapters, config, sink, dedupe, baseline, now, firstRunMode: "seed" },
      2,
    );
    expect(replay.sentOk).toBe(0);
    expect(replay.newAfterDedupe).toBe(0);
    expect(replay.hasSourceFailures).toBe(false);
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("reports OLX HTTP 403 as transport_blocked, not browser success", async () => {
    const config = gateConfig({ ENABLE_OLX: "true", ENABLE_OLX_BROWSER: "false" });
    const adapters = createCollectionAdapters(config, {
      domria: stubAdapter("domria", async () => sourceResult("domria", [domriaOwner])),
      lun: stubAdapter("lun", async () => sourceResult("lun", [lunOwner])),
      rieltor: stubAdapter("rieltor", async () => sourceResult("rieltor", [])),
      olxHttp: stubAdapter("olx", async () =>
        sourceResult("olx", [], {
          httpStatus: 403,
          resultKind: "http_error",
          transport: "HTTP HTML",
          health: {
            source: "olx",
            healthy: false,
            checkedAt: new Date(),
            resultKind: "http_error",
            httpStatus: 403,
            transport: "HTTP HTML",
            message: "OLX CloudFront/WAF returned 403",
          },
        }),
      ),
    });
    expect(adapters.find((adapter) => adapter.source === "olx")).not.toBeInstanceOf(OlxBrowserSource);

    const report = await runTelegramTestCycle({
      adapters,
      config,
      sink: dryRunSink(vi.fn() as unknown as typeof fetch),
      dedupe: new InMemoryListingDedupe(),
      baseline: new InMemorySourceBaseline(),
      firstRunMode: "seed",
    });
    const olx = report.sourceAttempts.find((attempt) => attempt.source === "olx");
    expect(olx?.ok).toBe(false);
    expect(olx?.resultKind).toBe("transport_blocked");
    expect(olx?.transport).not.toBe(OLX_BROWSER_TRANSPORT);
    expect(olx?.capability).toContain("http_adapter_only");
    expect(report.hasSourceFailures).toBe(true);
  });

  it("keeps an empty RIELTOR house category from failing a cycle with apartment owners", async () => {
    const config = gateConfig({ ENABLE_OLX_BROWSER: "false" });
    const adapters = createCollectionAdapters(config, {
      domria: stubAdapter("domria", async () => sourceResult("domria", [domriaOwner])),
      lun: stubAdapter("lun", async () => sourceResult("lun", [lunOwner])),
      rieltor: stubAdapter("rieltor", async () =>
        sourceResult("rieltor", [rieltorOwner], {
          resultKind: "ok",
          rawNotes: ["house p1 kind=valid_empty declared=0 cards=0 validated=0"],
        }),
      ),
    });
    const report = await runTelegramTestCycle({
      adapters,
      config,
      sink: dryRunSink(vi.fn() as unknown as typeof fetch),
      dedupe: new InMemoryListingDedupe(),
      baseline: new InMemorySourceBaseline(),
      firstRunMode: "seed",
    });
    expect(report.sourceAttempts.find((attempt) => attempt.source === "rieltor")?.ok).toBe(true);
    expect(report.hasSourceFailures).toBe(false);
    expect(report.sourceAttempts.some((attempt) => attempt.source === "olx")).toBe(false);
  });

  it("does not send a later RIELTOR owner that still lacks publishedAt under the strict freshness gate", async () => {
    const config = gateConfig({ ENABLE_OLX_BROWSER: "false", ENABLE_DOMRIA: "false", ENABLE_LUN: "false" });
    let rieltorListings = [rieltorOwner];
    const adapters = createCollectionAdapters(config, {
      rieltor: stubAdapter("rieltor", async () => sourceResult("rieltor", rieltorListings)),
    });
    const sink = dryRunSink(vi.fn() as unknown as typeof fetch);
    const dedupe = new InMemoryListingDedupe();
    const baseline = new InMemorySourceBaseline();
    const t0 = new Date("2026-09-19T21:00:00.000Z");
    const t1 = new Date("2026-09-19T22:00:00.000Z");

    const seed = await runTelegramTestCycle({
      adapters,
      config,
      sink,
      dedupe,
      baseline,
      now: () => t0,
      firstRunMode: "seed",
    });
    expect(seed.sentOk).toBe(0);
    expect(seed.deliveryMode).toBe("inventory_seed");

    rieltorListings = [rieltorOwner, rieltorOwnerNoDate];
    const next = await runTelegramTestCycle({
      adapters,
      config,
      sink,
      dedupe,
      baseline,
      now: () => t1,
      firstRunMode: "seed",
    });
    expect(next.sentOk).toBe(0);
    expect(next.suppressedUnknownStrict).toBe(1);
    expect(next.hasSourceFailures).toBe(false);
  });
});
