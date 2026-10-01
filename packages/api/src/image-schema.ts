import * as z from 'zod';
import { NameSchema } from './name-schema';

export const ImageSchema = z.object({
  id: z.string(),
  name: NameSchema,
  ref: z.string(),
  digest: z.string(),
  createdAt: z.date(),
  sizeBytes: z.int().nonnegative(),
});

export type Image = z.infer<typeof ImageSchema>;
