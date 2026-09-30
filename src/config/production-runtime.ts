import type { AppConfig } from "./env.ts";

/**
 * The only production collection shape. systemd sets these explicitly so an
 * older env file cannot turn HTTP OLX or RIELTOR back on, or turn the browser
 * catalog off.
 */
export const PRODUCTION_RUNTIME_ENV = {
  ENABLE_DOMRIA: "true",
  ENABLE_LUN: "true",
  ENABLE_OLX: "false",
  ENABLE_OLX_BROWSER: "true",
  ENABLE_RIELTOR: "false",
  GEO_UNKNOWN_POLICY: "exclude",
  TARGET_RADIUS_KM: "15",
  FIRST_RUN_MODE: "seed",
} as const;

export function matchesProductionRuntime(
  config: Pick<
    AppConfig,
    | "enableDomria"
    | "enableLun"
    | "enableOlx"
    | "enableOlxBrowser"
    | "enableRieltor"
    | "geoUnknownPolicy"
    | "targetRadiusKm"
    | "firstRunMode"
  >,
): boolean {
  return (
    config.enableDomria &&
    config.enableLun &&
    config.enableOlxBrowser &&
    !config.enableOlx &&
    !config.enableRieltor &&
    config.geoUnknownPolicy === "exclude" &&
    config.targetRadiusKm === 15 &&
    config.firstRunMode === "seed"
  );
}
