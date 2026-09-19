import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 2;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  raw_json TEXT,
  UNIQUE (source, source_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS listings_url_idx ON listings (canonical_url);
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_baselines (
  source TEXT PRIMARY KEY,
  established_at TEXT NOT NULL,
  last_success_at TEXT NOT NULL,
  seed_listing_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seen_listings (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  published_at TEXT,
  refreshed_at TEXT,
  PRIMARY KEY (source, source_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS seen_listings_url_idx ON seen_listings (canonical_url);
CREATE UNIQUE INDEX IF NOT EXISTS seen_listings_fp_idx ON seen_listings (fingerprint);
CREATE TABLE IF NOT EXISTS telegram_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  listing_json TEXT NOT NULL,
  delivery_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (fingerprint)
);
CREATE TABLE IF NOT EXISTS poller_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
`;

const MIGRATIONS: Record<number, string> = {
  1: MIGRATION_1,
  2: MIGRATION_2,
};

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

export function appliedSchemaVersion(db: DatabaseSync): number {
  if (tableExists(db, "schema_migrations")) {
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    if (row?.version) {
      return row.version;
    }
  }
  return tableExists(db, "listings") ? 1 : 0;
}

export function applyMigrations(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  let current = appliedSchemaVersion(db);
  if (current >= 1) {
    const recorded = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
    if (!recorded) {
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(
        new Date().toISOString(),
      );
    }
  }
  current = appliedSchemaVersion(db);
  for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
    const sql = MIGRATIONS[version];
    if (!sql) {
      throw new Error(`Missing SQLite migration ${version}`);
    }
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION),
  );
  return SCHEMA_VERSION;
}
