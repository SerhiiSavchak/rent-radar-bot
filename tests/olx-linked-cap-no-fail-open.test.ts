import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config/env.ts";
import { createCycleOlxSellerVerifier } from "../src/delivery/olx-detail-seller.ts";
import type { LinkedSellerDecision } from "../src/delivery/rieltor-detail-seller.ts";
import {
  hasSellerHold,
  resolveDueSellerHolds,
  SELLER_HOLD_MAX_MS,
  sellerVerificationDisposition,
  upsertSellerHold,
} from "../src/delivery/seller-verification-hold.ts";
import { runTelegramTestCycle } from "../src/delivery/telegram-test-pipeline.ts";
import type { Listing } from "../src/domain/listing.ts";
import type { ListingSourceAdapter, SourceFetchResult } from "../src/domain/source.ts";
import type { TelegramTestSink } from "../src/outputs/telegram-test.sink.ts";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";

const now = new Date("2026-09-22T10:00:00.000Z");
const published = new Date("2026-09-22T09:00:00.000Z");

function lun(sourceId: string, token: string): Listing {
  return {
    source: "lun",
    sourceId,
    url: `https://lun.ua/uk/realty/${sourceId}`,
    title: "Квартира",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: published,
    publishedAt: published,
    metadata: {
      originalUrl: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${token}.html`,
      aggregatedSite: "olx.ua",
      ownerEvidenceLevel: "private_unknown",
    },
  };
}

function directOlx(sourceId: string): Listing {
  return {
    source: "olx",
    sourceId,
    url: `https://www.olx.ua/d/uk/obyavlenie/orenda-ID${sourceId}.html`,
    title: "Квартира",
    location: { raw: "Львів", city: "Львів", latitude: 49.84, longitude: 24.03 },
    propertyType: "apartment",
    sellerType: "unknown",
    discoveredAt: published,
    publishedAt: published,
    metadata: { urlToken: sourceId, ownerEvidenceLevel: "private_unknown" },
  };
}

function decision(
  outcome: LinkedSellerDecision["outcome"],
  drop = false,
): LinkedSellerDecision {
  return { outcome, drop, requested: false, externalId: "legacy01", evidence: outcome };
}

function capacityDecision(): LinkedSellerDecision {
  return {
    outcome: "detail_capacity_deferred" as unknown as LinkedSellerDecision["outcome"],
    drop: false,
    requested: false,
    externalId: "cap0001",
    evidence: "OLX linked detail cap 5 reached",
  };
}

function transportRows(path: string, token: string): number {
  const row = getDb(path)
    .prepare(
      `SELECT COUNT(*) AS n FROM external_seller_verifications
       WHERE source = 'olx' AND external_listing_id = ? AND seller_verdict = 'transport_failure'`,
    )
    .get(token) as { n: number };
  return Number(row.n);
}

describe("OLX linked detail capacity is not a transport failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-olx-cap-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `cap-${fileIndex}.sqlite`);
  }

  it("defers when the linked detail request cap is already exhausted", async () => {
    const path = dbPath();
    const db = getDb(path);
    let fetches = 0;
    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      gapMs: 0,
      maxRequests: 0,
      fetchPage: async () => {
        fetches += 1;
        throw new Error("detail fetch must not run");
      },
    });
    const decision = await verify(lun("cap-lun", "cap0001"));
    expect(decision.outcome).toBe("detail_capacity_deferred");
    expect(decision.drop).toBe(false);
    expect(decision.requested).toBe(false);
    expect(decision.evidence).toMatch(/OLX linked detail cap 0 reached/);
    expect(fetches).toBe(0);
    expect(transportRows(path, "cap0001")).toBe(0);
  });

  it("defers a raw 403 when the browser fallback budget is already exhausted", async () => {
    const path = dbPath();
    const db = getDb(path);
    const token = "fb4031";
    let browserCalls = 0;
    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      gapMs: 0,
      maxBrowserFallbacks: 0,
      fetchPage: async (url) => ({
        status: 403,
        finalUrl: url,
        bodyText: "blocked",
      }),
      fetchViaBrowser: async () => {
        browserCalls += 1;
        throw new Error("browser must not run");
      },
    });
    const decision = await verify(lun("fb-lun", token));
    expect(decision.outcome).toBe("detail_capacity_deferred");
    expect(decision.outcome).not.toBe("detail_transport_failure");
    expect(decision.drop).toBe(false);
    expect(decision.evidence).toMatch(/HTTP 403/);
    expect(decision.evidence).toMatch(/browser fallback cap 0 reached/);
    expect(browserCalls).toBe(0);
    expect(transportRows(path, token)).toBe(0);
  });

  it("keeps a real browser failure as detail_transport_failure", async () => {
    const path = dbPath();
    const db = getDb(path);
    const token = "trns01";
    const verify = createCycleOlxSellerVerifier({
      db,
      peers: [],
      now: () => now,
      timeoutMs: 1000,
      gapMs: 0,
      fetchPage: async () => {
        throw new Error("socket hang up");
      },
      fetchViaBrowser: async () => {
        throw new Error("browser launch failed");
      },
    });
    const decision = await verify(lun("tr-lun", token));
    expect(decision.outcome).toBe("detail_transport_failure");
    expect(decision.drop).toBe(false);
    expect(decision.evidence).toMatch(/browser launch failed/);
    expect(transportRows(path, token)).toBe(1);
  });
});

