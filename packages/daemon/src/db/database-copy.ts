import { Database } from 'bun:sqlite';
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import * as z from 'zod';
import { buildConflictError } from '../api-errors';
import type { ImpDatabase } from './open-database';

// A consistent copy of impd's database, safe while impd runs
// (docs/guides/operations.md#database-copy-and-restore).

export interface DatabaseCopyFile {
  readonly path: string;
  readonly sizeBytes: number;

  // the copy's schema version: the last migration it holds
  readonly lastMigration: string;
  readonly createdAt: Date;

  // PRAGMA integrity_check on the copy: 'ok', or its first problem
  readonly integrity: string;
}

const MigrationRowSchema = z.object({ name: z.string() });
const IntegrityRowSchema = z.object({ integrity_check: z.string() });

// `VACUUM INTO` copies the database in one read transaction, so the copy is
// whole whatever writes run meanwhile; the target must be absent or empty
export async function writeConsistentCopy(db: ImpDatabase, path: string): Promise<void> {
  await sql`VACUUM INTO ${path}`.execute(db);
}

function buildDatabaseCopyPath(dataDir: string, name: string): string {
  return join(dataDir, 'db-copies', `${name}.sqlite`);
}

// Into <dataDir>/db-copies/<name>.sqlite, never another path: the file is
// made empty and 0600 first, so the copy is never readable by others.
// CONFLICT when a copy by the name exists.
export async function writeDatabaseCopy(
  db: ImpDatabase,
  dataDir: string,
  name: string,
  now: () => number,
): Promise<DatabaseCopyFile> {
  const path = buildDatabaseCopyPath(dataDir, name);

  mkdirSync(join(dataDir, 'db-copies'), { recursive: true, mode: 0o700 });

  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw buildConflictError('database-copy', name);
    }

    throw error;
  }

  try {
    await writeConsistentCopy(db, path);

    return {
      path,
      sizeBytes: statSync(path).size,
      ...readCopyFacts(path),
      createdAt: new Date(now()),
    };
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

// read from the copy itself, so they describe the file a restore puts back
function readCopyFacts(path: string): Pick<DatabaseCopyFile, 'lastMigration' | 'integrity'> {
  const copy = new Database(path, { readonly: true });

  try {
    const row = copy.query('SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1').get();
    const check = copy.query('PRAGMA integrity_check').get();

    return {
      lastMigration: MigrationRowSchema.parse(row).name,
      integrity: IntegrityRowSchema.parse(check).integrity_check,
    };
  } finally {
    copy.close();
  }
}
