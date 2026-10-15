import type { ImpDatabase } from '../db/open-database';
import { listFileRemovals, listValueFiles, removeFileRemoval } from '../db/secrets';
import { readErrorMessage } from '../read-error-message';
import type { SecretFiles } from './secret-files';

// The broker's start over the value files (docs/guides/connectors.md#value-files):
// it removes each file a committed delete or replace displaced, and keeps
// aside each value no row and no record names.
export async function removeStaleSecretFiles(
  db: ImpDatabase,
  files: Pick<SecretFiles, 'remove' | 'keepOrphansExcept'>,
  at: Date,
  log: (message: string) => void,
): Promise<void> {
  const valueFiles = await listValueFiles(db);
  const pending = await removeRecordedFiles(db, files, valueFiles, log);

  // A value no row and no record names is kept aside, not deleted: it may be
  // a secret added after the database copy a restore put back, or a write
  // whose row never came. A record that failed again keeps its file here.
  const orphans = files.keepOrphansExcept(new Set([...valueFiles, ...pending]), at);

  for (const file of orphans.files) {
    log(
      `impd: broker: kept secret value file ${file}, which no database row names, in ${orphans.dir ?? ''}`,
    );
  }
}

// Removes each file a committed delete or replace displaced and impd stopped
// before removing, then its record; returns the files whose removal failed
// again, whose records stay for the next start. A file a row names stays.
async function removeRecordedFiles(
  db: ImpDatabase,
  files: Pick<SecretFiles, 'remove'>,
  valueFiles: ReadonlySet<string>,
  log: (message: string) => void,
): Promise<string[]> {
  const recorded = await listFileRemovals(db);

  const failed: string[] = [];

  for (const file of recorded) {
    try {
      if (!valueFiles.has(file)) {
        files.remove(file);
      }

      await removeFileRemoval(db, file);
    } catch (error) {
      failed.push(file);

      log(`impd: broker: could not remove an old secret value file: ${readErrorMessage(error)}`);
    }
  }

  return failed;
}
