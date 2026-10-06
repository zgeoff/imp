import { ORPCError } from '@orpc/server';

// A build's export past IMP_BUILD_IMAGE_MAX_MIB, or with more entries than
// IMP_BUILD_IMAGE_MAX_FILES
export class ImageLimitError extends ORPCError<'BAD_REQUEST', undefined> {
  override readonly name = 'ImageLimitError';

  constructor(limit: 'bytes' | 'files', max: number) {
    const over =
      limit === 'bytes'
        ? `over ${String(Math.floor(max / 1024 ** 2))} MiB (IMP_BUILD_IMAGE_MAX_MIB)`
        : `over ${String(max)} files (IMP_BUILD_IMAGE_MAX_FILES)`;

    super('BAD_REQUEST', { message: `the built image's filesystem is ${over}` });
  }
}
