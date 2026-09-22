import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Listing } from "../domain/listing.ts";
import { getConfig } from "../config/env.ts";
import { applyMigrations } from "./migrations.ts";

export type StoredListing = {
  id: number;
  source: string;
  sourceId: string;
  canonicalUrl: string;
  title: string;
  discoveredAt: string;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  rawJson: string | null;
};

let db: DatabaseSync | undefined;
let openedPath: string | undefined;

export function getDb(databasePath = openedPath ?? getConfig().databasePath): DatabaseSync {
  if (db) {
    return db;
  }
  openedPath = databasePath;
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(databasePath), 0o700);
  } catch {
    // Windows may ignore POSIX modes.
  }
  db = new DatabaseSync(databasePath);
  try {
    chmodSync(databasePath, 0o600);
  } catch {
    // best-effort
  }
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applyMigrations(db);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
  openedPath = undefined;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.hostname}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function hasSeenListing(listing: Pick<Listing, "source" | "sourceId" | "url">): boolean {
  const database = getDb();
  const byId = database
    .prepare("SELECT id FROM listings WHERE source = ? AND source_id = ? LIMIT 1")
    .get(listing.source, listing.sourceId);
  if (byId) {
    return true;
  }
  const byUrl = database
    .prepare("SELECT id FROM listings WHERE canonical_url = ? LIMIT 1")
    .get(normalizeUrl(listing.url));
  return Boolean(byUrl);
}

export function saveListing(listing: Listing): void {
  const database = getDb();
  const now = new Date().toISOString();
  const published = listing.publishedAt?.toISOString() ?? null;
  const discovered = listing.discoveredAt.toISOString();
  const raw = listing.metadata ? JSON.stringify(listing.metadata) : null;
  const url = normalizeUrl(listing.url);

  const existing = database
    .prepare("SELECT id, first_seen_at FROM listings WHERE source = ? AND source_id = ? LIMIT 1")
    .get(listing.source, listing.sourceId) as { id: number; first_seen_at: string } | undefined;

  if (existing) {
    database
      .prepare(
        "UPDATE listings SET canonical_url = ?, title = ?, last_seen_at = ?, published_at = COALESCE(?, published_at), raw_json = ? WHERE id = ?",
      )
      .run(url, listing.title, now, published, raw, existing.id);
    return;
  }

  database
    .prepare(
      `INSERT INTO listings (
        source, source_id, canonical_url, title, discovered_at, published_at, first_seen_at, last_seen_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      listing.source,
      listing.sourceId,
      url,
      listing.title,
      discovered,
      published,
      now,
      now,
      raw,
    );
}

export function markSeen(listing: Pick<Listing, "source" | "sourceId">): void {
  getDb()
    .prepare("UPDATE listings SET last_seen_at = ? WHERE source = ? AND source_id = ?")
    .run(new Date().toISOString(), listing.source, listing.sourceId);
}

export function getRecentListings(limit = 20): StoredListing[] {
  const rows = getDb()
    .prepare(
      "SELECT id, source, source_id AS sourceId, canonical_url AS canonicalUrl, title, discovered_at AS discoveredAt, published_at AS publishedAt, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, raw_json AS rawJson FROM listings ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as StoredListing[];
  return rows;
}

/** Checkout inventory file. Row cleanup may use it. Test reset must not. */
export function isProtectedInventoryDatabase(databasePath: string): boolean {
  return pathsEqual(resolve(databasePath), resolve("./data/rent-radar.sqlite"));
}

function pathsEqual(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

export function resetDbForTests(databasePath: string): void {
  if (isProtectedInventoryDatabase(databasePath)) {
    throw new Error(
      `Refusing to reset ${databasePath}. That path is the default inventory database (data/rent-radar.sqlite). Tests must use a temporary file.`,
    );
  }
  closeDb();
  db = new DatabaseSync(databasePath);
  db.exec(`
    DROP TABLE IF EXISTS source_admin_alerts;
    DROP TABLE IF EXISTS external_seller_verifications;
    DROP TABLE IF EXISTS source_health;
    DROP TABLE IF EXISTS cross_source_identities;
    DROP TABLE IF EXISTS telegram_outbox;
    DROP TABLE IF EXISTS seen_listings;
    DROP TABLE IF EXISTS source_baselines;
    DROP TABLE IF EXISTS poller_lock;
    DROP TABLE IF EXISTS schema_meta;
    DROP TABLE IF EXISTS schema_migrations;
    DROP TABLE IF EXISTS listings;
  `);
  closeDb();
  getDb(databasePath);
}
