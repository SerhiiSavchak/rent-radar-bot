import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import {
  assessAgainstKnown,
  confirmedIntermediaryRelation,
} from "../src/delivery/cross-source-dedup.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import { readProvenance } from "../src/domain/provenance.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import { sellerAssessmentFromListing } from "../src/filters/owner-filter.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { parseLunCard } from "../src/sources/lun/lun.parser.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

function listing(
  overrides: Partial<Listing> & Pick<Listing, "source" | "sourceId" | "url">,
): Listing {
  return {
    title: "Квартира",
    location: {
      raw: "Львів",
      city: "Львів",
      latitude: 49.84,
      longitude: 24.03,
    },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: new Date("2026-09-20T09:30:00Z"),
    publishedAt: new Date("2026-09-20T09:00:00Z"),
    ...overrides,
  };
}

function lunPointingAt(
  urlRaw: string,
  sourceId: string,
  extra: Record<string, unknown> = {},
): Listing {
  return listing({
    source: "lun",
    sourceId,
    url: `https://lun.ua/uk/realty/${sourceId}`,
    metadata: {
      originalUrl: urlRaw,
      aggregatedSite: new URL(urlRaw).hostname.replace(/^www\./, ""),
      ownerEvidenceLevel: "private_unknown",
      ...extra,
    },
  });
}

