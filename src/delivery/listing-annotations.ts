import type { Listing } from "../domain/listing.ts";
import { readProvenance } from "../domain/provenance.ts";
import { sellerAssessmentFromListing } from "../filters/owner-filter.ts";

/** Attach explainable seller assessment and normalized provenance without dropping existing metadata. */
export function annotateListing(listing: Listing): Listing {
  return {
    ...listing,
    metadata: {
      ...listing.metadata,
      provenance: readProvenance(listing),
      sellerAssessment: sellerAssessmentFromListing(listing),
    },
  };
}
