import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import tar from 'tar-stream';
import type { Header, Pack } from 'tar-stream';
import type { CopyProgress } from './copy-progress';

// One local entry under its archive name; `other` (a socket, a device, a
// FIFO) is left out of the archive.
export interface LocalEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'directory' | 'file' | 'symlink' | 'other';
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
}

type EntryHeader = Readonly<Partial<Header> & Pick<Header, 'name'>>;

const ENTRY_KINDS = [
  ['directory', 'isDirectory'],
  ['symlink', 'isSymbolicLink'],
  ['file', 'isFile'],
] as const;

// path and everything under it, parents first; the top entry is named after
// path's base, as `imp-agent tar extract` expects
export async function listLocalEntries(path: string): Promise<readonly LocalEntry[]> {
  const entries: LocalEntry[] = [];

  const collectEntries = async (current: string, name: string): Promise<void> => {
    const stats = await lstat(current);

    entries.push({
      path: current,
      name,
      kind: ENTRY_KINDS.find(([, test]) => stats[test]())?.[0] ?? 'other',
      size: stats.size,
      mode: stats.mode & 0o7777,
      mtimeMs: stats.mtimeMs,
    });

    if (stats.isDirectory()) {
      const children = await readdir(current);

      for (const child of children.toSorted()) {
        await collectEntries(join(current, child), `${name}/${child}`);
      }
    }
  };

  await collectEntries(path, basename(path));

  return entries;
}

export function countFileBytes(entries: readonly LocalEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size : 0), 0);
}

// adds an entry and resolves once the pack has taken all of it
async function writeEntryContent(
  pack: Pack,
  header: EntryHeader,
  content: Readonly<AsyncIterable<Uint8Array>> | null,
  progress: CopyProgress,
): Promise<void> {
  const written = Promise.withResolvers<void>();

  const sink = pack.entry({ ...header }, (failure) => {
    if (failure === null || failure === undefined) {
      written.resolve();
    } else {
      written.reject(failure);
    }
  });

  if (content !== null) {
    for await (const chunk of content) {
      progress.add(chunk.byteLength);

      if (!sink.write(chunk)) {
        const drained = Promise.withResolvers<void>();

        sink.once('drain', drained.resolve);

        await drained.promise;
      }
    }

    sink.end(null);
  }

  await written.promise;
}

async function writeEntry(
  pack: Pack,
  entry: LocalEntry,
  progress: CopyProgress,
  warn: (text: string) => void,
): Promise<void> {
  const mode = entry.mode;

  const mtime = new Date(entry.mtimeMs);

  if (entry.kind === 'directory') {
    await writeEntryContent(
      pack,
      { name: `${entry.name}/`, type: 'directory', mode, mtime },
      null,
      progress,
    );
  } else if (entry.kind === 'symlink') {
    const linkname = await readlink(entry.path);

    await writeEntryContent(
      pack,
      { name: entry.name, type: 'symlink', linkname, mode, mtime },
      null,
      progress,
    );
  } else if (entry.kind === 'file') {
    const header = { name: entry.name, type: 'file', size: entry.size, mode, mtime } as const;

    await writeEntryContent(pack, header, createReadStream(entry.path), progress);
  } else {
    warn(`${entry.path}: not a file, directory or symlink; left out`);
  }
}

// Packs entries as a tar and hands each chunk to send, which applies the
// backpressure: the pack waits while send does.
export async function writeLocalEntries(
  entries: readonly LocalEntry[],
  send: (chunk: Uint8Array) => Promise<void>,
  progress: CopyProgress,
  warn: (text: string) => void,
): Promise<void> {
  const pack = tar.pack();

  const sendPacked = async (): Promise<void> => {
    for await (const chunk of pack) {
      if (chunk instanceof Uint8Array) {
        await send(chunk);
      }
    }
  };

  const sending = sendPacked();

  try {
    for (const entry of entries) {
      await writeEntry(pack, entry, progress, warn);
    }

    pack.finalize();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));

    pack.destroy(failure);
  }

  await sending;
}
