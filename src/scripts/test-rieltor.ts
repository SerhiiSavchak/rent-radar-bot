import { config as loadDotenv } from "dotenv";
import { RieltorSource } from "../sources/rieltor/rieltor.source.ts";
import { exitByVerdict, printLiveReport } from "./live-report.ts";

loadDotenv();

const result = await new RieltorSource().inspectLatest({ limit: 10 });
const verdict = printLiveReport("RIELTOR", result, ["coordinates", "sellerTypeKnown"]);
exitByVerdict([verdict]);
