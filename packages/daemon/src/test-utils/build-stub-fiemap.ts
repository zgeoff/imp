import { existsSync } from 'node:fs';
import type { Extent, readExtents } from '../storage/fiemap';

// readExtents over real files: the extents a test sets (none by default), a
// cut or failed read, and the real open's rejection of a missing file. It
// records each path it reads, in order.
export function buildStubFiemap() {
  const extents = new Map<string, readonly Extent[]>();
  const cuts = new Set<string>();
  const failures = new Map<string, Error>();

  const reads: string[] = [];

  const readFileExtents: typeof readExtents = (path) => {
    reads.push(path);

    const failure = failures.get(path);

    if (failure !== undefined) {
      return Promise.reject(failure);
    }

    if (!existsSync(path)) {
      return Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
    }

    return Promise.resolve({
      extents: [...(extents.get(path) ?? [])],
      isComplete: !cuts.has(path),
    });
  };

  return {
    readFileExtents,
    reads,
    setExtents: (path: string, list: readonly Extent[]) => {
      extents.set(path, list);
    },

    // the read of `path` stops at its deadline; `isCut` false lets it finish again
    setCut: (path: string, isCut: boolean) => {
      if (isCut) {
        cuts.add(path);
      } else {
        cuts.delete(path);
      }
    },
    failAt: (path: string, error: Error) => {
      failures.set(path, error);
    },
  };
}
