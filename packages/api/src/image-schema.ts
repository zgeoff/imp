import * as z from 'zod';
import { NameSchema } from './name-schema';

// `oci` from docker; `imp` a template, made from an imp's disk
// (docs/guides/templates.md)
export const ImageSourceSchema = z.enum(['oci', 'imp']);

export const ImageSchema = z.object({
  id: z.string(),
  name: NameSchema,
  ref: z.string(),
  digest: z.string(),
  source: ImageSourceSchema,
  createdAt: z.date(),
  sizeBytes: z.int().nonnegative(),
});

export type Image = z.infer<typeof ImageSchema>;

export type ImageSource = z.infer<typeof ImageSourceSchema>;
