/**
 * Isolated verification that MIGRATION_12 (and onward to current SCHEMA_VERSION)
 * preserves durable delivery state.
 *
 * Why MIGRATION_12 is necessary:
 * SQLite CHECK on external_seller_verifications.seller_verdict is a closed enum.
 * Persisting seller_registration_year_2026 without rebuilding that CHECK fails
 * inserts (and aborts linked-seller cycles). MIGRATION_12 rebuilds the table,
 * copies existing rows, recreates the expires index — it does not touch
 * seen/outbox/baselines/cursors.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  appliedSchemaVersion,
  applyMigrations,
  SCHEMA_VERSION,
  sqliteMigrationSql,
} from "../src/storage/migrations.ts";
import { olxCatchupKey, olxPublicationBoundaryKey } from "../src/sources/olx/olx-browser.coverage.ts";

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

describe("MIGRATION_12 isolated state preservation", () => {
  it("upgrades schema 11 → current without dropping seen/sent/baselines/cursors/seller rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (let version = 1; version <= 11; version += 1) {
      db.exec("BEGIN IMMEDIATE;");
      db.exec(sqliteMigrationSql(version));
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-09-01T00:00:00.000Z",
      );
      db.exec("COMMIT;");
    }
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '11')").run();

    const at = "2026-09-22T10:00:00.000Z";
    const expires = "2026-10-22T10:00:00.000Z";

    db.prepare(
      `INSERT INTO seen_listings (
         source, source_id, fingerprint, canonical_url, first_seen_at, last_seen_at, published_at
       ) VALUES ('lun', 'seen-1', 'fp-seen-1', 'https://lun.ua/uk/realty/seen-1', ?, ?, ?)`,
    ).run(at, at, at);
    db.prepare(
      `INSERT INTO telegram_outbox (
         source, source_id, fingerprint, listing_json, delivery_kind, status,
         created_at, sent_at, attempt_count
       ) VALUES ('lun', 'sent-1', 'fp-sent-1', '{}', 'new_publication', 'sent', ?, ?, 1)`,
    ).run(at, at);
    db.prepare(
      `INSERT INTO source_baselines (source, established_at, last_success_at, seed_listing_count)
       VALUES ('olx', ?, ?, 12)`,
    ).run(at, at);
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(
      olxCatchupKey("apartments"),
      JSON.stringify({ target: "2026-09-19T21:15:02.350Z", resumePage: 3 }),
    );
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(
      olxPublicationBoundaryKey("apartments"),
      "2026-09-19T21:15:02.350Z",
    );
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', 'keep-owner', 'https://www.olx.ua/d/uk/obyavlenie/ID1.html',
         'confirmed_owner', 'owner', ?, ?, NULL, NULL)`,
    ).run(at, expires);
    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at, last_http_status, last_error_safe
       ) VALUES ('olx', 'keep-likely', 'https://www.olx.ua/d/uk/obyavlenie/ID2.html',
         'profile_likely_intermediary', 'distinct_addresses=3', ?, ?, NULL, NULL)`,
    ).run(at, expires);

    expect(appliedSchemaVersion(db)).toBe(11);
    expect(() =>
      db.prepare(
        `INSERT INTO external_seller_verifications (
           source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
           checked_at, expires_at
         ) VALUES ('olx', 'y2026', 'https://www.olx.ua/d/uk/obyavlenie/IDy.html',
           'seller_registration_year_2026', 'seller_registration_year_2026', ?, ?)`,
      ).run(at, expires),
    ).toThrow(/CHECK constraint failed|constraint/i);

    expect(applyMigrations(db)).toBe(SCHEMA_VERSION);
    expect(appliedSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12);

    expect(count(db, "SELECT COUNT(*) AS n FROM seen_listings WHERE source_id = 'seen-1'")).toBe(1);
    expect(
      count(db, "SELECT COUNT(*) AS n FROM telegram_outbox WHERE source_id = 'sent-1' AND status = 'sent'"),
    ).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM source_baselines WHERE source = 'olx'")).toBe(1);
    const catchup = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(olxCatchupKey("apartments")) as { value: string };
    expect(JSON.parse(catchup.value)).toEqual({
      target: "2026-09-19T21:15:02.350Z",
      resumePage: 3,
    });
    const boundary = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(olxPublicationBoundaryKey("apartments")) as { value: string };
    expect(boundary.value).toBe("2026-09-19T21:15:02.350Z");

    const sellers = db
      .prepare(
        `SELECT external_listing_id AS id, seller_verdict AS verdict
         FROM external_seller_verifications ORDER BY external_listing_id`,
      )
      .all() as Array<{ id: string; verdict: string }>;
    expect(sellers).toEqual([
      { id: "keep-likely", verdict: "profile_likely_intermediary" },
      { id: "keep-owner", verdict: "confirmed_owner" },
    ]);

    db.prepare(
      `INSERT INTO external_seller_verifications (
         source, external_listing_id, canonical_url, seller_verdict, seller_evidence,
         checked_at, expires_at
       ) VALUES ('olx', 'y2026', 'https://www.olx.ua/d/uk/obyavlenie/IDy.html',
         'seller_registration_year_2026', 'seller_registration_year_2026', ?, ?)`,
    ).run(at, expires);
    expect(
      (
        db
          .prepare(
            `SELECT seller_verdict AS v FROM external_seller_verifications
             WHERE external_listing_id = 'y2026'`,
          )
          .get() as { v: string }
      ).v,
    ).toBe("seller_registration_year_2026");
  });
});
