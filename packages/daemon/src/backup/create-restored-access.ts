import type { BackupRestore } from '@imp/api';
import type { TokenStore } from '../auth/token-store';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';
import { createRestoredSecrets, listSecretRows } from '../db/secrets';
import { listTokenRecords, listTokenSshKeyRecords } from '../db/tokens';

type RestoredAccess = NonNullable<BackupRestore['database']>;

// Tokens, their keys and secret rows from a backup's database copy, migrated
// forward first; a newer impd's copy is refused. Secrets go first, so the
// restore's grants find them (docs/architecture/storage/backups.md).
export async function createRestoredAccess(
  db: ImpDatabase,
  tokens: Pick<TokenStore, 'createRestored'>,
  copyPath: string,
): Promise<RestoredAccess> {
  const copied = await readCopiedAccess(copyPath);
  const secrets = await createRestoredSecrets(db, copied.secrets);
  const made = await tokens.createRestored(copied.tokens, copied.keys);

  return { tokens: made.restored, secrets, skipped: made.skipped };
}

async function readCopiedAccess(copyPath: string) {
  const copy = await openDatabase(copyPath);

  try {
    return {
      secrets: await listSecretRows(copy),
      tokens: await listTokenRecords(copy),
      keys: await listTokenSshKeyRecords(copy),
    };
  } finally {
    await copy.destroy();
  }
}
