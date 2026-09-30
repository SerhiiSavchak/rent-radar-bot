import { backupSqliteDatabase, verifySqliteBackup } from "../storage/sqlite-backup.ts";

const source = process.argv[2];
const destination = process.argv[3];
if (!source || !destination) {
  console.error(
    JSON.stringify({
      ok: false,
      error: "Usage: tsx src/scripts/backup-sqlite.ts <source.sqlite> <destination.sqlite>",
    }),
  );
  process.exit(2);
}

backupSqliteDatabase(source, destination);
const checked = verifySqliteBackup(destination);
console.log(JSON.stringify({ destination, ...checked }));
