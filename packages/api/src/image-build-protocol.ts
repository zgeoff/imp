import * as z from 'zod';
import { ImageSchema } from './image-schema';
import { NameSchema } from './name-schema';

// `POST /images/build?name=<image>[&dockerfile=<path>]`: the body is the
// build context as a tar, streamed; the answer is the image, or an error with
// the code an oRPC call would give (docs/guides/images.md#build-an-image)
export const IMAGE_BUILD_PATH = '/images/build';

// a path inside the context: never absolute, never out of it through `..`
export const DockerfilePathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split(/[/\\]/u).includes('..'), {
    message: 'the Dockerfile path must be relative and stay inside the build context',
  });

export const ImageBuildQuerySchema = z.object({
  name: NameSchema,
  dockerfile: DockerfilePathSchema.optional(),
});

export type ImageBuildQuery = z.infer<typeof ImageBuildQuerySchema>;

// the image as JSON carries its date as a string
export const ImageBuildResultSchema = ImageSchema.extend({ createdAt: z.coerce.date() });
export const ImageBuildErrorSchema = z.object({ code: z.string(), message: z.string() });