describe("capacity deferral disposition", () => {
  it("defers under both seller policies", () => {
    const decision = capacityDecision();
    expect(sellerVerificationDisposition(decision, "reject_intermediaries")).toBe("defer");
    expect(sellerVerificationDisposition(decision, "owner_only")).toBe("defer");
  });
});

describe("unresolved seller holds fail closed at the deadline", () => {
  afterEach(() => {
    closeDb();
  });

  function openDb() {
    const path = join(mkdtempSync(join(tmpdir(), "rent-radar-hold-closed-")), "h.sqlite");
    return { path, db: getDb(path) };
  }

  it("keeps a capacity-deferred hold before release_at", async () => {
    const { db } = openDb();
    const item = lun("pre-cap", "precap1");
    upsertSellerHold(db, item, "precap1", now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + 60_000),
      async () => capacityDecision(),
      "reject_intermediaries",
    );
    expect(actions).toEqual([{ listing: item, action: "keep" }]);
    expect(hasSellerHold(db, "lun", "pre-cap")).toBe(true);
  });

  it.each([
    "detail_capacity_deferred",
    "detail_transport_failure",
    "detail_rate_limited",
    "detail_parser_failure",
    "skipped_after_rate_limit",
  ] as const)("drops unresolved %s at release_at under reject_intermediaries", async (outcome) => {
    const { db } = openDb();
    const item = lun("exp-ri", "expri01");
    upsertSellerHold(db, item, "expri01", now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + SELLER_HOLD_MAX_MS),
      async () =>
        outcome === "detail_capacity_deferred" ? capacityDecision() : decision(outcome),
      "reject_intermediaries",
    );
    expect(actions).toEqual([{ listing: item, action: "drop" }]);
    expect(actions[0]?.action).not.toBe("send");
    expect(hasSellerHold(db, "lun", "exp-ri")).toBe(false);
  });

  it("drops an unresolved capacity hold at release_at under owner_only", async () => {
    const { db } = openDb();
    const item = lun("exp-oo", "expoo01");
    upsertSellerHold(db, item, "expoo01", now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + SELLER_HOLD_MAX_MS),
      async () => capacityDecision(),
      "owner_only",
    );
    expect(actions).toEqual([{ listing: item, action: "drop" }]);
    expect(hasSellerHold(db, "lun", "exp-oo")).toBe(false);
  });

  it("drops a legacy OLX temporary hold after upgrade once release_at is reached", async () => {
    const { db } = openDb();
    const item = directOlx("legacy01");
    upsertSellerHold(db, item, "legacy01", now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + SELLER_HOLD_MAX_MS),
      async () => decision("detail_transport_failure"),
      "reject_intermediaries",
    );
    expect(actions).toEqual([{ listing: item, action: "drop" }]);
    expect(hasSellerHold(db, "olx", "legacy01")).toBe(false);
  });

  it("still allows evaluated unknown under reject_intermediaries", async () => {
    const { db } = openDb();
    const item = directOlx("unk0001");
    upsertSellerHold(db, item, "unk0001", now, "olx");
    const actions = await resolveDueSellerHolds(
      db,
      new Date(now.getTime() + SELLER_HOLD_MAX_MS),
      async () => decision("detail_unknown"),
      "reject_intermediaries",
    );
    expect(actions).toEqual([{ listing: item, action: "send" }]);
    expect(sellerVerificationDisposition(decision("detail_unknown"), "reject_intermediaries")).toBe(
      "allow",
    );
  });

  it("still rejects a confirmed agent and allows a confirmed owner", async () => {
    const agentDb = openDb();
    const agent = directOlx("agent001");
    upsertSellerHold(agentDb.db, agent, "agent001", now, "olx");
    const dropped = await resolveDueSellerHolds(
      agentDb.db,
      new Date(now.getTime() + 60_000),
      async () => decision("detail_confirmed_agent", true),
      "reject_intermediaries",
    );
    expect(dropped).toEqual([{ listing: agent, action: "drop" }]);

    const ownerDb = openDb();
    const owner = directOlx("owner001");
    upsertSellerHold(ownerDb.db, owner, "owner001", now, "olx");
    const sent = await resolveDueSellerHolds(
      ownerDb.db,
      new Date(now.getTime() + 60_000),
      async () => decision("detail_confirmed_owner"),
      "reject_intermediaries",
    );
    expect(sent).toEqual([{ listing: owner, action: "send" }]);
  });
});

