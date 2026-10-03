import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { posix } from 'node:path';
import tar from 'tar-stream';
import type { Extract, Header, Pack } from 'tar-stream';

// A context impd will not build: the client's mistake, answered as such.
export class BuildContextError extends Error {
  override name = 'BuildContextError';
}

type Source = Extract extends AsyncIterable<infer Entry> ? Entry : never;

// a failed write of the rewrite, which stops the read of the upload
interface WriteFailure {
  error?: Error;
}

export interface CheckedContext {
  // the path in the context of the Dockerfile the engine will read
  readonly dockerfilePath: string;

  // its text: the bytes impd checks are the bytes the engine builds
  readonly dockerfile: string;
}

// The pax records a context may carry: tar-stream applies path, linkpath and
// size, and the rest only describe the entry. Any other record, such as a
// sparse map or an ACL, refuses the context.
const KNOWN_PAX = new Set([
  'path',
  'linkpath',
  'size',
  'mtime',
  'atime',
  'ctime',
  'uid',
  'gid',
  'uname',
  'gname',
  'comment',
  'charset',
  'hdrcharset',
]);

const XATTR_PREFIXES = ['SCHILY.xattr.', 'LIBARCHIVE.xattr.'];

type EntryType = 'file' | 'directory' | 'symlink';

// The name an extractor writes the entry at: `./a//b/` is `a/b`. Refuses
// a name that leaves the context or that no extractor writes as given.
function normalizeEntryName(name: string): string {
  if (name === '' || name.includes('\0')) {
    throw new BuildContextError(`the build context has an entry named ${JSON.stringify(name)}`);
  }

  if (name.startsWith('/') || name.split('/').includes('..')) {
    throw new BuildContextError(
      `the build context entry ${JSON.stringify(name)} leaves the context`,
    );
  }

  return posix.normalize(name).replace(/\/$/v, '');
}

function readEntryType(header: Readonly<Header>): EntryType {
  if (header.type === 'symlink' && !header.linkname) {
    throw new BuildContextError(
      `the build context symlink ${JSON.stringify(header.name)} has no target`,
    );
  }

  if (header.type === 'file' || header.type === 'directory' || header.type === 'symlink') {
    return header.type;
  }

  if (header.type === 'link') {
    throw new BuildContextError(
      `the build context entry ${JSON.stringify(header.name)} is a hard link; send the file itself`,
    );
  }

  throw new BuildContextError(
    `the build context entry ${JSON.stringify(header.name)} is a ${header.type}, not a file, directory or symlink`,
  );
}

// Drops user.* xattrs; refuses security.* and every other namespace, since
// a COPY from the context must never carry capabilities or ACLs.
function checkPax(name: string, pax: unknown): void {
  if (typeof pax !== 'object' || pax === null) {
    return;
  }

  for (const key of Object.keys(pax)) {
    const prefix = XATTR_PREFIXES.find((candidate) => key.startsWith(candidate));

    if (prefix !== undefined) {
      if (key.slice(prefix.length).startsWith('user.')) {
        continue;
      }

      throw new BuildContextError(
        `the build context entry ${JSON.stringify(name)} carries the xattr ${key.slice(prefix.length)}`,
      );
    }

    if (!KNOWN_PAX.has(key)) {
      throw new BuildContextError(
        `the build context entry ${JSON.stringify(name)} carries the pax record ${key}`,
      );
    }
  }
}

// the entry as the rewrite writes it: whole seconds, permission bits only,
// and no pax records but the long name or link target tar-stream adds itself
function buildHeader(header: Readonly<Header>, name: string, type: EntryType): Header {
  return {
    name: type === 'directory' ? `${name}/` : name,
    type,
    size: type === 'file' ? header.size : 0,
    mode: header.mode & 0o7777,
    mtime: new Date(Math.floor(header.mtime.getTime() / 1000) * 1000),
    linkname: type === 'symlink' ? header.linkname : '',
    uid: header.uid,
    gid: header.gid,
    uname: header.uname,
    gname: header.gname,
    devmajor: 0,
    devminor: 0,
  };
}

// the paths the Dockerfile frontend reads, in its order: the name asked
// for, then `dockerfile` beside it when that name is Dockerfile
export function listDockerfileCandidates(dockerfilePath: string): string[] {
  if (posix.basename(dockerfilePath) !== 'Dockerfile') {
    return [dockerfilePath];
  }

  return [dockerfilePath, posix.join(posix.dirname(dockerfilePath), 'dockerfile')];
}

function listParents(name: string): string[] {
  const parts = name.split('/');

  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
}

// Every entry sits under directories only: an extractor writes an entry
// under a symlink through it, and one under a file not at all.
function checkParents(types: ReadonlyMap<string, EntryType>): void {
  for (const name of types.keys()) {
    for (const parent of listParents(name)) {
      const type = types.get(parent);

      if (type !== undefined && type !== 'directory') {
        throw new BuildContextError(
          `the build context entry ${JSON.stringify(name)} is under the ${type} ${JSON.stringify(parent)}`,
        );
      }
    }
  }
}