describe("cross-source identity", () => {
  afterEach(() => {
    closeDb();
  });

  it("keeps same source and same id as an exact duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "rent-radar-xs-"));
    const db = getDb(join(dir, "same.sqlite"));
    const store = new DurableDeliveryStore(db);
    const first = listing({
      source: "lun",
      sourceId: "1",
      url: "https://lun.ua/uk/realty/1?utm=1",
    });
    expect(store.hasSeen(first)).toBe(false);
    store.markSeen(first);
    expect(
      store.hasSeen(listing({ source: "lun", sourceId: "1", url: "https://lun.ua/uk/realty/1" })),
    ).toBe(true);
    const again = assessAgainstKnown(first, [first]);
    expect(again.suppress).toBe(false);
  });

  it("confirms LUN urlRaw and a direct OLX listing as one identity, in either order", () => {
    const olx = listing({
      source: "olx",
      sourceId: "934944232",
      url: "https://www.olx.ua/d/obyavlenie/orenda-kvartiry-ID11gWHG.html",
      sellerType: "unknown",
      metadata: { olxIsBusiness: true, ownerEvidenceLevel: "private_unknown" },
    });
    const lun = lunPointingAt(
      "https://www.olx.ua/d/uk/obyavlenie/orenda-kvartiry-ID11gWHG.html?utm_source=lun",
      "4721",
    );
    const provenance = readProvenance(lun);
    expect(provenance.externalSourceName).toBe("olx");
    expect(provenance.externalListingId).toBe("11gWHG");
    expect(provenance.platformSiteName).toBe("olx.ua");
    const lunSecond = assessAgainstKnown(lun, [olx]);
    const olxSecond = assessAgainstKnown(olx, [lun]);
    expect(lunSecond.verdict).toBe("confirmed_duplicate");
    expect(lunSecond.suppress).toBe(true);
    expect(lunSecond.reasons).toContain("explicit_external_listing_id");
    expect(olxSecond.suppress).toBe(true);
    expect(olxSecond.match?.source).toBe("lun");
  });

  it("confirms LUN urlRaw and a direct RIELTOR listing as one identity", () => {
    const rieltor = listing({
      source: "rieltor",
      sourceId: "555",
      url: "https://rieltor.ua/lvov/flats-rent/view/555/",
      sellerType: "unknown",
    });
    const lun = lunPointingAt("https://rieltor.ua/lvov/flats-rent/view/555/?utm=1", "880");
    const provenance = readProvenance(lun);
    expect(provenance.externalSourceName).toBe("rieltor");
    expect(provenance.externalListingId).toBe("555");
    const decision = assessAgainstKnown(rieltor, [lun]);
    expect(decision.verdict).toBe("confirmed_duplicate");
    expect(decision.suppress).toBe(true);
    expect(decision.reasons).toContain("explicit_external_listing_id");
  });

  it("does not map a LUN groupId onto an unrelated external id", () => {
    const olx = listing({
      source: "olx",
      sourceId: "934944232",
      url: "https://www.olx.ua/d/obyavlenie/other-ID11gZZZ.html",
    });
    const lun = lunPointingAt("https://lun.ua/uk/realty/100", "100", {
      lunGroupId: "934944232",
      similarPageIds: ["934944232"],
      hasDuplicates: true,
    });
    const decision = assessAgainstKnown(lun, [olx]);
    expect(decision.verdict).toBe("unique");
    expect(decision.suppress).toBe(false);
  });

  it("does not collapse two LUN cards that only share similarPageIds", () => {
    const left = lunPointingAt("https://lun.ua/uk/realty/201", "201", {
      lunGroupId: "group-a",
      similarPageIds: ["202"],
      hasDuplicates: true,
    });
    const right = lunPointingAt("https://lun.ua/uk/realty/202", "202", {
      lunGroupId: "group-b",
      similarPageIds: ["201"],
      hasDuplicates: true,
    });
    expect(assessAgainstKnown(right, [left]).suppress).toBe(false);
  });

  it("confirms two LUN cards that share groupId and does not export that id", () => {
    const left = lunPointingAt("https://olx.ua/d/obyavlenie/a-IDaaa111.html", "301", {
      lunGroupId: "grp-9",
    });
    const right = lunPointingAt("https://olx.ua/d/obyavlenie/b-IDbbb222.html", "302", {
      lunGroupId: "grp-9",
    });
    const decision = assessAgainstKnown(right, [left]);
    expect(decision.verdict).toBe("confirmed_duplicate");
    expect(decision.reasons).toContain("lun_group_id");
    expect(decision.suppress).toBe(true);
  });

  it("does not suppress similar apartments in the same building", () => {
    const shared = {
      rooms: 2,
      areaM2: 60,
      price: { amount: 20_000, currency: "UAH", period: "month" as const },
      location: { raw: "вул. Зелена 10", city: "Львів", latitude: 49.822, longitude: 24.045 },
      title: "2-кімнатна на Зеленій",
      description: "Оренда квартири від власника, поруч парк",
    };
    const domria = listing({
      source: "domria",
      sourceId: "34690408",
      url: "https://dom.ria.com/uk/realty-dolgosrochnaya-arenda-kvartira-34690408.html",
      ...shared,
    });
    const olx = listing({
      source: "olx",
      sourceId: "777",
      url: "https://www.olx.ua/d/obyavlenie/zelena-ID11gABC.html",
      ...shared,
    });
    const decision = assessAgainstKnown(olx, [domria]);
    expect(decision.verdict).toBe("possible_duplicate");
    expect(confirmedIntermediaryRelation({ ...domria, sellerType: "agent" }, [olx])).toBeUndefined();
    expect(decision.suppress).toBe(false);
    expect(decision.reasons).toContain("attribute_overlap_not_sufficient");
  });

  it("does not suppress on rooms, area, and price alone or on identical text", () => {
    const left = listing({
      source: "domria",
      sourceId: "1",
      url: "https://dom.ria.com/uk/realty-1.html",
      rooms: 2,
      areaM2: 60,
      price: { amount: 20_000, currency: "UAH", period: "month" },
      title: "Оренда 2 кімнат",
      description: "Та сама квартира, той самий текст оголошення",
    });
    const right = listing({
      source: "olx",
      sourceId: "2",
      url: "https://www.olx.ua/d/obyavlenie/insha-IDzzz999.html",
      rooms: 2,
      areaM2: 60,
      price: { amount: 20_000, currency: "UAH", period: "month" },
      title: "Оренда 2 кімнат",
      description: "Та сама квартира, той самий текст оголошення",
      location: { raw: "інший район", city: "Львів", latitude: 49.9, longitude: 24.1 },
    });
    const decision = assessAgainstKnown(right, [left]);
    expect(decision.suppress).toBe(false);
    expect(decision.verdict).not.toBe("confirmed_duplicate");
  });

  it("does not treat a LUN card that points at rieltor.ua as an intermediary", () => {
    const parsed = parseLunCard(
      {
        id: 100,
        urlRaw: "https://rieltor.ua/lvov/flats-rent/view/555/",
        price: 12000,
        currency: "uah",
        isOwner: false,
        sectionId: 2,
        header: "Тест",
        location: [24.03, 49.84],
        site: { internalName: "rieltor.ua", displayName: "rieltor.ua" },
      },
      undefined,
    );
    expect(parsed?.sellerType).toBe("unknown");
    const assessment = sellerAssessmentFromListing(parsed!);
    expect(assessment.state).toBe("unknown");
    expect(assessment.send).toBe(true);
    expect(readProvenance(parsed!).externalSourceName).toBe("rieltor");
  });
});