describe("pipeline terminal drop of an unresolved seller hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-olx-hold-pipe-"));
  let fileIndex = 0;

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  function dbPath(): string {
    fileIndex += 1;
    return join(dir, `pipe-${fileIndex}.sqlite`);
  }

  function configFor() {
    resetConfigCache();
    return loadConfig({
      TELEGRAM_TEST_MODE: "true",
      TELEGRAM_BOT_TOKEN: "1:test",
      TELEGRAM_CHAT_ID: "1",
      ENABLE_OLX: "true",
      ENABLE_OLX_BROWSER: "false",
      ENABLE_LUN: "false",
      ENABLE_DOMRIA: "false",
      ENABLE_RIELTOR: "false",
      SELLER_POLICY: "reject_intermediaries",
      FRESHNESS_MAX_PUBLICATION_AGE_MINUTES: "10080",
      GEO_UNKNOWN_POLICY: "include",
    });
  }

  function adapter(listings: () => Listing[]): ListingSourceAdapter {
    return {
      source: "olx",
      fetchLatest: async () => listings(),
      inspectLatest: async (): Promise<SourceFetchResult> => {
        const batch = listings();
        return {
          listings: batch,
          transport: "test",
          dataKind: "MOCK DATA",
          resultKind: batch.length > 0 ? "ok" : "valid_empty",
          httpStatus: 200,
          health: { source: "olx", healthy: true, checkedAt: now, message: "ok" },
        };
      },
      healthCheck: async () => ({ source: "olx", healthy: true, checkedAt: now }),
    };
  }

  function sink(sent: Listing[]): TelegramTestSink {
    return {
      chatId: "1",
      dryRun: false,
      sendListing: async (item: Listing) => {
        sent.push(item);
        return { ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 };
      },
      sendText: async () => ({
        ok: true,
        dryRun: false,
        attempts: 1,
        chatId: "1",
        messageCount: 1,
      }),
    } as unknown as TelegramTestSink;
  }

  const blocked = async () => ({ acquired: false as const });

  async function seed(store: DurableDeliveryStore, adapters: ListingSourceAdapter[]) {
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(published.getTime() - 60_000),
        firstRunMode: "seed",
      },
      1,
    );
  }

  it("marks the listing seen and does not deliver when the hold expires unresolved", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const item = directOlx("pipe0001");
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    await seed(store, adapters);
    batch.push(item);

    const held = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: blocked,
      },
      2,
    );
    expect(held.sentOk).toBe(0);
    expect(hasSellerHold(getDb(path), "olx", "pipe0001")).toBe(true);

    const expiredSent: Listing[] = [];
    const expired = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(expiredSent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + SELLER_HOLD_MAX_MS),
        probeOlxProfile: blocked,
      },
      3,
    );
    expect(expired.sentOk).toBe(0);
    expect(expiredSent).toHaveLength(0);
    expect(hasSellerHold(getDb(path), "olx", "pipe0001")).toBe(false);
    expect(store.hasSeen(item)).toBe(true);

    const againSent: Listing[] = [];
    const again = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(againSent),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(now.getTime() + SELLER_HOLD_MAX_MS + 60_000),
        probeOlxProfile: blocked,
      },
      4,
    );
    expect(again.sentOk).toBe(0);
    expect(againSent).toHaveLength(0);
    expect(hasSellerHold(getDb(path), "olx", "pipe0001")).toBe(false);
  });

  it("drops a persisted unresolved hold after SQLite is reopened past release_at", async () => {
    const path = dbPath();
    const store = new DurableDeliveryStore(getDb(path));
    const item = directOlx("restart1");
    const batch: Listing[] = [];
    const adapters = [adapter(() => batch)];
    await seed(store, adapters);
    batch.push(item);
    await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink([]),
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        probeOlxProfile: blocked,
      },
      2,
    );
    expect(hasSellerHold(getDb(path), "olx", "restart1")).toBe(true);
    closeDb();

    const reopened = new DurableDeliveryStore(getDb(path));
    const sent: Listing[] = [];
    const report = await runTelegramTestCycle(
      {
        adapters,
        config: configFor(),
        sink: sink(sent),
        dedupe: reopened,
        baseline: reopened,
        outbox: reopened,
        now: () => new Date(now.getTime() + SELLER_HOLD_MAX_MS),
        probeOlxProfile: blocked,
      },
      3,
    );
    expect(report.sentOk).toBe(0);
    expect(sent).toHaveLength(0);
    expect(reopened.hasSeen(item)).toBe(true);
    expect(hasSellerHold(getDb(path), "olx", "restart1")).toBe(false);
  });
});

