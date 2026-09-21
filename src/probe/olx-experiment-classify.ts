import type { FetchListingsOptions, FetchResultKind } from "../domain/source.ts";
import { isOlxTransportBlocked } from "./cloudflare-source-probe.ts";

/** Lviv long-term apartment rent HTML catalog (diagnostic fallback only). */
export const OLX_HTML_APARTMENTS_URL =
  "https://www.olx.ua/uk/nedvizhimost/kvartiry/dolgosrochnaya-arenda-kvartir/lvov/";

/** Lviv long-term house rent HTML catalog (diagnostic fallback only). */
export const OLX_HTML_HOUSES_URL =
  "https://www.olx.ua/uk/nedvizhimost/doma/arenda-domov/lvov/";

/**
 * Pick the HTML fallback URL that matches the requested category.
 * Houses-only must not note the apartments catalog URL.
 */
export function selectOlxHtmlFallbackUrl(options?: FetchListingsOptions): string {
  const includeApartments = options?.includeApartments !== false;
  const includeHouses = options?.includeHouses !== false;
  if (includeHouses && !includeApartments) {
    return OLX_HTML_HOUSES_URL;
  }
  return OLX_HTML_APARTMENTS_URL;
}

export type OlxExperimentClassification = {
  blocked: boolean;
  success: boolean;
  failureReason?: string;
};

/**
 * Experiment-level classification for Oracle/local OLX probes.
 * API 403/429 (incl. CloudFront HTML body) → transport_blocked.
 * HTML 200 without parseable listings → parser_failure (never success).
 */
export function classifyOlxExperimentCategory(input: {
  notes: string[];
  httpStatus?: number;
  resultKind: string;
  listingCount: number;
}): OlxExperimentClassification {
  const blocked = isOlxTransportBlocked(input.notes, input.httpStatus);
  if (blocked || input.httpStatus === 403 || input.httpStatus === 429) {
    return { blocked: true, success: false, failureReason: "transport_blocked" };
  }
  if (input.resultKind === "parser_failure") {
    return { blocked: false, success: false, failureReason: "parser_failure" };
  }
  if (input.resultKind === "http_error") {
    return { blocked: false, success: false, failureReason: "http_error" };
  }
  if (input.resultKind === "valid_empty") {
    return {
      blocked: false,
      success: false,
      failureReason: "valid_empty_not_success_for_olx_market_probe",
    };
  }
  if (input.resultKind === "ok" && input.listingCount > 0) {
    return { blocked: false, success: true };
  }
  return { blocked: false, success: false, failureReason: "no_listings" };
}

/** Derive adapter resultKind after JSON + optional HTML diagnostic. */
export function deriveOlxInspectResultKind(input: {
  listingCount: number;
  jsonSucceeded: boolean;
  apiStatus?: number;
  htmlStatus?: number;
  notes: string[];
}): FetchResultKind {
  if (input.listingCount > 0) {
    return "ok";
  }
  if (isOlxTransportBlocked(input.notes, input.apiStatus) || input.apiStatus === 403 || input.apiStatus === 429) {
    return "http_error";
  }
  if (input.apiStatus !== undefined && input.apiStatus !== 200) {
    return "http_error";
  }
  if (input.jsonSucceeded) {
    return "valid_empty";
  }
  // HTML 200 (or any non-JSON path) without listings is not transport success.
  if (input.htmlStatus === 200 || input.apiStatus === 200) {
    return "parser_failure";
  }
  return "http_error";
}
