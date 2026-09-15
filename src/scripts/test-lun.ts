import { config as loadDotenv } from "dotenv";
import { LunSource } from "../sources/lun/lun.source.ts";
import { exitByVerdict, printLiveReport } from "./live-report.ts";

loadDotenv();

const result = await new LunSource().inspectLatest({ limit: 10 });
const verdict = printLiveReport("LUN", result, ["publishedAt", "coordinates", "sellerTypeKnown"]);
exitByVerdict([verdict]);
