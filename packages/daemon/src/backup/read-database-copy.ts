import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { ImageSourceSchema } from '@imp/api';
import * as z from 'zod';
import { writeConsistentCopy } from '../db/database-copy';
import type { ImpDatabase } from '../db/open-database';

const CopyImpSchema = z.object({
  id: z.string(),
  name: z.string(),
  imageId: z.string(),
  state: z.string(),
  vcpus: z.int(),
  memoryMib: z.int(),
  maxMemoryMib: z.int().nullable(),
  httpPort: z.int(),
  egressPolicy: z.string(),
  diskBytes: z.int(),
  egressAllow: z.string(),
  identityResetPending: z.int(),
});

const CopyGrantSchema = z.object({ impId: z.string(), secretName: z.string() });
const CopyMemberSchema = z.object({ impId: z.string(), network: z.string() });

const CopyCheckpointSchema = z.object({
  id: z.string(),
  impId: z.string(),
  label: z.string().nullable(),
  createdAt: z.int(),
  diskBytes: z.int(),
});

const CopyImageSchema = z.object({
  id: z.string(),
  name: z.string(),
  ref: z.string(),
  digest: z.string(),
  source: ImageSourceSchema,
  sourceImp: z.string().nullable(),
  sizeBytes: z.int(),
});

type CopyImp = z.infer<typeof CopyImpSchema>;

type CopyCheckpoint = z.infer<typeof CopyCheckpointSchema>;

type CopyImage = z.infer<typeof CopyImageSchema>;

type CopyGrant = z.infer<typeof CopyGrantSchema>;

type CopyMember = z.infer<typeof CopyMemberSchema>;

export interface DatabaseCopy {
  readonly imps: readonly CopyImp[];

  // oldest first
  readonly checkpoints: readonly CopyCheckpoint[];
  readonly images: readonly CopyImage[];

  // secret names only: values live in <data>/secrets, which no backup reads
  readonly grants: readonly CopyGrant[];

  // network names: a restore makes any that are missing
  readonly members: readonly CopyMember[];
}

// One consistent view of the database for a backup run: `VACUUM INTO` copies
// it in a single read transaction, and the run backs up only what it names,
// which leaves out image builders.
export async function readDatabaseCopy(db: ImpDatabase, path: string): Promise<DatabaseCopy> {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });

  await writeConsistentCopy(db, path);

  const copy = new Database(path, { readonly: true });

  try {
    const imps = copy
      .query(
        `SELECT id, name, image_id AS imageId, state, vcpus, memory_mib AS memoryMib,
           max_memory_mib AS maxMemoryMib, http_port AS httpPort, egress_policy AS egressPolicy,
           egress_allow AS egressAllow, disk_bytes AS diskBytes,
           identity_reset_pending AS identityResetPending
           FROM imps WHERE kind = 'user' ORDER BY name`,
      )
      .all();

    const checkpoints = copy
      .query(
        `SELECT id, imp_id AS impId, label, created_at AS createdAt, disk_bytes AS diskBytes
           FROM checkpoints ORDER BY created_at, id`,
      )
      .all();

    const images = copy
      .query(
        `SELECT id, name, ref, digest, source, source_imp AS sourceImp, size_bytes AS sizeBytes
           FROM images ORDER BY name`,
      )
      .all();

    const grants = copy
      .query('SELECT imp_id AS impId, secret_name AS secretName FROM grants ORDER BY secret_name')
      .all();

    const members = copy
      .query(
        `SELECT network_members.imp_id AS impId, networks.name AS network FROM network_members
           JOIN networks ON networks.id = network_members.network_id ORDER BY networks.name`,
      )
      .all();

    return {
      imps: z.array(CopyImpSchema).parse(imps),
      grants: z.array(CopyGrantSchema).parse(grants),
      members: z.array(CopyMemberSchema).parse(members),
      checkpoints: z.array(CopyCheckpointSchema).parse(checkpoints),
      images: z.array(CopyImageSchema).parse(images),
    };
  } finally {
    copy.close();
  }
}
