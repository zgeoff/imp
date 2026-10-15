import { SecretNameSchema } from '@impz/api';
import type { BackupRestore } from '@impz/api';
import type { TokenStore } from '../auth/token-store';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';
import { createRestoredSecrets, listSecretRows } from '../db/secrets';
import type { SecretRow } from '../db/secrets';
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

  const kept = copied.secrets.filter((row) => isOwnValueFile(row));

  const refused = copied.secrets
    .filter((row) => !isOwnValueFile(row))
    .map((row) => ({
      name: row.name,
      reason: `secret ${row.name}: its value file is not a name impd gives`,
    }));

  const secrets = await createRestoredSecrets(db, kept);
  const made = await tokens.createRestored(copied.tokens, copied.keys);

  return { tokens: made.restored, secrets, skipped: [...refused, ...made.skipped] };
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

// The broker reads and removes a value file by name in the secrets directory,
// so an altered copy must name none outside it: only `<name>`, from an older
// impd, or `<name>.<16 hex>`.
function isOwnValueFile(row: Readonly<SecretRow>): boolean {
  if (!SecretNameSchema.safeParse(row.name).success) {
    return false;
  }

  const suffix = row.value_file.slice(row.name.length);

  return row.value_file.startsWith(row.name) && (suffix === '' || /^\.[0-9a-f]{16}$/v.test(suffix));
}
