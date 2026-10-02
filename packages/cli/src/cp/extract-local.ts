import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import tar from 'tar-stream';
import type { Header } from 'tar-stream';
import * as z from 'zod';
import type { CopyProgress } from './copy-progress';

// Extracts the tar `imp-agent tar create` sends into dest. The archive comes
// from the imp, which this machine does not trust: the rules, in order, are
// in docs/guides/cp.md.
export interface LocalExtractor {
  // resolves once the extract took the chunk: at once while it keeps up,
  // else when it drains
  readonly write: (chunk: Uint8Array) => Promise<void>;

  // ends the archive; resolves with the count of refused entries
  readonly end: () => Promise<number>;
}

// the PAX record `imp-agent tar create` puts on its first entry
const TotalSchema = z.object({ 'IMP.total': z.coerce.number().int().nonnegative() });

interface PendingDir {
  readonly path: string;
  readonly mode: number;
  readonly mtime: Date;
}

interface PendingSymlink {
  readonly name: string;
  readonly path: string;
  readonly target: string;
}

interface CopyRoot {
  readonly path: string;
  readonly top: string;
}

// a finished extract: the refused entries, or why it could not run
type ExtractOutcome = { readonly refused: number } | { readonly error: Error };

class RefusedError extends Error {
  override name = 'RefusedError';
}

function readErrorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// name's top component and the rest, or a refusal for a name that could
// leave the copy
function splitEntryName(name: string): readonly [string, string] {
  if (name.startsWith('/')) {
    throw new RefusedError('an absolute name');
  }

  const parts = name.split('/').filter((part) => part !== '' && part !== '.');

  if (parts.includes('..')) {
    throw new RefusedError('a name with ".."');
  }

  const [top, ...rest] = parts;

  if (top === undefined) {
    throw new RefusedError('an empty name');
  }

  return [top, rest.join('/')];
}

// keeps the permission and sticky bits, not setuid or setgid
function toSafeMode(mode: number): number {
  return mode & 0o1777;
}

// as cp -r: into dest/<top> when dest is a directory, else as dest
async function resolveCopyRoot(dest: string, top: string): Promise<CopyRoot> {
  const destStats = await stat(dest).catch(() => null);

  const path = destStats?.isDirectory() === true ? join(dest, top) : dest;

  const rootStats = await lstat(path).catch(() => null);

  if (rootStats?.isSymbolicLink() === true) {
    throw new Error(`${path} is a symlink; the copy will not go through it`);
  }

  return { path, top };
}

// every directory from root down to path's parent must be a real one
async function checkParents(root: string, path: string): Promise<void> {
  const below = path
    .slice(root.length)
    .split('/')
    .filter((part) => part !== '');

  let current = root;

  for (const part of below.slice(0, -1)) {
    current = join(current, part);

    const stats = await lstat(current).catch(() => null);

    if (stats === null) {
      throw new RefusedError(`${current} is missing`);
    }

    if (!stats.isDirectory()) {
      throw new RefusedError(`under ${current}, which is not a directory`);
    }
  }
}

