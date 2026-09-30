import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { appliedSchemaVersion } from "./migrations.ts";

/**
 * Consistent SQLite snapshot. VACUUM INTO copies a committed state and does not
 * copy a live WAL by file copy.
 */
export function backupSqliteDatabase(sourcePath: string, destinationPath: string): void {
  if (sourcePath === destinationPath) {
    throw new Error("backup destination must be a different file");
  }
  const db = new DatabaseSync(sourcePath);
  try {
    const escaped = destinationPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
}

export function verifySqliteBackup(path: string): { ok: true; schemaVersion: number; bytes: number } {
  const bytes = statSync(path).size;
  if (bytes <= 0) {
    throw new Error("backup file is empty");
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") {
      throw new Error(`backup quick_check failed: ${check.quick_check}`);
    }
    return { ok: true, schemaVersion: appliedSchemaVersion(db), bytes };
  } finally {
    db.close();
  }
}
