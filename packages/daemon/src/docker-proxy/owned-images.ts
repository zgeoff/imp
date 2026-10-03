import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

// The engine images this proxy made: a pull of a reference the engine did
// not have, and a build's own tag. Only these may be removed, and impd's
// table never widens the set, so impd cannot claim the owner's images.
export interface OwnedImages {
  readonly has: (id: string) => boolean;
  readonly add: (id: string) => void;
  readonly remove: (id: string) => void;
}

const OwnedFileSchema = z.object({ ids: z.array(z.string()) });

// kept in `path`, written whole through a temp file so a crash leaves the
// old set or the new one
export function loadOwnedImages(path: string): OwnedImages {
  const saved = existsSync(path)
    ? OwnedFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).ids
    : [];

  const ids = new Set(saved);

  const writeIds = (): void => {
    const temp = `${path}.tmp`;

    writeFileSync(temp, JSON.stringify({ ids: [...ids].toSorted() }), { mode: 0o600 });
    renameSync(temp, path);
  };

  return {
    has: (id) => ids.has(id),
    add: (id) => {
      if (!ids.has(id)) {
        ids.add(id);

        writeIds();
      }
    },
    remove: (id) => {
      if (ids.delete(id)) {
        writeIds();
      }
    },
  };
}
