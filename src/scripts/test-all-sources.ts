import { config as loadDotenv } from "dotenv";
import { ListingMonitorService } from "../services/listing-monitor.service.ts";
import { DomriaSource } from "../sources/domria/domria.source.ts";
import { LunSource } from "../sources/lun/lun.source.ts";
import { OlxSource } from "../sources/olx/olx.source.ts";
import { exitByVerdict, printLiveReport, type LiveVerdict } from "./live-report.ts";

loadDotenv();

const olx = new OlxSource();
const domria = new DomriaSource();
const lun = new LunSource();
const monitor = new ListingMonitorService([olx, domria, lun]);
const results = await monitor.inspectAll();
const verdicts: LiveVerdict[] = [];

for (const result of results) {
  verdicts.push(printLiveReport(result.health.source.toUpperCase(), result, ["publishedAt", "coordinates"]));
}

console.log("AGGREGATED: one failed source does not prevent printing the others.");
exitByVerdict(verdicts);