describe("cross-source delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-xs-pipe-"));
  let fileIndex = 0;

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `case-${fileIndex}.sqlite`);
  }

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function configFor(flags: Record<string, string>) {
    resetConfigCache();
    return loadConfig({
      OWNER_ONLY: "true",
      SELLER_POLICY: "reject_intermediaries",
      ENABLE_DOMRIA: "false",
      ENABLE_LUN: "false",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: "false",
      ENABLE_RIELTOR: "false",
      PROPERTY_TYPES: "apartment,house",
      TARGET_LAT: "49.8397",
      TARGET_LNG: "24.0297",
      TARGET_RADIUS_KM: "15",
      GEO_UNKNOWN_POLICY: "include",
      FIRST_RUN_MODE: "seed",
      TELEGRAM_STRICT_NEW_PUBLICATIONS: "true",
      MAX_LISTING_AGE_MINUTES: String(7 * 24 * 60),
      ...flags,
    });
  }

  function adapter(source: Listing["source"], getListings: () => Listing[]): ListingSourceAdapter {
    return {
      source,
      fetchLatest: async () => getListings(),
      inspectLatest: async (): Promise<SourceFetchResult> => {
        const listings = getListings();
        return {
          listings,
          transport: "test",
          dataKind: "MOCK DATA",
          resultKind: listings.length > 0 ? "ok" : "valid_empty",
          httpStatus: 200,
          health: { source, healthy: true, checkedAt: new Date(), message: "ok" },
        };
      },
      healthCheck: async () => ({ source, healthy: true, checkedAt: new Date() }),
    };
  }

  function sink(sendListing: TelegramTestSink["sendListing"]): TelegramTestSink {
    return {
      chatId: "1",
      dryRun: false,
      sendListing,
      sendText: async () => ({ ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 }),
    } as unknown as TelegramTestSink;
  }

  const published = new Date("2026-09-20T09:00:00Z");
  const seededAt = new Date("2026-09-20T08:00:00Z");
  const now = new Date("2026-09-20T10:00:00Z");

  function linkedPair(): { lun: Listing; olx: Listing } {
    return {
      lun: lunPointingAt(
        "https://www.olx.ua/d/uk/obyavlenie/orenda-ID11gWHG.html?utm_campaign=x",
        "5001",
      ),
      olx: listing({
        source: "olx",
        sourceId: "934944232",
        url: "https://www.olx.ua/d/obyavlenie/orenda-ID11gWHG.html",
        publishedAt: published,
        sellerType: "unknown",
        metadata: { olxIsBusiness: true, ownerEvidenceLevel: "private_unknown" },
      }),
    };
  }

  it("sends one of a linked pair in the same cycle and keeps the identity after reopen", async () => {
    const path = dbPath();
    const { lun, olx } = linkedPair();
    const sendListing = vi.fn(async () => ({
      ok: true,
      dryRun: true,
      attempts: 0,
      chatId: "1",
      messageCount: 1,
    }));
    const config = configFor({ ENABLE_LUN: "true", ENABLE_OLX: "true" });
    const first = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("olx", () => olxBatch)];
    await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: sink(sendListing),
        dedupe: first,
        baseline: first,
        outbox: first,
        now: () => seededAt,
        firstRunMode: "seed",
      },
      1,
    );
    lunBatch.push(lun);
    olxBatch.push(olx);
    const report = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: sink(sendListing),
        dedupe: first,
        baseline: first,
        outbox: first,
        now: () => now,
      },
      2,
    );
    expect(report.sentOk).toBe(1);
    expect(report.suppressedCrossSourceDuplicate).toBe(1);
    expect(sendListing).toHaveBeenCalledTimes(1);
    expect(sendListing).toHaveBeenCalledWith(
      expect.objectContaining({ source: "lun", sourceId: "5001" }),
      expect.anything(),
    );
    closeDb();

    const reopened = new DurableDeliveryStore(getDb(path));
    const again = await runTelegramTestCycle(
      {
        adapters: [adapter("olx", () => [olx]), adapter("lun", () => [lun])],
        config,
        sink: sink(sendListing),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => now,
      },
      2,
    );
    expect(again.sentOk).toBe(0);
    expect(reopened.assessCrossSource(olx).suppress).toBe(true);
    expect(sendListing).toHaveBeenCalledTimes(1);
  });

  it("keeps the discovered listing retryable when Telegram fails and does not also send the twin", async () => {
    const path = dbPath();
    const { lun, olx } = linkedPair();
    let calls = 0;
    const sendListing = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          dryRun: false,
          attempts: 1,
          chatId: "1",
          messageCount: 0,
          errorSafe: "telegram 503",
        };
      }
      return { ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 };
    });
    const config = configFor({ ENABLE_LUN: "true", ENABLE_OLX: "true" });
    const store = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("olx", () => olxBatch)];
    await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: sink(async () => ({
          ok: true,
          dryRun: true,
          attempts: 0,
          chatId: "1",
          messageCount: 1,
        })),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
      },
      1,
    );
    lunBatch.push(lun);
    olxBatch.push(olx);
    const deps = {
      adapters,
      config,
      sink: sink(sendListing),
      dedupe: store,
      baseline: store,
      outbox: store,
      now: () => now,
    };
    const failed = await runTelegramTestCycle(deps, 2);
    expect(failed.sentOk).toBe(0);
    expect(failed.sentFailed).toBe(1);
    expect(failed.suppressedCrossSourceDuplicate).toBe(1);
    expect(store.hasSeen(lun)).toBe(false);
    const recovered = await runTelegramTestCycle(
      { ...deps, now: () => new Date(now.getTime() + 3 * 60 * 1000) },
      2,
    );
    expect(recovered.sentOk).toBe(1);
    expect(recovered.sentFailed).toBe(0);
    expect(sendListing).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ source: "lun" }),
      expect.anything(),
    );
    expect(sendListing).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ source: "lun" }),
      expect.anything(),
    );
    const replay = await runTelegramTestCycle(deps, 3);
    expect(replay.sentOk).toBe(0);
    expect(sendListing).toHaveBeenCalledTimes(2);
  });

  it("does not flood a linked historical pair on the first run", async () => {
    const path = dbPath();
    const { lun, olx } = linkedPair();
    const sendListing = vi.fn(async () => ({
      ok: true,
      dryRun: true,
      attempts: 0,
      chatId: "1",
      messageCount: 1,
    }));
    const config = configFor({ ENABLE_LUN: "true", ENABLE_OLX: "true" });
    const store = new DurableDeliveryStore(getDb(path));
    const seed = await runTelegramTestCycle(
      {
        adapters: [adapter("lun", () => [lun]), adapter("olx", () => [olx])],
        config,
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        firstRunMode: "seed",
      },
      1,
    );
    expect(seed.sentOk).toBe(0);
    expect(seed.deliveryMode).toBe("inventory_seed");
    expect(sendListing).not.toHaveBeenCalled();
    const next = await runTelegramTestCycle(
      {
        adapters: [adapter("lun", () => [lun]), adapter("olx", () => [olx])],
        config,
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
      },
      2,
    );
    expect(next.sentOk).toBe(0);
    expect(sendListing).not.toHaveBeenCalled();
  });

  function countRows(sql: string, ...args: string[]): number {
    const row = getDb()
      .prepare(sql)
      .get(...args) as { n: number };
    return Number(row.n);
  }

  it("does not persist a suppressing identity before the keeper is queued", () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const { lun, olx } = linkedPair();
    store.markSeen(lun);
    expect(
      countRows(
        "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source = ? AND source_id = ?",
        "lun",
        "5001",
      ),
    ).toBe(0);
    expect(store.assessCrossSource(olx).suppress).toBe(false);

    const queued = store.enqueueIfNew(lun, "new_publication");
    expect(queued.duplicate).toBe(false);
    expect(
      countRows(
        "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source = ? AND source_id = ?",
        "lun",
        "5001",
      ),
    ).toBe(1);
    expect(
      countRows(
        "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source = ? AND source_id = ?",
        "lun",
        "5001",
      ),
    ).toBeGreaterThan(0);
    expect(
      countRows(
        `SELECT COUNT(*) AS n FROM cross_source_identities i
         WHERE NOT EXISTS (
           SELECT 1 FROM telegram_outbox o WHERE o.source = i.source AND o.source_id = i.source_id
         )`,
      ),
    ).toBe(0);
    expect(store.assessCrossSource(olx).suppress).toBe(true);
  });

  it("sends a fresh OLX twin when the linked LUN card is late-discovered", async () => {
    const path = dbPath();
    const { lun, olx } = linkedPair();
    const staleLun: Listing = { ...lun, publishedAt: new Date("2026-09-20T07:00:00Z") };
    const lunBatch: Listing[] = [];
    const olxBatch: Listing[] = [];
    const config = configFor({ ENABLE_LUN: "true", ENABLE_OLX: "true" });
    const store = new DurableDeliveryStore(getDb(path));
    const adapters = [adapter("lun", () => lunBatch), adapter("olx", () => olxBatch)];
    await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: sink(async () => ({
          ok: true,
          dryRun: true,
          attempts: 0,
          chatId: "1",
          messageCount: 1,
        })),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
      },
      1,
    );
    lunBatch.push(staleLun);
    olxBatch.push(olx);
    const observations: Array<{ lunIdentity: number; outbox: number; orphans: number }> = [];
    const sendListing = vi.fn(async (sent: Listing) => {
      observations.push({
        lunIdentity: countRows(
          "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source = ? AND source_id = ?",
          "lun",
          staleLun.sourceId,
        ),
        outbox: countRows(
          "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source = ? AND source_id = ?",
          sent.source,
          sent.sourceId,
        ),
        orphans: countRows(
          `SELECT COUNT(*) AS n FROM cross_source_identities i
           WHERE NOT EXISTS (
             SELECT 1 FROM telegram_outbox o WHERE o.source = i.source AND o.source_id = i.source_id
           )`,
        ),
      });
      return { ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 };
    });
    const report = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
      },
      2,
    );
    expect(report.suppressedLateDiscovered).toBe(1);
    expect(report.suppressedCrossSourceDuplicate).toBe(0);
    expect(report.sentOk).toBe(1);
    expect(sendListing).toHaveBeenCalledTimes(1);
    expect(sendListing).toHaveBeenCalledWith(
      expect.objectContaining({ source: "olx", sourceId: olx.sourceId }),
      expect.anything(),
    );
    expect(observations).toEqual([{ lunIdentity: 0, outbox: 1, orphans: 0 }]);
    expect(store.hasSeen(staleLun)).toBe(true);
    expect(store.assessCrossSource(olx).suppress).toBe(false);
  });

  it("sends a fresh RIELTOR twin discovered after an old linked LUN card", async () => {
    const path = dbPath();
    const rieltor = listing({
      source: "rieltor",
      sourceId: "555",
      url: "https://rieltor.ua/lvov/flats-rent/view/555/",
      publishedAt: published,
      sellerType: "unknown",
    });
    const staleLun: Listing = {
      ...lunPointingAt("https://rieltor.ua/lvov/flats-rent/view/555/?utm=1", "880"),
      publishedAt: new Date("2026-08-01T00:00:00Z"),
    };
    const config = configFor({ ENABLE_LUN: "true", ENABLE_RIELTOR: "true" });
    const store = new DurableDeliveryStore(getDb(path));
    const lunBatch: Listing[] = [];
    const rieltorBatch: Listing[] = [];
    const adapters = [adapter("lun", () => lunBatch), adapter("rieltor", () => rieltorBatch)];
    const idleSink = sink(async () => ({
      ok: true,
      dryRun: true,
      attempts: 0,
      chatId: "1",
      messageCount: 1,
    }));
    await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: idleSink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
      },
      1,
    );
    lunBatch.push(staleLun);
    const staleCycle = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: idleSink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
      },
      2,
    );
    expect(staleCycle.sentOk).toBe(0);
    expect(staleCycle.suppressedOld).toBe(1);
    expect(
      countRows(
        "SELECT COUNT(*) AS n FROM cross_source_identities WHERE source = ? AND source_id = ?",
        "lun",
        "880",
      ),
    ).toBe(0);
    expect(store.assessCrossSource(rieltor).suppress).toBe(false);

    rieltorBatch.push(rieltor);
    const sendListing = vi.fn(async () => ({
      ok: true,
      dryRun: true,
      attempts: 0,
      chatId: "1",
      messageCount: 1,
    }));
    const freshCycle = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
      },
      3,
    );
    expect(freshCycle.sentOk).toBe(1);
    expect(freshCycle.suppressedCrossSourceDuplicate).toBe(0);
    expect(sendListing).toHaveBeenCalledWith(
      expect.objectContaining({ source: "rieltor", sourceId: "555" }),
      expect.anything(),
    );
  });

  function rieltorCopy(
    sourceId: string,
    sellerType: Listing["sellerType"],
  ): Listing {
    return listing({
      source: "rieltor",
      sourceId,
      url: `https://rieltor.ua/lvov/flats-rent/view/${sourceId}/`,
      sellerType,
      metadata: {
        ownerEvidenceLevel: sellerType === "agent" ? "intermediary" : "private_unknown",
        ...(sellerType === "agent" ? { platformRoleLabel: "Рієлтор" } : {}),
      },
    });
  }

  async function deliverPair(lun: Listing, other: Listing, order: Array<Listing["source"]>): Promise<{
    sentOk: number;
    sentSources: string[];
    lunRejected: number;
  }> {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const batches = new Map<string, Listing[]>(order.map((source) => [source, []]));
    const adapters = order.map((source) => adapter(source, () => batches.get(source) ?? []));
    const flags: Record<string, string> = {};
    if (order.includes("lun")) {
      flags.ENABLE_LUN = "true";
    }
    if (order.includes("rieltor")) {
      flags.ENABLE_RIELTOR = "true";
    }
    if (order.includes("olx")) {
      flags.ENABLE_OLX = "true";
    }
    const config = configFor(flags);
    const sentSources: string[] = [];
    const sendListing = vi.fn(async (item: Listing) => {
      sentSources.push(item.source);
      return { ok: true, dryRun: true, attempts: 0, chatId: "1", messageCount: 1 };
    });
    await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => seededAt,
        firstRunMode: "seed",
      },
      1,
    );
    const bySource = new Map<string, Listing>([
      [lun.source, lun],
      [other.source, other],
    ]);
    for (const source of order) {
      const item = bySource.get(source);
      if (item) {
        batches.get(source)?.push(item);
      }
    }
    const report = await runTelegramTestCycle(
      {
        adapters,
        config,
        sink: sink(sendListing),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        rieltorDetailGapMs: 0,
        fetchRieltorDetail: async (url: string) => ({
          status: 200,
          finalUrl: url,
          bodyText: `<div class="offer-view-rieltor-position">Користувач</div>`,
        }),
      },
      2,
    );
    const lunAttempt = report.sourceAttempts.find((attempt) => attempt.source === "lun");
    return {
      sentOk: report.sentOk,
      sentSources,
      lunRejected: lunAttempt?.sellerRejectedIntermediary ?? 0,
    };
  }

  it("drops a LUN copy explicitly linked to a confirmed RIELTOR agent, in either order", async () => {
    const lun = lunPointingAt("https://rieltor.ua/lvov/flats-rent/view/13064424/", "4725463684");
    const agent = rieltorCopy("13064424", "agent");
    expect(confirmedIntermediaryRelation(lun, [agent])?.sourceId).toBe("13064424");
    expect(confirmedIntermediaryRelation(agent, [lun])).toBeUndefined();
    const forward = await deliverPair(lun, agent, ["lun", "rieltor"]);
    const reverse = await deliverPair(lun, agent, ["rieltor", "lun"]);
    expect(forward.sentOk).toBe(0);
    expect(forward.sentSources).not.toContain("lun");
    expect(forward.lunRejected).toBe(1);
    expect(reverse.sentOk).toBe(0);
    expect(reverse.sentSources).not.toContain("lun");
    expect(reverse.lunRejected).toBe(1);
  });

  it("keeps a LUN copy linked to a RIELTOR owner or an unknown RIELTOR listing", async () => {
    const ownerLun = lunPointingAt("https://rieltor.ua/lvov/flats-rent/view/555/", "880");
    const unknownLun = lunPointingAt("https://rieltor.ua/lvov/flats-rent/view/556/", "881");
    expect(confirmedIntermediaryRelation(ownerLun, [rieltorCopy("555", "owner")])).toBeUndefined();
    expect(confirmedIntermediaryRelation(unknownLun, [rieltorCopy("556", "unknown")])).toBeUndefined();
    const ownerDelivery = await deliverPair(ownerLun, rieltorCopy("555", "owner"), ["lun", "rieltor"]);
    const unknownDelivery = await deliverPair(unknownLun, rieltorCopy("556", "unknown"), ["lun", "rieltor"]);
    expect(ownerDelivery.sentSources).toContain("lun");
    expect(ownerDelivery.lunRejected).toBe(0);
    expect(unknownDelivery.sentSources).toContain("lun");
    expect(unknownDelivery.lunRejected).toBe(0);
  });

  it("does not treat OLX isBusiness or a fuzzy similar agent as intermediary evidence", async () => {
    const lun = lunPointingAt("https://www.olx.ua/d/obyavlenie/orenda-ID11gWHG.html", "5001");
    const business = listing({
      source: "olx",
      sourceId: "934944232",
      url: "https://www.olx.ua/d/obyavlenie/orenda-ID11gWHG.html",
      sellerType: "unknown",
      metadata: { olxIsBusiness: true, ownerEvidenceLevel: "private_unknown" },
    });
    expect(confirmedIntermediaryRelation(lun, [business])).toBeUndefined();
    const fuzzyLun = listing({
      source: "lun",
      sourceId: "900",
      url: "https://lun.ua/uk/realty/900",
      rooms: 2,
      areaM2: 60,
      price: { amount: 20_000, currency: "UAH", period: "month" },
    });
    const fuzzyAgent = listing({
      source: "rieltor",
      sourceId: "901",
      url: "https://rieltor.ua/lvov/flats-rent/view/901/",
      sellerType: "agent",
      rooms: 2,
      areaM2: 60,
      price: { amount: 20_000, currency: "UAH", period: "month" },
    });
    expect(confirmedIntermediaryRelation(fuzzyLun, [fuzzyAgent])).toBeUndefined();
    const delivery = await deliverPair(fuzzyLun, fuzzyAgent, ["lun", "rieltor"]);
    expect(delivery.sentSources).toContain("lun");
    expect(delivery.lunRejected).toBe(0);
  });
});
