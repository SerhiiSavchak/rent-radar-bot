const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export type CoordinateValidation =
  | { ok: true; latitude: number; longitude: number; swapped: boolean }
  | { ok: false; reason: "missing" | "zero" | "out-of-range" | "malformed" };

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Accepts WGS84 points in Ukraine. LUN JSON-LD currently swaps lat/lng around Lviv.
 */
export function validateCoordinates(
  latitude: unknown,
  longitude: unknown,
): CoordinateValidation {
  let lat = toFiniteNumber(latitude);
  let lng = toFiniteNumber(longitude);
  if (lat === undefined || lng === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (lat === 0 && lng === 0) {
    return { ok: false, reason: "zero" };
  }
  let swapped = false;
  const looksSwapped = lat > 15 && lat < 43 && lng > 43 && lng < 55;
  if (looksSwapped) {
    const tmp = lat;
    lat = lng;
    lng = tmp;
    swapped = true;
  }
  const inUkraine = lat >= 44 && lat <= 53 && lng >= 22 && lng <= 41;
  if (!inUkraine) {
    return { ok: false, reason: "out-of-range" };
  }
  return { ok: true, latitude: lat, longitude: lng, swapped };
}

export function normalizeLatLng(
  latitude: number | undefined,
  longitude: number | undefined,
): { latitude?: number; longitude?: number } {
  const validated = validateCoordinates(latitude, longitude);
  if (!validated.ok) {
    return {};
  }
  return { latitude: validated.latitude, longitude: validated.longitude };
}
