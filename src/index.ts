import { refuseUnsafeOneshot } from "./entry/production-entrypoint.ts";
import { logger } from "./utils/logger.ts";

const refusal = refuseUnsafeOneshot();
logger.error("phase0.refused", {
  exitCode: refusal.exitCode,
  canonicalEntrypoint: refusal.canonicalEntrypoint,
  message: refusal.message,
});
process.exit(refusal.exitCode);
