import { z } from "zod";

export const lunCardSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    urlRaw: z.string().optional(),
    insertTime: z.string().optional(),
    downloadTime: z.string().optional(),
    price: z.number().optional(),
    currency: z.string().optional(),
    roomCount: z.number().nullish(),
    areaTotal: z.number().nullish(),
    floor: z.number().nullish(),
    floorCount: z.number().nullish(),
    groupId: z.union([z.string(), z.number()]).nullish(),
    similarPageIds: z.array(z.union([z.number(), z.string()])).nullish(),
    hasDuplicates: z.boolean().nullish(),
    isOwner: z.boolean().nullable().optional(),
    withoutCommission: z.boolean().nullable().optional(),
    agency: z
      .object({
        name: z.string().optional(),
        id: z.union([z.number(), z.string()]).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    header: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    location: z.array(z.number()).optional(),
    sectionId: z.number().optional(),
    geoEntities: z.unknown().optional(),
    /**
     * Live catalog shape (2026-09-23). Top-level `agency` is often null while
     * the realtor role lives here. Phones are accepted so the card still parses,
     * and callers must not persist them.
     */
    rieltorContact: z
      .object({
        contactType: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        agency: z
          .object({
            name: z.string().nullable().optional(),
            url: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        activeOffers: z.number().nullable().optional(),
        isVerified: z.boolean().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    site: z
      .object({
        displayName: z.string().optional(),
        internalName: z.string().optional(),
      })
      .passthrough()
      .optional(),
    images: z
      .array(z.object({ imageId: z.union([z.number(), z.string()]).optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export type LunCard = z.infer<typeof lunCardSchema>;
