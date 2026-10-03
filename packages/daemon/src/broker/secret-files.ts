import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Secret values, one file each in <dataDir>/secrets: the directory 0700, each
// file 0600, unencrypted, as the key would live on the same disk. A file is
// named by buildValueFile, or by the bare secret name from an older impd.
export interface SecretFiles {
  readonly write: (file: string, value: string) => void;

  // null when the file is gone
  readonly read: (file: string) => string | null;
  readonly remove: (file: string) => void;

  // every file not in `keep`, and every temp file a crash left
  readonly removeExcept: (keep: ReadonlySet<string>) => void;
}

// A new file for each value: a replace writes the new value beside the old,
// and the secret's row switches from one to the other.
export function buildValueFile(name: string): string {
  return `${name}.${randomBytes(8).toString('hex')}`;
}

export function createSecretFiles(dataDir: string): SecretFiles {
  const dir = join(dataDir, 'secrets');

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // a directory made by an older impd or by hand keeps its mode otherwise
  chmodSync(dir, 0o700);

  return {
    // a temp file then a rename, so a reader never sees half a value
    write: (file, value) => {
      const temp = join(dir, `.${file}.${randomBytes(6).toString('hex')}`);

      try {
        writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
        renameSync(temp, join(dir, file));
      } finally {
        rmSync(temp, { force: true });
      }
    },
    read: (file) => {
      try {
        return readFileSync(join(dir, file), 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }

        throw error;
      }
    },
    remove: (file) => {
      rmSync(join(dir, file), { force: true });
    },
    removeExcept: (keep) => {
      for (const file of readdirSync(dir)) {
        if (!keep.has(file)) {
          rmSync(join(dir, file), { force: true });
        }
      }
    },
  };
}
