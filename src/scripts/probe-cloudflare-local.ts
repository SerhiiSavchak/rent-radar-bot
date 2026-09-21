import { config as loadDotenv } from "dotenv";
import { runFixtureProbe, runLiveOlxProbe } from "../probe/cloudflare-source-probe.ts";

loadDotenv();

const mode = process.argv[2] ?? "fixtures";
if (mode === "live-olx") {
  const live = await runLiveOlxProbe();
  const report = { ...runFixtureProbe("local-node"), liveOlx: live };
  console.log(JSON.stringify(report, null, 2));
} else if (mode === "fixtures") {
  console.log(JSON.stringify(runFixtureProbe("local-node"), null, 2));
} else {
  console.error("usage: probe-cloudflare-local.ts [fixtures|live-olx]");
  process.exitCode = 1;
}
