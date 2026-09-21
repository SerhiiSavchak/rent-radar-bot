import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { closeDb, getDb } from "./db.ts";
import { DurableDeliveryStore } from "./durable-delivery-store.ts";
import { acquirePollerLock, PollerLockError, type PollerLock } from "./poller-lock.ts";
import { appliedSchemaVersion, SCHEMA_VERSION } from "./migrations.ts";

export type DurableRuntime = {
  db: DatabaseSync;
  store: DurableDeliveryStore;
  lock: PollerLock;
  schemaVersion: number;
  close: () => void;
};

export function secureDatabaseFiles(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(databasePath), 0o700);
  } catch {
    // Windows may ignore POSIX modes.
  }
  try {
    chmodSync(databasePath, 0o600);
  } catch {
    // file may not exist yet
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(`${databasePath}${suffix}`, 0o600);
    } catch {
      // optional sidecar
    }
  }
}

export function openDurableRuntime(options: {
  databasePath: string;
  lockHolder: string;
  staleLockMs?: number;
}): DurableRuntime {
  secureDatabaseFiles(options.databasePath);
  const db = getDb(options.databasePath);
  secureDatabaseFiles(options.databasePath);
  const schemaVersion = appliedSchemaVersion(db);
  if (schemaVersion !== SCHEMA_VERSION) {
    closeDb();
    throw new Error(`SQLite schema version ${schemaVersion} != ${SCHEMA_VERSION}`);
  }
  let lock: PollerLock;
  try {
    lock = acquirePollerLock(db, options.lockHolder, options.staleLockMs);
  } catch (error) {
    closeDb();
    throw error;
  }
  const store = new DurableDeliveryStore(db);
  return {
    db,
    store,
    lock,
    schemaVersion,
    close: () => {
      try {
        lock.release();
      } finally {
        closeDb();
      }
    },
  };
}

export { PollerLockError };
