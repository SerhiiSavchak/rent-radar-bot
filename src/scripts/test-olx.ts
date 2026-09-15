import { config as loadDotenv } from "dotenv";
import { OlxSource } from "../sources/olx/olx.source.ts";
import { exitByVerdict, printLiveReport } from "./live-report.ts";

loadDotenv();

const result = await new OlxSource().inspectLatest({ limit: 10 });
const verdict = printLiveReport("OLX", result, ["publishedAt", "coordinates", "sellerTypeKnown"]);
exitByVerdict([verdict]);
