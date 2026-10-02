import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Secret values, one file each in <dataDir>/secrets: the directory 0700, each
// file 0600. They are not encrypted: the key would live on the same disk.
// Names come from SecretNameSchema, so a name is never a path.
export interface SecretFiles {
  readonly write: (name: string, value: string) => void;

  // null when the file is gone
  readonly read: (name: string) => string | null;
  readonly remove: (name: string) => void;
}

export function createSecretFiles(dataDir: string): SecretFiles {
  const dir = join(dataDir, 'secrets');

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // a directory made by an older impd or by hand keeps its mode otherwise
  chmodSync(dir, 0o700);

  return {
    // a temp file then a rename, so a reader never sees half a value
    write: (name, value) => {
      const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}`);

      try {
        writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
        renameSync(temp, join(dir, name));
      } finally {
        rmSync(temp, { force: true });
      }
    },
    read: (name) => {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }

        throw error;
      }
    },
    remove: (name) => {
      rmSync(join(dir, name), { force: true });
    },
  };
}
