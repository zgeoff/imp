import * as z from 'zod';
import { ImageSchema } from '../schemas/image-schema';
import { NameSchema } from '../schemas/name-schema';

// `POST /images/build?name=<image>[&dockerfile=<path>]`: the body is the
// build context as a tar, streamed; the answer is the image, or an error with
// the code an oRPC call would give (docs/guides/images.md#build-an-image)
export const IMAGE_BUILD_PATH = '/images/build';

// A request that accepts this gets build events as JSON lines from the start,
// since a client's fetch gives up on minutes of silence; any other gets the
// image or the error as JSON at the end.
export const IMAGE_BUILD_STREAM_TYPE = 'application/x-ndjson';

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

// what impd is doing: reading an upload, packing an on-host context,
// building, pulling a ref, unpacking it into a disk, or copying an imp's disk
// into a template
export const ImageBuildPhaseSchema = z.enum(['upload', 'pack', 'build', 'pull', 'unpack', 'copy']);

// the most of a build's output one log event carries
export const IMAGE_BUILD_LOG_MAX_CHARS = 8192;

// A stream starts with a progress event and repeats one while the build runs;
// it ends with the image or the error. A client skips an event it does not
// know, so a newer impd can add one. `step` reads `[3/7] RUN make all`.
const ImageBuildProgressSchema = z.object({
  type: z.literal('progress'),
  phase: ImageBuildPhaseSchema,
  elapsedMs: z.number().nonnegative(),
  step: z.string().optional(),
});

// lines of the build's output as docker's plain progress prints them,
// without the last newline
const ImageBuildLogSchema = z.object({
  type: z.literal('log'),
  text: z.string().max(IMAGE_BUILD_LOG_MAX_CHARS),
});

export const ImageBuildEventSchema = z.discriminatedUnion('type', [
  ImageBuildProgressSchema,
  ImageBuildLogSchema,
  z.object({ type: z.literal('image'), image: ImageBuildResultSchema }),
  ImageBuildErrorSchema.extend({ type: z.literal('error') }),
]);

// what images.addStream and images.buildStream yield: the same progress, and
// the image last; a failure throws through the iterator, as any oRPC error

// a buildStream whose input asks for them sends log events too
export const ImageOpEventSchema = z.discriminatedUnion('type', [
  ImageBuildProgressSchema,
  ImageBuildLogSchema,
  z.object({ type: z.literal('image'), image: ImageSchema }),
]);

export type ImageOpEvent = z.infer<typeof ImageOpEventSchema>;

export type ImageBuildPhase = z.infer<typeof ImageBuildPhaseSchema>;

export type ImageBuildProgress = z.infer<typeof ImageBuildProgressSchema>;

export type ImageBuildLog = z.infer<typeof ImageBuildLogSchema>;

export type ImageBuildEvent = z.input<typeof ImageBuildEventSchema>;
