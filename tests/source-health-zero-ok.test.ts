import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/storage/migrations.ts";
import {
  normalizeSourceHealthStatus,
  readSourceHealth,
  writeSourceHealth,
} from "../src/storage/source-health.ts";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  return db;
}

describe("explicit source result kind is the health status", () => {
  it("keeps resultKind ok with zero listings as ok", () => {
    expect(
      normalizeSourceHealthStatus({
        source: "domria",
        resultKind: "ok",
        listingCount: 0,
        httpStatus: 200,
        ok: true,
      }),
    ).toBe("ok");
  });

  it("keeps resultKind ok with listings as ok", () => {
    expect(
      normalizeSourceHealthStatus({
        source: "domria",
        resultKind: "ok",
        listingCount: 4,
        httpStatus: 200,
        ok: true,
      }),
    ).toBe("ok");
  });

  it("maps valid_empty with zero listings to valid_empty", () => {
    expect(
      normalizeSourceHealthStatus({
        source: "domria",
        resultKind: "valid_empty",
        listingCount: 0,
        httpStatus: 200,
        ok: true,
      }),
    ).toBe("valid_empty");
  });

  it("maps explicit parser_failure with zero listings to parser_failure", () => {
    expect(
      normalizeSourceHealthStatus({
        source: "domria",
        resultKind: "parser_failure",
        listingCount: 0,
        httpStatus: 200,
        ok: false,
      }),
    ).toBe("parser_failure");
  });

  it("resets a failure streak when a later ok poll assembled zero listings", () => {
    const db = memoryDb();
    const failedAt = new Date("2026-10-01T12:00:00.000Z");
    const recoveredAt = new Date("2026-10-01T12:20:00.000Z");
    writeSourceHealth(
      db,
      {
        source: "domria",
        resultKind: "parser_failure",
        listingCount: 0,
        httpStatus: 200,
        ok: false,
        errorSafe: "missing cards",
      },
      failedAt,
    );
    const recovered = writeSourceHealth(
      db,
      {
        source: "domria",
        resultKind: "ok",
        listingCount: 0,
        httpStatus: 200,
        ok: true,
      },
      recoveredAt,
    );
    expect(recovered.status).toBe("ok");
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastListingCount).toBe(0);
    expect(recovered.lastSuccessAt).toBe(recoveredAt.toISOString());
    expect(recovered.lastFailureAt).toBe(failedAt.toISOString());
    expect(readSourceHealth(db, "domria")?.status).toBe("ok");
    db.close();
  });

  it("keeps explicit failure kinds unchanged", () => {
    expect(
      normalizeSourceHealthStatus({
        source: "olx",
        resultKind: "parser_failed",
        transport: "stock_playwright_chromium",
        listingCount: 0,
      }),
    ).toBe("browser_failure");
    expect(
      normalizeSourceHealthStatus({
        source: "rieltor",
        resultKind: "rate_limited",
        httpStatus: 429,
        listingCount: 0,
      }),
    ).toBe("rate_limited");
    expect(
      normalizeSourceHealthStatus({
        source: "domria",
        resultKind: "http_error",
        httpStatus: 503,
        listingCount: 0,
      }),
    ).toBe("http_error");
    expect(
      normalizeSourceHealthStatus({
        source: "lun",
        resultKind: "coverage_degraded",
        listingCount: 3,
        httpStatus: 200,
      }),
    ).toBe("coverage_degraded");
    expect(
      normalizeSourceHealthStatus({
        source: "rieltor",
        resultKind: "transport_blocked",
        httpStatus: 403,
        listingCount: 0,
      }),
    ).toBe("transport_failure");
  });
});
