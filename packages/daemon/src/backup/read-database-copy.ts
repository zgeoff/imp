import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { sql } from 'kysely';
import * as z from 'zod';
import type { ImpDatabase } from '../db/open-database';

const CopyImpSchema = z.object({
  id: z.string(),
  name: z.string(),
  imageId: z.string(),
  state: z.string(),
  vcpus: z.int(),
  memoryMib: z.int(),
  httpPort: z.int(),
});

const CopyCheckpointSchema = z.object({
  id: z.string(),
  impId: z.string(),
  label: z.string().nullable(),
  createdAt: z.int(),
});

const CopyImageSchema = z.object({
  id: z.string(),
  name: z.string(),
  ref: z.string(),
  digest: z.string(),
  sizeBytes: z.int(),
});

type CopyImp = z.infer<typeof CopyImpSchema>;

type CopyCheckpoint = z.infer<typeof CopyCheckpointSchema>;

type CopyImage = z.infer<typeof CopyImageSchema>;

export interface DatabaseCopy {
  readonly imps: readonly CopyImp[];

  // oldest first
  readonly checkpoints: readonly CopyCheckpoint[];
  readonly images: readonly CopyImage[];
}

// One consistent view of the database for a backup run: `VACUUM INTO` copies
// it in a single read transaction, and the run backs up only what it names.
export async function readDatabaseCopy(db: ImpDatabase, path: string): Promise<DatabaseCopy> {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });

  await sql`VACUUM INTO ${path}`.execute(db);

  const copy = new Database(path, { readonly: true });

  try {
    const imps = copy
      .query(
        `SELECT id, name, image_id AS imageId, state, vcpus, memory_mib AS memoryMib,
           http_port AS httpPort FROM imps ORDER BY name`,
      )
      .all();

    const checkpoints = copy
      .query(
        `SELECT id, imp_id AS impId, label, created_at AS createdAt FROM checkpoints
           ORDER BY created_at, id`,
      )
      .all();

    const images = copy
      .query('SELECT id, name, ref, digest, size_bytes AS sizeBytes FROM images ORDER BY name')
      .all();

    return {
      imps: z.array(CopyImpSchema).parse(imps),
      checkpoints: z.array(CopyCheckpointSchema).parse(checkpoints),
      images: z.array(CopyImageSchema).parse(images),
    };
  } finally {
    copy.close();
  }
}
