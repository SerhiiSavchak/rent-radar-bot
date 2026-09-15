import { config as loadDotenv } from "dotenv";
import { DomriaSource } from "../sources/domria/domria.source.ts";
import { exitByVerdict, printLiveReport } from "./live-report.ts";

loadDotenv();

const result = await new DomriaSource().inspectLatest({ limit: 10 });
const verdict = printLiveReport("DIM.RIA", result, ["publishedAt", "coordinates", "sellerTypeKnown"]);
exitByVerdict([verdict]);
