import * as z from 'zod';

export const CheckpointSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  createdAt: z.date(),
  sizeBytes: z.int().nonnegative().optional(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;
