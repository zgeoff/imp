import { resolve } from 'node:path';
import type { Image } from '@imp/api';
import { createCopyProgress } from '../cp/copy-progress';
import type { CopyProgress } from '../cp/copy-progress';
import { countFileBytes, writeLocalEntries } from '../cp/pack-local-path';
import type { LocalEntry } from '../cp/pack-local-path';
import type { ImpClient } from '../create-imp-client';
import { listContextEntries } from './pack-build-context';

export interface ImageBuildOptions {
  readonly dir: string;
  readonly name: string;
  readonly dockerfile: string | undefined;
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

function writeWarning(text: string): void {
  process.stderr.write(`imp image build: ${text}\n`);
}

// `imp image build <dir>`: packs the directory here, honoring its
// .dockerignore, and uploads it for impd to build
export async function runImageBuild(
  client: ImpClient,
  options: Readonly<ImageBuildOptions>,
): Promise<Image> {
  const dockerfile = options.dockerfile ?? 'Dockerfile';

  const entries = await listContextEntries(resolve(options.dir), dockerfile);

  const progress = createCopyProgress(
    {
      isTTY: process.stderr.isTTY,
      write: (text) => {
        process.stderr.write(text);
      },
    },
    Date.now,
    'imp image build',
  );

  progress.setTotal(countFileBytes(entries));

  try {
    return await client.buildImage(
      options.name,
      createContextStream(entries, progress, writeWarning),
      {
        ...(options.dockerfile !== undefined && { dockerfile: options.dockerfile }),
      },
    );
  } finally {
    progress.finish();
  }
}
