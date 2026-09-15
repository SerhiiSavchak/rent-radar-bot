import { config as loadDotenv } from "dotenv";
import { LunSource } from "../sources/lun/lun.source.ts";

loadDotenv();

const result = await new LunSource().inspectLatest({ limit: 24, includeApartments: true, includeHouses: true });
const hosts = new Map<string, number>();
const olxIds: string[] = [];
const rieltorIds: string[] = [];

for (const listing of result.listings) {
  const original = listing.metadata?.originalUrl;
  if (typeof original !== "string") {
    hosts.set("(missing originalUrl)", (hosts.get("(missing originalUrl)") ?? 0) + 1);
    continue;
  }
  try {
    const url = new URL(original);
    const host = url.hostname.replace(/^www\./, "");
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
    if (host.includes("olx.")) {
      const match = original.match(/ID([A-Za-z0-9]+)/i) ?? original.match(/\/(\d+)(?:\/|$)/);
      if (match?.[1]) {
        olxIds.push(match[1]);
      }
    }
    if (host.includes("rieltor.")) {
      const match = original.match(/\/(\d+)\/?$/);
      if (match?.[1]) {
        rieltorIds.push(match[1]);
      }
    }
  } catch {
    hosts.set("(unparseable originalUrl)", (hosts.get("(unparseable originalUrl)") ?? 0) + 1);
  }
}

console.log("DATA KIND: LIVE DATA");
console.log(`resultKind: ${result.resultKind ?? "n/a"}`);
console.log(`http: ${result.httpStatus ?? "n/a"}`);
console.log(`listings: ${result.listings.length}`);
console.log("original hosts:");
for (const [host, count] of [...hosts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${host}: ${count}`);
}
console.log(`olx original ids sampled: ${olxIds.slice(0, 10).join(", ") || "none"}`);
console.log(`rieltor original ids sampled: ${rieltorIds.slice(0, 10).join(", ") || "none"}`);
console.log("Direct OLX browser baseline in this environment: NOT TESTED");