describe("linked seller diagnostics distinguish capacity from transport", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-olx-cap-diag-"));

  afterEach(() => {
    closeDb();
    resetConfigCache();
  });

  it("counts the sixth linked OLX detail as capacity deferred, not transport failure", async () => {
    const path = join(dir, "diag.sqlite");
    const store = new DurableDeliveryStore(getDb(path));
    const tokens = ["capA001", "capA002", "capA003", "capA004", "capA005", "capA006"];
    const batch = tokens.map((token, index) => lun(`diag-${index}`, token));
    resetConfigCache();
    const config = loadConfig({
      TELEGRAM_TEST_MODE: "true",
      TELEGRAM_BOT_TOKEN: "1:test",
      TELEGRAM_CHAT_ID: "1",
      ENABLE_OLX: "false",
      ENABLE_OLX_BROWSER: "false",
      ENABLE_LUN: "true",
      ENABLE_DOMRIA: "false",
      ENABLE_RIELTOR: "false",
      SELLER_POLICY: "reject_intermediaries",
      FRESHNESS_MAX_PUBLICATION_AGE_MINUTES: "10080",
      GEO_UNKNOWN_POLICY: "include",
    });
    const adapter: ListingSourceAdapter = {
      source: "lun",
      fetchLatest: async () => batch,
      inspectLatest: async (): Promise<SourceFetchResult> => ({
        listings: batch,
        transport: "test",
        dataKind: "MOCK DATA",
        resultKind: "ok",
        httpStatus: 200,
        health: { source: "lun", healthy: true, checkedAt: now, message: "ok" },
      }),
      healthCheck: async () => ({ source: "lun", healthy: true, checkedAt: now }),
    };
    await runTelegramTestCycle(
      {
        adapters: [{ ...adapter, fetchLatest: async () => [], inspectLatest: async () => ({
          listings: [],
          transport: "test",
          dataKind: "MOCK DATA",
          resultKind: "valid_empty",
          httpStatus: 200,
          health: { source: "lun", healthy: true, checkedAt: published, message: "ok" },
        }) }],
        config,
        sink: { chatId: "1", dryRun: false, sendListing: async () => ({ ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 }), sendText: async () => ({ ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 }) } as unknown as TelegramTestSink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => new Date(published.getTime() - 60_000),
        firstRunMode: "seed",
      },
      1,
    );
    const report = await runTelegramTestCycle(
      {
        adapters: [adapter],
        config,
        sink: {
          chatId: "1",
          dryRun: false,
          sendListing: async () => ({ ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 }),
          sendText: async () => ({ ok: true, dryRun: false, attempts: 1, chatId: "1", messageCount: 1 }),
        } as unknown as TelegramTestSink,
        dedupe: store,
        baseline: store,
        outbox: store,
        now: () => now,
        olxDetailGapMs: 0,
        fetchOlxDetail: async (url) => ({ status: 404, finalUrl: url, bodyText: "missing" }),
      },
      2,
    );
    expect(report.linkedSellerVerification.detailCapacityDeferred).toBe(1);
    expect(report.linkedSellerVerification.detailTransportFailure).toBe(5);
    expect(report.linkedSellerVerification.detailRequests).toBe(5);
    expect(report.sentOk).toBe(0);
    expect(report.linkedSellerEvents.some((event) => event.outcome === "detail_capacity_deferred")).toBe(
      true,
    );
    expect(transportRows(path, "capA006")).toBe(0);
    expect(transportRows(path, "capA001")).toBe(1);
  });
});
