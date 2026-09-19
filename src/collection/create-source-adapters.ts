import type { AppConfig } from "../config/env.ts";
import type { ListingSourceAdapter } from "../domain/source.ts";
import { DomriaSource } from "../sources/domria/domria.source.ts";
import { LunSource } from "../sources/lun/lun.source.ts";
import { OlxBrowserSource } from "../sources/olx/olx-browser.source.ts";
import { OlxSource } from "../sources/olx/olx.source.ts";
import { RieltorSource } from "../sources/rieltor/rieltor.source.ts";

export type CollectionAdapterOverrides = {
  domria?: ListingSourceAdapter;
  lun?: ListingSourceAdapter;
  rieltor?: ListingSourceAdapter;
  olxBrowser?: ListingSourceAdapter;
  olxHttp?: ListingSourceAdapter;
};

export function isOlxCollectionEnabled(config: Pick<AppConfig, "enableOlx" | "enableOlxBrowser">): boolean {
  return config.enableOlxBrowser || config.enableOlx;
}

/**
 * Enabled sources only. When browser mode is on, OLX HTTP is omitted —
 * there is no silent fallback to api/v1/offers.
 */
export function createCollectionAdapters(
  config: Pick<AppConfig, "enableDomria" | "enableLun" | "enableRieltor" | "enableOlx" | "enableOlxBrowser">,
  overrides: CollectionAdapterOverrides = {},
): ListingSourceAdapter[] {
  const adapters: ListingSourceAdapter[] = [];
  if (config.enableDomria) {
    adapters.push(overrides.domria ?? new DomriaSource());
  }
  if (config.enableLun) {
    adapters.push(overrides.lun ?? new LunSource());
  }
  if (config.enableRieltor) {
    adapters.push(overrides.rieltor ?? new RieltorSource());
  }
  if (config.enableOlxBrowser) {
    adapters.push(overrides.olxBrowser ?? new OlxBrowserSource());
  } else if (config.enableOlx) {
    adapters.push(overrides.olxHttp ?? new OlxSource());
  }
  return adapters;
}
