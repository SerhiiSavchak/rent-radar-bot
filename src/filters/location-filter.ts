import { haversineKm, validateCoordinates } from "../utils/geo.ts";
import type { GeoUnknownPolicy } from "../config/env.ts";

export type LocationFilterInput = {
  latitude?: number | undefined;
  longitude?: number | undefined;
  city?: string | undefined;
};

export type LocationFilterConfig = {
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  unknownPolicy: GeoUnknownPolicy;
};

export type LocationFilterResult = {
  matched: boolean;
  reason:
    | "within-radius"
    | "outside-radius"
    | "no-coordinates"
    | "invalid-coordinates"
    | "allowed-missing-coordinates";
  distanceKm?: number;
};

export function filterByLocation(
  input: LocationFilterInput,
  config: LocationFilterConfig,
): LocationFilterResult {
  const validated = validateCoordinates(input.latitude, input.longitude);
  if (!validated.ok) {
    if (config.unknownPolicy === "include") {
      return { matched: true, reason: "allowed-missing-coordinates" };
    }
    return {
      matched: false,
      reason: validated.reason === "malformed" || validated.reason === "missing" ? "no-coordinates" : "invalid-coordinates",
    };
  }

  const distanceKm = haversineKm(
    config.centerLat,
    config.centerLng,
    validated.latitude,
    validated.longitude,
  );
  if (distanceKm <= config.radiusKm) {
    return { matched: true, reason: "within-radius", distanceKm };
  }
  return { matched: false, reason: "outside-radius", distanceKm };
}
