/**
 * Isolated verification that MIGRATION_14 rebuilds the seller-verdict CHECK
 * from a real schema-13 database. It copies existing rows and recreates the
 * expires index. It does not start from an empty database.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  appliedSchemaVersion,
  applyMigrations,
  sqliteMigrationSql,
} from "../src/storage/migrations.ts";

const CHECKED_AT = "2026-10-01T08:00:00.000Z";
const EXPIRES_AT = "2026-10-31T08:00:00.000Z";

type SellerRow = {
  source: string;
  external_listing_id: string;
  canonical_url: string;
  seller_verdict: string;
  seller_evidence: string;
  checked_at: string;
  expires_at: string;
  last_http_status: number;
  last_error_safe: string;
};

const SEEDED_ROWS: SellerRow[] = [
  {
    source: "olx",
    external_listing_id: "keep-owner",
    canonical_url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDowner.html",
    seller_verdict: "confirmed_owner",
    seller_evidence: "platform confirmed owner",
    checked_at: CHECKED_AT,
    expires_at: EXPIRES_AT,
    last_http_status: 200,
    last_error_safe: "owner-cache-ok",
  },
  {
    source: "olx",
    external_listing_id: "keep-agent",
    canonical_url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDagent.html",
    seller_verdict: "confirmed_intermediary",
    seller_evidence: "explicit agency",
    checked_at: CHECKED_AT,
    expires_at: EXPIRES_AT,
    last_http_status: 200,
    last_error_safe: "agent-cache-ok",
  },
  {
    source: "olx",
    external_listing_id: "keep-likely",
    canonical_url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDlikely.html",
    seller_verdict: "profile_likely_intermediary",
    seller_evidence: "distinct_addresses=3",
    checked_at: CHECKED_AT,
    expires_at: EXPIRES_AT,
    last_http_status: 200,
    last_error_safe: "likely-cache-ok",
  },
  {
    source: "olx",
    external_listing_id: "keep-year",
    canonical_url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDyear.html",
    seller_verdict: "seller_registration_year_2026",
    seller_evidence: "seller_registration_year_2026",
    checked_at: CHECKED_AT,
    expires_at: EXPIRES_AT,
    last_http_status: 200,
    last_error_safe: "year-cache-ok",
  },
  {
    source: "olx",
    external_listing_id: "keep-inventory",
    canonical_url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDinventory.html",
    seller_verdict: "seller_inventory_limit",
    seller_evidence: "seller_inventory_limit;distinct_precise_properties=5",
    checked_at: CHECKED_AT,
    expires_at: EXPIRES_AT,
    last_http_status: 200,
    last_error_safe: "inventory-cache-ok",
  },
  {
    source: "olx",
    external_listing_id: "keep-unknown",
    canonical_url: "https://www.olx.ua/d/uk/obyavlenie/orenda-IDunknown.html",
    seller_verdict: "unknown",
    seller_evidence: "olx_inventory_incomplete=1",
    checked_at: CHECKED_AT,
    expires_at: EXPIRES_AT,
    last_http_status: 403,
    last_error_safe: "detail_unknown",
  },
];

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

function schema13Database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  for (let version = 1; version <= 13; version += 1) {
    db.exec("BEGIN IMMEDIATE;");
    db.exec(sqliteMigrationSql(version));
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      version,
      "2026-10-01T00:00:00.000Z",
    );
    db.exec("COMMIT;");
  }
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '13')").run();
  const insert = db.prepare(
    `INSERT INTO external_seller_verifications (
       source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
       checked_at, expires_at, last_http_status, last_error_safe
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of SEEDED_ROWS) {
    insert.run(
      row.source,
      row.external_listing_id,
      row.canonical_url,
      row.seller_verdict,
      row.seller_evidence,
      row.checked_at,
      row.expires_at,
      row.last_http_status,
      row.last_error_safe,
    );
  }
  return db;
}

function sellerRows(db: DatabaseSync): SellerRow[] {
  return db
    .prepare(
      `SELECT source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
              checked_at, expires_at, last_http_status, last_error_safe
       FROM external_seller_verifications
       ORDER BY external_listing_id`,
    )
    .all() as SellerRow[];
}

describe("MIGRATION_14 seller_mass_inventory", () => {
  it("upgrades a seeded schema-13 database and preserves seller cache rows", () => {
    const db = schema13Database();
    expect(appliedSchemaVersion(db)).toBe(13);
    expect(
      (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string })
        .value,
    ).toBe("13");
    expect(() =>
      db
        .prepare(
          `INSERT INTO external_seller_verifications (
             source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
             checked_at, expires_at, last_http_status, last_error_safe
           ) VALUES ('olx', 'mass-before', 'https://www.olx.ua/d/uk/obyavlenie/IDmass.html',
             'seller_mass_inventory', 'seller_mass_inventory', ?, ?, 200, 'not-yet')`,
        )
        .run(CHECKED_AT, EXPIRES_AT),
    ).toThrow(/CHECK constraint failed|constraint/i);

    expect(applyMigrations(db)).toBe(14);
    expect(appliedSchemaVersion(db)).toBe(14);
    expect(
      (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string })
        .value,
    ).toBe("14");
    expect(count(db, "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 14")).toBe(1);

    expect(sellerRows(db)).toEqual(
      [...SEEDED_ROWS].sort((left, right) =>
        left.external_listing_id < right.external_listing_id
          ? -1
          : left.external_listing_id > right.external_listing_id
            ? 1
            : 0,
      ),
    );

    expect(() =>
      db
        .prepare(
          `INSERT INTO external_seller_verifications (
             source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
             checked_at, expires_at, last_http_status, last_error_safe
           ) VALUES ('olx', 'keep-owner', 'https://www.olx.ua/d/uk/obyavlenie/duplicate.html',
             'unknown', 'duplicate primary key', ?, ?, 200, 'duplicate')`,
        )
        .run(CHECKED_AT, EXPIRES_AT),
    ).toThrow(/constraint failed/i);
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('lun', 'keep-owner', 'https://lun.ua/uk/realty/keep-owner',
         'unknown', 'same id other source', ?, ?, 200, 'other-source')`,
    ).run(CHECKED_AT, EXPIRES_AT);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM external_seller_verifications WHERE external_listing_id = 'keep-owner'",
      ),
    ).toBe(2);

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'external_seller_verifications_expires_idx'",
        )
        .get(),
    ).toBeTruthy();

    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', '11pP0b', 'https://www.olx.ua/d/uk/obyavlenie/orenda-ID11pP0b.html',
         'seller_mass_inventory', 'seller_mass_inventory;olx_real_estate_count=10;olx_coarse_locations=5',
         ?, ?, 200, 'mass-inventory')`,
    ).run(CHECKED_AT, EXPIRES_AT);
    expect(
      (
        db
          .prepare(
            `SELECT seller_verdict AS verdict FROM external_seller_verifications
             WHERE source = 'olx' AND external_listing_id = '11pP0b'`,
          )
          .get() as { verdict: string }
      ).verdict,
    ).toBe("seller_mass_inventory");

    expect(() =>
      db
        .prepare(
          `INSERT INTO external_seller_verifications (
             source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
             checked_at, expires_at, last_http_status, last_error_safe
           ) VALUES ('olx', 'bad-verdict', 'https://www.olx.ua/d/uk/obyavlenie/IDbad.html',
             'not_a_real_verdict', 'invalid', ?, ?, 200, 'rejected')`,
        )
        .run(CHECKED_AT, EXPIRES_AT),
    ).toThrow(/CHECK constraint failed|constraint/i);

    const beforeSecondApply = count(db, "SELECT COUNT(*) AS n FROM external_seller_verifications");
    expect(applyMigrations(db)).toBe(14);
    expect(appliedSchemaVersion(db)).toBe(14);
    expect(
      (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string })
        .value,
    ).toBe("14");
    expect(count(db, "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 14")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM external_seller_verifications")).toBe(beforeSecondApply);
    expect(
      (
        db
          .prepare(
            `SELECT seller_verdict AS verdict, seller_evidence AS evidence
             FROM external_seller_verifications
             WHERE source = 'olx' AND external_listing_id = 'keep-inventory'`,
          )
          .get() as { verdict: string; evidence: string }
      ).verdict,
    ).toBe("seller_inventory_limit");
  });
});
