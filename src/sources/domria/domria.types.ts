import { z } from "zod";

export const domriaSearchResponseSchema = z
  .object({
    items: z.array(z.union([z.number(), z.string()])).optional(),
    count: z.number().optional(),
  })
  .passthrough();

export const domriaInfoSchema = z
  .object({
    realty_id: z.union([z.number(), z.string()]).optional(),
    beautiful_url: z.string().optional(),
    beautifulUrl: z.string().optional(),
    description: z.string().optional(),
    description_uk: z.string().optional(),
    price: z.union([z.number(), z.string()]).optional(),
    priceArr: z.record(z.string(), z.string()).optional(),
    currency_type: z.string().optional(),
    latitude: z.union([z.number(), z.string()]).optional(),
    longitude: z.union([z.number(), z.string()]).optional(),
    city_name_uk: z.string().optional(),
    city_name: z.string().optional(),
    district_name_uk: z.string().optional(),
    district_name: z.string().optional(),
    street_name_uk: z.string().optional(),
    street_name: z.string().optional(),
    publishing_date: z.string().optional(),
    publishingDate: z.string().optional(),
    realty_type_id: z.number().optional(),
    realty_type_name_uk: z.string().optional(),
    advert_type_name_uk: z.string().optional(),
    advert_type_name: z.string().optional(),
    agency_id: z.union([z.number(), z.string()]).optional(),
    user_id: z.union([z.number(), z.string()]).optional(),
    characteristics_values: z.record(z.string(), z.unknown()).optional(),
    main_photo: z.string().optional(),
    photos: z.unknown().optional(),
  })
  .passthrough();

export type DomriaInfo = z.infer<typeof domriaInfoSchema>;

export const DOMRIA_OFFER_TYPE: Record<string, string> = {
  "1434": "від посередника",
  "1435": "від представника власника (без комісійних)",
  "1436": "від власника",
  "1473": "від представника забудовника",
  "1506": "від забудовника",
};
