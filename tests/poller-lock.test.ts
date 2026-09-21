import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../src/storage/db.ts";
import { DurableDeliveryStore } from "../src/storage/durable-delivery-store.ts";
import { applyMigrations } from "../src/storage/migrations.ts";
import {
  acquirePollerLock,
  formatLockHolder,
  parsePidFromHolder,
  PollerLockError,
  type AcquirePollerLockOptions,
} from "../src/storage/poller-lock.ts";

function openLockDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applyMigrations(db);
  return db;
}

function opts(input: {
  bootId: string;
  pid: number;
  starttime?: string;
  live: ReadonlySet<string>;
  pollerPids?: ReadonlySet<number>;
}): AcquirePollerLockOptions {
  const starttime = input.starttime ?? String(input.pid);
  return {
    bootId: input.bootId,
    pid: input.pid,
    starttime,
    now: () => new Date("2026-09-20T22:40:00.000Z"),
    isProcessAlive: (pid, st) => input.live.has(`${pid}:${st || String(pid)}`),
    cmdlineLooksLikePoller: (pid) => Boolean(input.pollerPids?.has(pid)),
  };
}

describe("poller lock recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "rent-radar-lock-"));
  let n = 0;
  const path = () => join(dir, `lock-${(n += 1)}.sqlite`);

  afterEach(() => {
    closeDb();
  });

  it("steals a lock from a previous OS boot even when the heartbeat is fresh", () => {
    const dbPath = path();
    const db = openLockDb(dbPath);
    const live = new Set(["37001:99"]);
    acquirePollerLock(db, "telegram-poll", opts({ bootId: "boot-old", pid: 37001, starttime: "99", live }));
    const next = new DatabaseSync(dbPath);
    next.exec("PRAGMA busy_timeout = 5000;");
    const stolen = acquirePollerLock(
      next,
      "telegram-poll",
      opts({ bootId: "boot-new", pid: 1747, starttime: "12", live: new Set(["37001:99", "1747:12"]) }),
    );
    expect(stolen.bootId).toBe("boot-new");
    expect(stolen.pid).toBe(1747);
    const row = next.prepare("SELECT holder, boot_id AS bootId FROM poller_lock WHERE id = 1").get() as {
      holder: string;
      bootId: string;
    };
    expect(row.bootId).toBe("boot-new");
    expect(row.holder).toBe(formatLockHolder("telegram-poll", "boot-new", 1747, "12"));
    db.close();
    next.close();
  });

  it("steals after same-boot process death without waiting for TTL", () => {
    const dbPath = path();
    const db = openLockDb(dbPath);
    const live = new Set(["111:1"]);
    acquirePollerLock(db, "telegram-poll", opts({ bootId: "boot-x", pid: 111, starttime: "1", live }));
    live.delete("111:1");
    const next = new DatabaseSync(dbPath);
    next.exec("PRAGMA busy_timeout = 5000;");
    const stolen = acquirePollerLock(
      next,
      "telegram-poll",
      opts({ bootId: "boot-x", pid: 222, starttime: "2", live: new Set(["222:2"]) }),
    );
    expect(stolen.pid).toBe(222);
    db.close();
    next.close();
  });

  it("treats same-PID starttime mismatch as reuse and steals", () => {
    const dbPath = path();
    const db = openLockDb(dbPath);
    acquirePollerLock(
      db,
      "telegram-poll",
      opts({ bootId: "boot-x", pid: 111, starttime: "1", live: new Set(["111:1"]) }),
    );
    const next = new DatabaseSync(dbPath);
    next.exec("PRAGMA busy_timeout = 5000;");
    const stolen = acquirePollerLock(
      next,
      "telegram-poll",
      opts({ bootId: "boot-x", pid: 111, starttime: "99", live: new Set(["111:99"]) }),
    );
    expect(stolen.starttime).toBe("99");
    db.close();
    next.close();
  });

  it("rejects a genuinely active owner on the same boot", () => {
    const dbPath = path();
    const db = openLockDb(dbPath);
    const live = new Set(["111:1", "222:2"]);
    acquirePollerLock(db, "telegram-poll", opts({ bootId: "boot-x", pid: 111, starttime: "1", live }));
    const next = new DatabaseSync(dbPath);
    next.exec("PRAGMA busy_timeout = 5000;");
    expect(() =>
      acquirePollerLock(next, "telegram-poll", opts({ bootId: "boot-x", pid: 222, starttime: "2", live })),
    ).toThrow(PollerLockError);
    db.close();
    next.close();
  });

  it("rejects competing acquisition under BEGIN IMMEDIATE", () => {
    const dbPath = path();
    const a = openLockDb(dbPath);
    const b = new DatabaseSync(dbPath);
    b.exec("PRAGMA busy_timeout = 5000;");
    const live = new Set(["1:1", "2:2"]);
    acquirePollerLock(a, "telegram-poll", opts({ bootId: "boot-x", pid: 1, starttime: "1", live }));
    expect(() =>
      acquirePollerLock(b, "telegram-poll", opts({ bootId: "boot-x", pid: 2, starttime: "2", live })),
    ).toThrow(/Another poller holds the lock/);
    a.close();
    b.close();
  });

  it("does not let a previous owner release a replacement lock", () => {
    const dbPath = path();
    const db = openLockDb(dbPath);
    const live = new Set(["111:1"]);
    const first = acquirePollerLock(db, "telegram-poll", opts({ bootId: "boot-x", pid: 111, starttime: "1", live }));
    live.delete("111:1");
    const next = new DatabaseSync(dbPath);
    next.exec("PRAGMA busy_timeout = 5000;");
    const second = acquirePollerLock(
      next,
      "telegram-poll",
      opts({ bootId: "boot-x", pid: 222, starttime: "2", live: new Set(["222:2"]) }),
    );
    first.release();
    const row = next.prepare("SELECT holder, pid FROM poller_lock WHERE id = 1").get() as {
      holder: string;
      pid: number;
    };
    expect(row.pid).toBe(222);
    expect(row.holder).toBe(second.holder);
    second.release();
    expect(next.prepare("SELECT id FROM poller_lock WHERE id = 1").get()).toBeUndefined();
    db.close();
    next.close();
  });

  it("steals a legacy schema-v2 lock immediately when that PID is dead", () => {
    const dbPath = path();
    const db = openLockDb(dbPath);
    const at = "2026-09-20T22:39:00.000Z";
    db.prepare(
      `INSERT INTO poller_lock (id, holder, acquired_at, heartbeat_at, boot_id, pid, starttime)
       VALUES (1, 'telegram-poll:37001', ?, ?, '', NULL, NULL)`,
    ).run(at, at);
    expect(parsePidFromHolder("telegram-poll:37001")).toBe(37001);
    const stolen = acquirePollerLock(
      db,
      "telegram-poll",
      opts({ bootId: "boot-new", pid: 1747, starttime: "12", live: new Set(["1747:12"]) }),
    );
    expect(stolen.pid).toBe(1747);
    db.close();
  });

  it("still rejects a legacy lock whose PID is a live poller on this boot", () => {
    const dbPath = path();
    const db = openLockDb(dbPath);
    const at = "2026-09-20T22:39:00.000Z";
    db.prepare(
      `INSERT INTO poller_lock (id, holder, acquired_at, heartbeat_at, boot_id, pid, starttime)
       VALUES (1, 'telegram-poll:37001', ?, ?, '', 37001, NULL)`,
    ).run(at, at);
    const live = new Set(["37001:37001", "1747:12"]);
    expect(() =>
      acquirePollerLock(
        db,
        "telegram-poll",
        opts({
          bootId: "boot-x",
          pid: 1747,
          starttime: "12",
          live,
          pollerPids: new Set([37001]),
        }),
      ),
    ).toThrow(PollerLockError);
    db.close();
  });

  it("preserves baseline, seen IDs and outbox when stealing the lock", () => {
    const dbPath = path();
    const db = getDb(dbPath);
    const store = new DurableDeliveryStore(db);
    const listing = {
      source: "domria" as const,
      sourceId: "keep-1",
      url: "https://dom.ria.com/uk/realty-keep-1.html",
      title: "Keep",
      location: { raw: "Львів" },
      propertyType: "apartment" as const,
      sellerType: "owner" as const,
      discoveredAt: new Date("2026-09-17T10:00:00Z"),
      publishedAt: new Date("2026-09-17T10:00:00Z"),
    };
    store.establishSilent("domria", [listing], store, new Date("2026-09-17T12:00:00Z"));
    store.enqueueIfNew(listing, "new_publication");
    const live = new Set(["111:1"]);
    acquirePollerLock(db, "telegram-poll", opts({ bootId: "boot-old", pid: 111, starttime: "1", live }));
    const next = new DatabaseSync(dbPath);
    next.exec("PRAGMA busy_timeout = 5000;");
    acquirePollerLock(
      next,
      "telegram-poll",
      opts({ bootId: "boot-new", pid: 222, starttime: "2", live: new Set(["222:2"]) }),
    );
    const recovered = new DurableDeliveryStore(next);
    expect(recovered.hasBaseline("domria")).toBe(true);
    expect(recovered.hasSeen(listing)).toBe(true);
    expect(recovered.listRetryable()).toHaveLength(1);
    next.close();
  });
});
