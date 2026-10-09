import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildNotFoundError } from '../api-errors';
import { parseSnapshots } from '../backup/restic';
import type { Restic, ResticSnapshot } from '../backup/restic';

interface StubResticOptions {
  // each snapshot's tree, and the snapshot list every stub over this
  // directory shares, as hosts share a repository
  readonly repoDir: string;

  // the snapshot time a backup records
  readonly now: () => Date;
}

// Restic over a directory: a backup copies the tree to <repoDir>/<id> and
// lists it as `snapshots --json` would; a missing snapshot is NOT_FOUND.
// `calls`, `restores` and `state` record commands and hold a test's faults.
export function buildStubRestic(options: Readonly<StubResticOptions>) {
  const indexPath = join(options.repoDir, 'snapshots.json');
  const calls: string[] = [];
  const restores: string[] = [];

  const state = {
    failCheck: false,
    failBackup: false,

    // what the next prunes throw, one each
    pruneErrors: [] as Error[],

    // runs as each restore starts, with the dir it restores
    onRestore: null as ((dir: string) => Promise<void>) | null,
  };

  const readSnapshots = (): ResticSnapshot[] =>
    existsSync(indexPath) ? parseSnapshots(readFileSync(indexPath, 'utf8')) : [];

  const findSnapshot = (id: string): ResticSnapshot => {
    const found = readSnapshots().find((snapshot) => snapshot.id === id);

    if (found === undefined) {
      throw buildNotFoundError('backup', id);
    }

    return found;
  };

  const restic: Restic = {
    setupRepository: () => Promise.resolve(),
    backup: (dir, tags) => {
      if (state.failBackup) {
        return Promise.reject(new Error('Fatal: unable to save snapshot: bucket full'));
      }

      const snapshots = readSnapshots();
      const id = `snap${String(snapshots.length + 1)}`;

      cpSync(dir, join(options.repoDir, id), { recursive: true });

      const snapshot: ResticSnapshot = {
        id,
        time: options.now(),
        paths: [dir],
        tags: ['imp-backup', ...tags],
      };

      writeFileSync(indexPath, JSON.stringify([...snapshots, snapshot]));

      calls.push('backup');

      return Promise.resolve({
        snapshotId: id,
        filesNew: 0,
        filesChanged: 0,
        filesUnmodified: 0,
        dataAddedBytes: 10,
      });
    },
    forget: () => {
      calls.push('forget');

      return Promise.resolve();
    },
    prune: () => {
      calls.push('prune');

      const failure = state.pruneErrors.shift();

      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    check: () => {
      calls.push('check');

      return state.failCheck
        ? Promise.reject(new Error('Fatal: pack 9f2c: ciphertext verification failed'))
        : Promise.resolve();
    },
    unlock: () => {
      calls.push('unlock');

      return Promise.resolve();
    },
    listSnapshots: () => Promise.resolve(readSnapshots()),
    dump: (id, path) =>
      Promise.try(() => {
        const snapshot = findSnapshot(id);

        return readFileSync(join(options.repoDir, id, readInside(snapshot, path)), 'utf8');
      }),
    restore: async (id, dir, target, includes) => {
      if (includes.length > 0) {
        throw new Error('the stub restic restores whole dirs, without includes');
      }

      const snapshot = findSnapshot(id);
      const inside = readInside(snapshot, dir);

      restores.push(inside);

      await state.onRestore?.(inside);

      cpSync(join(options.repoDir, id, inside), target, { recursive: true });
    },
  };

  return { restic, calls, restores, state, readSnapshots };
}

// a path inside the snapshot, relative to the dir it backed up
function readInside(snapshot: Readonly<ResticSnapshot>, path: string): string {
  return relative(snapshot.paths[0] ?? '', path);
}
