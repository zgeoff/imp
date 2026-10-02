import * as z from 'zod';
import { NameSchema } from './name-schema';

// A private network between imps (docs/guides/networks.md). Its name is a
// DNS label: an imp on it is `<imp>.<network>.internal` to the others.
export const NetworkSchema = z.object({
  name: NameSchema,

  // its imps, sorted
  imps: z.array(NameSchema).readonly(),
  createdAt: z.date(),
});

export type Network = z.infer<typeof NetworkSchema>;

// what one imp may join at its create
export const MAX_CREATE_NETWORKS = 16;