// The Dockerfile the frontend reads: the first candidate the context has,
// which must be a regular file.
function pickDockerfile(
  candidates: readonly string[],
  types: ReadonlyMap<string, EntryType>,
  texts: ReadonlyMap<string, string | null>,
  maxBytes: number,
): CheckedContext {
  for (const candidate of candidates) {
    const type = types.get(candidate);

    if (type === undefined) {
      continue;
    }

    const text = texts.get(candidate);

    if (type !== 'file' || text === undefined) {
      throw new BuildContextError(`${candidate} in the build context is a ${type}, not a file`);
    }

    if (text === null) {
      throw new BuildContextError(
        `${candidate} in the build context is larger than ${String(maxBytes)} bytes`,
      );
    }

    return { dockerfilePath: candidate, dockerfile: text };
  }

  throw new BuildContextError(`there is no ${candidates[0] ?? 'Dockerfile'} in the build context`);
}

// copies the entry's data to sink; returns its text when keepText is set
async function writeEntryData(
  entry: Readonly<AsyncIterable<unknown>>,
  sink: (chunk: Uint8Array) => Promise<void>,
  keepText: boolean,
): Promise<string> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of entry) {
    if (chunk instanceof Uint8Array) {
      if (keepText) {
        chunks.push(chunk);
      }

      await sink(chunk);
    }
  }

  return keepText ? new TextDecoder().decode(Bun.concatArrayBuffers(chunks)) : '';
}

// the entries of the tar, with a parse failure as the client's mistake; a
// failed write of the rewrite stops the read and is thrown as it is
async function* readEntries(
  extract: Extract,
  writeFailure: Readonly<WriteFailure>,
): AsyncGenerator<Source> {
  try {
    for await (const entry of extract) {
      yield entry;
    }
  } catch (error) {
    if (writeFailure.error !== undefined) {
      throw writeFailure.error;
    }

    const message = error instanceof Error ? error.message : String(error);

    throw new BuildContextError(`the build context is not a tar: ${message}`);
  }
}

// adds an entry and hands it each chunk, waiting while the pack is full
function openEntry(pack: Pack, header: Readonly<Header>) {
  const written = Promise.withResolvers<void>();

  const sink = pack.entry({ ...header }, (failure) => {
    if (failure === null || failure === undefined) {
      written.resolve();
    } else {
      written.reject(failure);
    }
  });

  return {
    write: async (chunk: Uint8Array): Promise<void> => {
      if (!sink.write(chunk)) {
        const drained = Promise.withResolvers<void>();

        // a destroyed pack, after a failed write, never drains
        sink.once('drain', drained.resolve);
        sink.once('close', drained.resolve);

        await drained.promise;
      }
    },
    end: async (): Promise<void> => {
      sink.end(null);

      await written.promise;
    },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// Writes the tar at inputPath again at outputPath, which must not exist yet,
// and returns the Dockerfile the engine will read from it. Refuses what an
// extractor could read another way than impd does (docs/guides/images.md).
export async function writeBuildContext(
  inputPath: string,
  outputPath: string,
  dockerfilePath: string,
  maxDockerfileBytes: number,
): Promise<CheckedContext> {
  const candidates = listDockerfileCandidates(dockerfilePath);

  const types = new Map<string, EntryType>();
  const texts = new Map<string, string | null>();

  const extract = tar.extract();
  const pack = tar.pack();

  const output = await open(outputPath, 'wx', 0o600);

  const writeFailure: WriteFailure = {};

  const writing = (async () => {
    try {
      for await (const chunk of pack) {
        if (chunk instanceof Uint8Array) {
          await output.write(chunk);
        }
      }
    } catch (error) {
      writeFailure.error = toError(error);

      pack.destroy(writeFailure.error);
      extract.destroy(writeFailure.error);
    }
  })();

  const input = createReadStream(inputPath);

  input.on('error', (error) => {
    extract.destroy(error);
  });

  input.pipe(extract);

  try {
    for await (const entry of readEntries(extract, writeFailure)) {
      const type = readEntryType(entry.header);
      const name = normalizeEntryName(entry.header.name);

      checkPax(entry.header.name, entry.header.pax);

      // `./` itself: the context's root, which the engine makes anyway
      if (name === '.') {
        entry.resume();
        continue;
      }

      if (types.has(name)) {
        throw new BuildContextError(`the build context has ${JSON.stringify(name)} twice`);
      }

      types.set(name, type);

      const sink = openEntry(pack, buildHeader(entry.header, name, type));
      const isCandidate = type === 'file' && candidates.includes(name);
      const isSmall = entry.header.size <= maxDockerfileBytes;

      const text = await writeEntryData(entry, sink.write, isCandidate && isSmall);

      if (isCandidate) {
        const kept = isSmall ? text : null;

        texts.set(name, kept);
      }

      await sink.end();
    }

    checkParents(types);

    const picked = pickDockerfile(candidates, types, texts, maxDockerfileBytes);

    pack.finalize();

    await writing;

    if (writeFailure.error !== undefined) {
      throw writeFailure.error;
    }

    return picked;
  } catch (error) {
    extract.destroy();
    input.destroy();
    pack.destroy(toError(error));

    await writing;

    throw error;
  } finally {
    await output.close();
  }
}
