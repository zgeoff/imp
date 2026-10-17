import { resolve } from 'node:path';
import type { Image } from '@impz/api';
import {
  MissingDockerfileError,
  countFileBytes,
  countTarBytes,
  listContextEntries,
  writeLocalEntries,
} from '@impz/local-tar';
import type { LocalEntry } from '@impz/local-tar';
import { UsageError } from '../cli/errors';
import type { ImpClient } from '../config/create-imp-client';
import { createCopyProgress } from '../cp/copy-progress';
import type { CopyProgress, ProgressOutput } from '../cp/copy-progress';
import { createBuildStatus } from './build-status';

export interface ImageBuildOptions {
  readonly dir: string;
  readonly name: string;
  readonly dockerfile: string | undefined;

  // no progress and no build output; errors still print
  readonly quiet?: boolean;

  // where the progress and the build's output go: stderr
  readonly output: ProgressOutput;
}

// A tar of the entries, made as impd reads it: the pack waits while the
// upload does, so a large context never sits in memory.
export function createContextStream(
  entries: readonly LocalEntry[],
  progress: CopyProgress,
  warn: (text: string) => void,
): ReadableStream<Uint8Array> {
  const pipe = new TransformStream<Uint8Array, Uint8Array>();

  const writer = pipe.writable.getWriter();

  const send = async (chunk: Uint8Array): Promise<void> => {
    await writer.ready;

    await writer.write(chunk);
  };

  // the stream errors with the pack's failure, which fails the upload
  const writeEntries = async (): Promise<void> => {
    try {
      await writeLocalEntries(entries, send, progress, warn);

      await writer.close();
    } catch (error) {
      await writer.abort(error);
    }
  };

  void writeEntries();

  return pipe.readable;
}

// `impz image build <dir>`: packs the directory here, honoring its
// .dockerignore, and uploads it for impd to build
export async function runImageBuild(
  client: ImpClient,
  options: Readonly<ImageBuildOptions>,
): Promise<Image> {
  const dockerfile = options.dockerfile ?? 'Dockerfile';

  const entries = await listContextEntries(resolve(options.dir), dockerfile).catch(
    (error: unknown) => {
      throw error instanceof MissingDockerfileError ? new UsageError(error.message) : error;
    },
  );

  const quiet = options.quiet === true;

  // the upload's line is for a terminal only
  const output = { ...options.output, isTTY: options.output.isTTY && !quiet };

  const writeWarning = (text: string): void => {
    options.output.write(`impz image build: ${text}\n`);
  };

  const progress = createCopyProgress(output, Date.now, 'impz image build');
  const status = createBuildStatus(output, 'impz image build', quiet);

  const size = await countTarBytes(entries);

  progress.setTotal(countFileBytes(entries));

  try {
    return await client.buildImage(
      options.name,
      createContextStream(entries, progress, writeWarning),
      {
        size,
        ...(options.dockerfile !== undefined && { dockerfile: options.dockerfile }),

        // the upload's line ends where the build's starts; off a terminal
        // the upload shows as a line of its own
        onProgress: (event) => {
          if (event.phase !== 'upload' || !output.isTTY) {
            progress.finish();
            status.show(event);
          }
        },
        onLog: (line) => {
          progress.finish();
          status.printLog(line);
        },
      },
    );
  } finally {
    progress.finish();
    status.finish();
  }
}
