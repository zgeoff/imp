import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { z } from 'zod';

// One reference this proxy made, as the engine showed it right after: the
// image it named, and the image's last tag time. The engine moves that time
// when any name is set on the image, so a tag by the host owner shows.
const OwnedReferenceSchema = z.object({ id: z.string(), taggedAt: z.string() });

type OwnedReference = z.infer<typeof OwnedReferenceSchema>;

// The references this proxy made: a pull of one the engine did not have, and
// a build's tag. Only these may be removed, and impd's table never adds to
// them, so impd cannot claim a name or an image of the owner's.
export interface OwnedReferences {
  readonly read: (reference: string) => OwnedReference | undefined;

  // records `reference`, and moves every other one on the same image to
  // its new tag time, since the proxy's own tag moved it
  readonly write: (reference: string, owned: Readonly<OwnedReference>) => void;
  readonly remove: (reference: string) => void;
}

const OwnedFileSchema = z.object({ references: z.record(z.string(), OwnedReferenceSchema) });

function readSaved(path: string, log: (message: string) => void): Map<string, OwnedReference> {
  if (!existsSync(path)) {
    return new Map();
  }

  try {
    const saved = OwnedFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

    return new Map(Object.entries(saved.references));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // the proxy still runs; it removes nothing until it makes a reference again
    log(`${path} is unreadable, so no image counts as the proxy's: ${message}`);

    return new Map();
  }
}

// Kept in `path`, keyed by the reference in one spelling
// (normalizeReference). Each change goes to disk, synced, before memory, so
// a failed write changes nothing and a crash leaves the old file or the new.
export function loadOwnedReferences(path: string, log: (message: string) => void): OwnedReferences {
  const references = readSaved(path, log);

  const writeAll = (next: ReadonlyMap<string, OwnedReference>): void => {
    const temp = `${path}.tmp`;
    const sorted = [...next].toSorted(([a], [b]) => a.localeCompare(b));
    const fd = openSync(temp, 'w', 0o600);

    try {
      writeSync(fd, JSON.stringify({ references: Object.fromEntries(sorted) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(temp, path);
  };

  const setReferences = (next: ReadonlyMap<string, OwnedReference>): void => {
    writeAll(next);

    references.clear();

    for (const [key, value] of next) {
      references.set(key, value);
    }
  };

  return {
    read: (reference) => references.get(reference),
    write: (reference, owned) => {
      const moved = [...references].map(([key, value]): [string, OwnedReference] => [
        key,
        value.id === owned.id ? { id: value.id, taggedAt: owned.taggedAt } : value,
      ]);

      setReferences(new Map([...moved, [reference, { id: owned.id, taggedAt: owned.taggedAt }]]));
    },
    remove: (reference) => {
      if (references.has(reference)) {
        setReferences(new Map([...references].filter(([key]) => key !== reference)));
      }
    },
  };
}
