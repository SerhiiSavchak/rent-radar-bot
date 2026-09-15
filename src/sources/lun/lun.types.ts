import { z } from "zod";

export const lunCardSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    urlRaw: z.string().optional(),
    insertTime: z.string().optional(),
    downloadTime: z.string().optional(),
    price: z.number().optional(),
    currency: z.string().optional(),
    roomCount: z.number().optional(),
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
    rieltorContact: z.unknown().optional(),
    site: z
      .object({
        displayName: z.string().optional(),
        internalName: z.string().optional(),
      })
      .passthrough()
      .optional(),
    images: z.array(z.object({ imageId: z.number().optional() }).passthrough()).optional(),
  })
  .passthrough();

export type LunCard = z.infer<typeof lunCardSchema>;
