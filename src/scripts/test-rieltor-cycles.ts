import { config as loadDotenv } from "dotenv";
import { RieltorSource } from "../sources/rieltor/rieltor.source.ts";
import { printLiveReport } from "./live-report.ts";

loadDotenv();

const cycles = Number(process.env.RIELTOR_LIVE_CYCLES ?? "3");
const intervalMs = Number(process.env.RIELTOR_LIVE_INTERVAL_MS ?? String(10 * 60_000));
const source = new RieltorSource();

console.log(
  `RIELTOR bounded live cycles: count=${cycles} intervalMs=${intervalMs} started=${new Date().toISOString()}`,
);

for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const started = new Date();
  console.log(`\n===== CYCLE ${cycle}/${cycles} start ${started.toISOString()} =====`);
  const result = await source.inspectLatest({ limit: 10 });
  printLiveReport(`RIELTOR cycle ${cycle}`, result, ["coordinates", "sellerTypeKnown"]);
  console.log(
    `CYCLE ${cycle} done at ${new Date().toISOString()} listings=${result.listings.length} kind=${result.resultKind} status=${result.httpStatus ?? "n/a"}`,
  );
  if (cycle < cycles) {
    console.log(`sleeping ${intervalMs} ms before next cycle`);
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

console.log(`\nRIELTOR bounded live cycles finished at ${new Date().toISOString()}`);
console.log("This short run does not prove multi-day reliability.");
