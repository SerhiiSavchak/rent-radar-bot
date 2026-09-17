import { z } from "zod";

export const olxUserSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    name: z.string().optional(),
    is_online: z.boolean().optional(),
    company_name: z.string().nullable().optional(),
    sellerType: z.string().nullable().optional(),
    uuid: z.string().optional(),
  })
  .passthrough();

export const olxLocationSchema = z
  .object({
    city: z
      .object({
        name: z.string().optional(),
        id: z.union([z.number(), z.string()]).optional(),
      })
      .passthrough()
      .optional(),
    region: z
      .object({
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    district: z
      .object({
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
  })
  .passthrough();

export const olxMapSchema = z
  .object({
    lat: z.number().optional(),
    lon: z.number().optional(),
    // OLX publishes approximate coordinates: radius (km) > 0 or zoom hints that the pin is fuzzy.
    radius: z.number().optional(),
    zoom: z.number().optional(),
    show_detailed: z.boolean().optional(),
  })
  .passthrough();

export const olxParamSchema = z
  .object({
    key: z.string().optional(),
    name: z.string().optional(),
    value: z.unknown().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const olxOfferSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    created_time: z.string().optional(),
    last_refresh_time: z.string().optional(),
    pushup_time: z.string().nullable().optional(),
    business: z.boolean().optional(),
    params: z.array(olxParamSchema).optional(),
    location: olxLocationSchema.optional(),
    map: olxMapSchema.optional(),
    user: olxUserSchema.optional(),
    photos: z.array(z.object({ link: z.string().optional() }).passthrough()).optional(),
    category: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const olxOffersResponseSchema = z
  .object({
    data: z.array(olxOfferSchema).optional(),
    links: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

export type OlxOffer = z.infer<typeof olxOfferSchema>;
export type OlxOffersResponse = z.infer<typeof olxOffersResponseSchema>;
