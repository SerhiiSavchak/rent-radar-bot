/**
 * Read-only OLX Private seller audit from a local JSON sample.
 * No Telegram, no database writes, no network, no delivery.
 *
 *   npm run audit:olx:private-sellers -- ./sample.json
 *
 * The file is an array of `{ sellerId, snapshot, evidenceFamilies? }`.
 * Threshold 5 is reported, not changed. One local sample is not a policy change.
 */
import { readFileSync } from "node:fs";
import {
  summarizeOlxPrivateSellerAudit,
  type OlxSellerAuditInput,
} from "../sources/olx/olx-seller-audit.ts";

const file = process.argv[2];
if (!file) {
  console.error(
    JSON.stringify({
      ok: false,
      error: "Pass a local JSON sample. This script does not fetch OLX or write a database.",
    }),
  );
  process.exit(2);
}

const parsed = JSON.parse(readFileSync(file, "utf8")) as OlxSellerAuditInput[];
if (!Array.isArray(parsed)) {
  console.error(JSON.stringify({ ok: false, error: "Sample must be a JSON array" }));
  process.exit(2);
}

console.log(JSON.stringify(summarizeOlxPrivateSellerAudit(parsed), null, 2));
