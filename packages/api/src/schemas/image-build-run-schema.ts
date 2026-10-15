import * as z from 'zod';
import { ImageBuildPhaseSchema } from '../protocols/image-build-protocol';
import { NameSchema } from './name-schema';

// `upload` packs the context on the client; `host` packs a directory on the
// impd host
export const ImageBuildSourceSchema = z.enum(['upload', 'host']);

// A build impd runs now, as images.builds lists it: the image it makes, when
// its call came, what it does, the Dockerfile step it runs once one has
// started, and the builder imp of an isolated build once it has one.
export const ImageBuildRunSchema = z.object({
  name: NameSchema,
  source: ImageBuildSourceSchema,
  startedAt: z.date(),
  phase: ImageBuildPhaseSchema,
  step: z.string().nullable(),
  builder: z.string().nullable(),
});

export type ImageBuildRun = z.infer<typeof ImageBuildRunSchema>;

export type ImageBuildSource = z.infer<typeof ImageBuildSourceSchema>;
