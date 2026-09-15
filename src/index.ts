import { config as loadDotenv } from "dotenv";
import { getConfig } from "./config/env.ts";
import { ListingMonitorService } from "./services/listing-monitor.service.ts";
import { closeDb } from "./storage/db.ts";
import { DomriaSource } from "./sources/domria/domria.source.ts";
import { LunSource } from "./sources/lun/lun.source.ts";
import { OlxSource } from "./sources/olx/olx.source.ts";
import { RieltorSource } from "./sources/rieltor/rieltor.source.ts";
import { logger } from "./utils/logger.ts";

loadDotenv();

const config = getConfig();
const monitor = new ListingMonitorService(
  [new OlxSource(), new DomriaSource(), new LunSource(), new RieltorSource()],
  config,
);

const shutdown = () => {
  closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

logger.info("phase0.oneshot", {
  city: config.targetCity,
  radiusKm: config.targetRadiusKm,
  pollIntervalSeconds: config.pollIntervalSeconds,
});
const fresh = await monitor.collectNewListings();
logger.info("phase0.done", { newListings: fresh.length });
closeDb();
