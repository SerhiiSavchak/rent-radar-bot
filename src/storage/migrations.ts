import type { DatabaseSync } from "node:sqlite";

/** 4 = cross-source identities. 5 = source health and retention indexes. 6 = linked seller cache. */
export const SCHEMA_VERSION = 10;

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

const MIGRATION_3 = `
ALTER TABLE poller_lock ADD COLUMN boot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE poller_lock ADD COLUMN pid INTEGER;
ALTER TABLE poller_lock ADD COLUMN starttime TEXT;
`;

const MIGRATION_4 = `
CREATE TABLE IF NOT EXISTS cross_source_identities (
  identity_key TEXT NOT NULL,
  key_class TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (identity_key, source, source_id)
);
CREATE INDEX IF NOT EXISTS cross_source_identities_key_idx ON cross_source_identities (identity_key);
`;

const MIGRATION_5 = `
CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'ok',
    'valid_empty',
    'parser_failure',
    'http_error',
    'rate_limited',
    'transport_failure',
    'browser_failure',
    'disabled'
  )),
  checked_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_listing_count INTEGER,
  last_http_status INTEGER,
  last_error_safe TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_listings_last_seen_idx ON seen_listings (last_seen_at);
CREATE INDEX IF NOT EXISTS telegram_outbox_status_sent_idx ON telegram_outbox (status, sent_at);
CREATE INDEX IF NOT EXISTS telegram_outbox_source_idx ON telegram_outbox (source, source_id);
CREATE INDEX IF NOT EXISTS cross_source_identities_created_idx ON cross_source_identities (created_at);
CREATE INDEX IF NOT EXISTS cross_source_identities_listing_idx ON cross_source_identities (source, source_id);
`;

const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS external_seller_verifications (
  source TEXT NOT NULL,
  external_listing_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  seller_verdict TEXT NOT NULL CHECK (seller_verdict IN (
    'confirmed_owner',
    'confirmed_intermediary',
    'unknown',
    'rate_limited',
    'transport_failure',
    'parser_failure'
  )),
  seller_evidence TEXT,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_http_status INTEGER,
  last_error_safe TEXT,
  PRIMARY KEY (source, external_listing_id)
);
CREATE INDEX IF NOT EXISTS external_seller_verifications_expires_idx
  ON external_seller_verifications (expires_at);
`;

const MIGRATION_7 = `
ALTER TABLE telegram_outbox ADD COLUMN next_attempt_at TEXT;
ALTER TABLE telegram_outbox ADD COLUMN error_class TEXT;
CREATE TABLE IF NOT EXISTS source_admin_alerts (
  source TEXT PRIMARY KEY,
  incident_open INTEGER NOT NULL DEFAULT 0 CHECK (incident_open IN (0, 1)),
  last_alert_kind TEXT,
  last_alert_at TEXT,
  cooldown_until TEXT,
  last_error_safe TEXT,
  updated_at TEXT NOT NULL
);
`;

const MIGRATION_8 = `
CREATE TABLE IF NOT EXISTS seller_verification_holds (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  listing_json TEXT NOT NULL,
  external_source TEXT NOT NULL,
  external_listing_id TEXT NOT NULL,
  hold_started_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  release_at TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS seller_verification_holds_due_idx
  ON seller_verification_holds (next_check_at);

CREATE TABLE source_health_v8 (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'ok',
    'valid_empty',
    'parser_failure',
    'http_error',
    'rate_limited',
    'transport_failure',
    'browser_failure',
    'coverage_degraded',
    'disabled'
  )),
  checked_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_listing_count INTEGER,
  last_http_status INTEGER,
  last_error_safe TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO source_health_v8 (
  source, status, checked_at, last_success_at, last_failure_at,
  consecutive_failures, last_listing_count, last_http_status, last_error_safe, updated_at
)
SELECT
  source, status, checked_at, last_success_at, last_failure_at,
  consecutive_failures, last_listing_count, last_http_status, last_error_safe, updated_at
FROM source_health;
DROP TABLE source_health;
ALTER TABLE source_health_v8 RENAME TO source_health;
`;

const MIGRATION_9 = `
CREATE TABLE IF NOT EXISTS seller_profile_cache (
  source TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evidence TEXT NOT NULL,
  address_keys TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, seller_id)
);
`;

const MIGRATION_10 = `
CREATE TABLE IF NOT EXISTS listing_decision_trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  identity_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listing_decision_trace_lookup_idx
  ON listing_decision_trace (source, source_id, created_at);
CREATE INDEX IF NOT EXISTS listing_decision_trace_cycle_idx
  ON listing_decision_trace (cycle_id, source);
CREATE INDEX IF NOT EXISTS listing_decision_trace_created_idx
  ON listing_decision_trace (created_at);
`;

const MIGRATIONS: Record<number, string> = {
  1: MIGRATION_1,
  2: MIGRATION_2,
  3: MIGRATION_3,
  4: MIGRATION_4,
  5: MIGRATION_5,
  6: MIGRATION_6,
  7: MIGRATION_7,
  8: MIGRATION_8,
  9: MIGRATION_9,
  10: MIGRATION_10,
};

export function sqliteMigrationSql(version: number): string {
  const sql = MIGRATIONS[version];
  if (!sql) {
    throw new Error(`Missing SQLite migration ${version}`);
  }
  return sql;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

export function appliedSchemaVersion(db: DatabaseSync): number {
  if (tableExists(db, "schema_migrations")) {
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      { version: number | null } | undefined;
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
