import { z } from "zod";

export const listingSourceSchema = z.enum(["olx", "domria", "lun"]);
export type ListingSource = z.infer<typeof listingSourceSchema>;

export const propertyTypeSchema = z.enum(["apartment", "house", "unknown"]);
export type PropertyType = z.infer<typeof propertyTypeSchema>;

export const sellerTypeSchema = z.enum(["owner", "agent", "business", "unknown"]);
export type SellerType = z.infer<typeof sellerTypeSchema>;

export const pricePeriodSchema = z.enum(["month", "day", "unknown"]);
export type PricePeriod = z.infer<typeof pricePeriodSchema>;

export const listingPriceSchema = z.object({
  amount: z.number().finite(),
  currency: z.string().min(1),
  period: pricePeriodSchema.optional(),
});
export type ListingPrice = z.infer<typeof listingPriceSchema>;

export const listingLocationSchema = z.object({
  raw: z.string(),
  city: z.string().optional(),
  district: z.string().optional(),
  latitude: z.number().finite().optional(),
  longitude: z.number().finite().optional(),
});
export type ListingLocation = z.infer<typeof listingLocationSchema>;

export const sellerConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);
export type SellerConfidence = z.infer<typeof sellerConfidenceSchema>;

export const listingSchema = z.object({
  source: listingSourceSchema,
  sourceId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  description: z.string().optional(),
  price: listingPriceSchema.optional(),
  location: listingLocationSchema,
  propertyType: propertyTypeSchema,
  sellerType: sellerTypeSchema,
  sellerConfidence: sellerConfidenceSchema.optional(),
  sellerEvidence: z.array(z.string()).optional(),
  publishedAt: z.date().optional(),
  discoveredAt: z.date(),
  images: z.array(z.string()).optional(),
  distanceKm: z.number().finite().optional(),
  rooms: z.number().finite().optional(),
  areaM2: z.number().finite().optional(),
  possibleDuplicateOf: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Listing = z.infer<typeof listingSchema>;

export function parseListing(input: unknown): Listing {
  return listingSchema.parse(input);
}