export function createLocalExtractor(
  dest: string,
  progress: CopyProgress,
  warn: (text: string) => void,
): LocalExtractor {
  const extract = tar.extract();
  const dirs: PendingDir[] = [];
  const links: PendingSymlink[] = [];

  const state = {
    root: null as CopyRoot | null,
    refused: 0,
    temps: 0,
    first: true,
    stopped: false,
  };

  // writes that wait for the extract to drain, woken too when it stops
  const drainWaiters: (() => void)[] = [];

  const wakeDrainWaiters = (): void => {
    for (const wake of drainWaiters.splice(0)) {
      wake();
    }
  };

  // an extract that stopped early (its error comes from end) takes no more
  extract.on('error', () => {});
  extract.on('drain', wakeDrainWaiters);
  extract.on('close', wakeDrainWaiters);

  const buildTempPath = (path: string): string => {
    state.temps += 1;

    return join(dirname(path), `.imp-cp-${String(process.pid)}-${String(state.temps)}`);
  };

  const requireRoot = async (top: string): Promise<CopyRoot> => {
    if (state.root === null) {
      state.root = await resolveCopyRoot(dest, top);
    } else if (top !== state.root.top) {
      throw new RefusedError(`outside the copy's top ${state.root.top}`);
    }

    return state.root;
  };

  const makeDir = async (path: string, header: Readonly<Header>): Promise<void> => {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      const existing = await lstat(path).catch(() => null);

      if (readErrorCode(error) === 'EEXIST' && existing?.isDirectory() === true) {
        return;
      }

      throw error;
    }

    dirs.push({ path, mode: header.mode, mtime: header.mtime });
  };

  const writeFile = async (
    path: string,
    header: Readonly<Header>,
    content: Readonly<AsyncIterable<unknown>>,
  ): Promise<void> => {
    const temp = buildTempPath(path);

    const handle = await open(temp, 'wx', 0o600);

    try {
      for await (const chunk of content) {
        if (chunk instanceof Uint8Array) {
          progress.add(chunk.byteLength);

          await handle.write(chunk);
        }
      }

      await handle.close();

      await chmod(temp, toSafeMode(header.mode));
      await utimes(temp, header.mtime, header.mtime);
      await rename(temp, path);
    } catch (error) {
      await handle.close().catch(() => null);

      await unlink(temp).catch(() => null);

      throw error;
    }
  };

  const makeHardLink = async (root: CopyRoot, path: string, linkname: string): Promise<void> => {
    const [top, rest] = splitEntryName(linkname);

    if (top !== root.top) {
      throw new RefusedError(`a hard link to ${linkname}, outside the copy`);
    }

    const existing = join(root.path, rest);

    await checkParents(root.path, existing);

    const stats = await lstat(existing);

    if (!stats.isFile()) {
      throw new RefusedError(`a hard link to ${linkname}, not a file`);
    }

    await link(existing, path);
  };

  const writeEntry = async (
    header: Readonly<Header>,
    content: Readonly<AsyncIterable<unknown>>,
  ): Promise<void> => {
    const [top, rest] = splitEntryName(header.name);

    const root = await requireRoot(top);

    const path = rest === '' ? root.path : join(root.path, rest);

    await checkParents(root.path, path);

    if (header.type === 'directory') {
      await makeDir(path, header);
    } else if (header.type === 'file') {
      await writeFile(path, header, content);
    } else if (header.type === 'symlink') {
      links.push({ name: header.name, path, target: header.linkname });
    } else if (header.type === 'link') {
      await makeHardLink(root, path, header.linkname);
    } else {
      warn(`${header.name}: not a file, directory or link; skipped`);
    }
  };

  const makeSymlink = async (root: CopyRoot, pending: PendingSymlink): Promise<void> => {
    await checkParents(root.path, pending.path);

    const temp = buildTempPath(pending.path);

    await symlink(pending.target, temp);

    try {
      await rename(temp, pending.path);
    } catch (error) {
      await unlink(temp).catch(() => null);

      throw error;
    }
  };

  // deepest first, so a child's change does not move its parent's time
  const applyDirModes = async (): Promise<void> => {
    const sorted = dirs.toSorted((a, b) => b.path.split('/').length - a.path.split('/').length);

    for (const dir of sorted) {
      await chmod(dir.path, toSafeMode(dir.mode));
      await utimes(dir.path, dir.mtime, dir.mtime);
    }
  };

  const readEntries = async (): Promise<number> => {
    for await (const entry of extract) {
      const header = entry.header;

      if (state.first) {
        state.first = false;

        const total = TotalSchema.safeParse(header.pax);

        if (total.success) {
          progress.setTotal(total.data['IMP.total']);
        }
      }

      try {
        await writeEntry(header, entry);
      } catch (error) {
        // the copy's own root is the one failure that ends it
        if (state.root === null) {
          throw error;
        }

        state.refused += 1;

        warn(`${header.name}: ${readMessage(error)}`);
      }

      entry.resume();
    }

    const root = state.root;

    if (root === null) {
      throw new Error('the imp sent an empty archive');
    }

    for (const pending of links) {
      try {
        await makeSymlink(root, pending);
      } catch (error) {
        state.refused += 1;

        warn(`${pending.name}: ${readMessage(error)}`);
      }
    }

    await applyDirModes();

    return state.refused;
  };

  // never rejects, so an extract that fails before end() is no unhandled
  // rejection; end() throws its error instead
  const runExtract = async (): Promise<ExtractOutcome> => {
    try {
      const refused = await readEntries();

      return { refused };
    } catch (error) {
      state.stopped = true;

      wakeDrainWaiters();

      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  };

  const outcome = runExtract();

  return {
    write: async (chunk) => {
      if (state.stopped || extract.write(chunk)) {
        return;
      }

      await new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },
    end: async () => {
      extract.end(null);

      const done = await outcome;

      if ('error' in done) {
        throw done.error;
      }

      return done.refused;
    },
  };
}
