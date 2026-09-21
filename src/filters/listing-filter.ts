import type { Listing, PropertyType } from "../domain/listing.ts";
import type { AppConfig } from "../config/env.ts";
import { filterByLocation } from "./location-filter.ts";
import { isSellerEligible, sellerRejectionReason } from "./owner-filter.ts";
import { detectPropertyType } from "./property-type.ts";

export type ListingFilterOptions = {
  ownerOnly?: boolean;
  propertyTypes?: PropertyType[];
  requireCoordinates?: boolean;
};

export type FilteredListing = {
  listing: Listing;
  accepted: boolean;
  locationMatched: boolean;
  locationReason: string;
  distanceKm?: number;
  ownerMatched: boolean;
  sellerEligible: boolean;
  sellerRejectionReason?: string;
  propertyMatched: boolean;
  tooOld: boolean;
};

export function applyListingFilters(
  listings: Listing[],
  config: AppConfig,
  options: ListingFilterOptions = {},
): FilteredListing[] {
  const propertyTypes = options.propertyTypes ?? config.propertyTypes;
  const unknownPolicy =
    options.requireCoordinates === true ? "exclude" : config.geoUnknownPolicy;

  return listings.map((listing) => {
    const location = filterByLocation(
      {
        latitude: listing.location.latitude,
        longitude: listing.location.longitude,
        ...(listing.location.city !== undefined ? { city: listing.location.city } : {}),
      },
      {
        centerLat: config.targetLat,
        centerLng: config.targetLng,
        radiusKm: config.targetRadiusKm,
        unknownPolicy,
      },
    );
    const sellerEligible = isSellerEligible(listing, {
      policy: config.sellerPolicy,
      acceptSelfDeclared: config.ownerAcceptSelfDeclared === true,
    });
    const rejection = sellerEligible ? undefined : sellerRejectionReason(listing);
    const propertyMatched = propertyTypes.includes(listing.propertyType);
    const tooOld = isTooOld(listing, config.maxListingAgeMinutes);
    const accepted =
      location.matched && propertyMatched && sellerEligible && !tooOld;
    const withDistance: Listing =
      location.distanceKm === undefined
        ? listing
        : { ...listing, distanceKm: location.distanceKm };
    return {
      listing: withDistance,
      accepted,
      locationMatched: location.matched,
      locationReason: location.reason,
      ...(location.distanceKm !== undefined ? { distanceKm: location.distanceKm } : {}),
      ownerMatched: sellerEligible,
      sellerEligible,
      ...(rejection ? { sellerRejectionReason: rejection } : {}),
      propertyMatched,
      tooOld,
    };
  });
}

function isTooOld(listing: Listing, maxMinutes: number | undefined): boolean {
  if (!maxMinutes || !listing.publishedAt) {
    return false;
  }
  const ageMs = Date.now() - listing.publishedAt.getTime();
  return ageMs > maxMinutes * 60_000;
}

export { detectPropertyType };
