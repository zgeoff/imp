import type { ImageSource } from '@imp/api';
import type { Selectable } from 'kysely';
import type { ImpDatabase } from './open-database';
import type { DatabaseSchema } from './schema';

export interface ImageRecord {
  readonly id: string;
  readonly name: string;
  readonly ref: string;
  readonly digest: string;
  readonly source: ImageSource;

  // a template's source imp, by name; null for a docker image
  readonly sourceImp: string | null;
  readonly sizeBytes: number;
  readonly createdAt: Date;
}

export interface NewImage {
  readonly name: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;

  // oci and null when left out
  readonly source?: ImageSource;
  readonly sourceImp?: string | null;
}

export async function createImage(db: ImpDatabase, image: NewImage): Promise<ImageRecord> {
  const row = await db
    .insertInto('images')
    .values({
      id: Bun.randomUUIDv7(),
      name: image.name,
      ref: image.ref,
      digest: image.digest,
      size_bytes: image.sizeBytes,
      source: image.source ?? 'oci',
      source_imp: image.sourceImp ?? null,
      created_at: Date.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImageRecord(row);
}

export async function findImageByName(
  db: ImpDatabase,
  name: string,
): Promise<ImageRecord | undefined> {
  const row = await db.selectFrom('images').selectAll().where('name', '=', name).executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}

export async function findImageByDigest(
  db: ImpDatabase,
  digest: string,
): Promise<ImageRecord | undefined> {
  const row = await db
    .selectFrom('images')
    .selectAll()
    .where('digest', '=', digest)
    .orderBy('created_at')
    .executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}

export async function findImageById(db: ImpDatabase, id: string): Promise<ImageRecord | undefined> {
  const row = await db.selectFrom('images').selectAll().where('id', '=', id).executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}

export async function listImages(db: ImpDatabase): Promise<ImageRecord[]> {
  const rows = await db.selectFrom('images').selectAll().orderBy('name').execute();

  return rows.map((row) => toImageRecord(row));
}

// fails on a foreign key while any imp still uses the image
export async function removeImage(db: ImpDatabase, id: string): Promise<boolean> {
  const result = await db.deleteFrom('images').where('id', '=', id).executeTakeFirst();

  return result.numDeletedRows > 0n;
}

function toImageRecord(row: Readonly<Selectable<DatabaseSchema['images']>>): ImageRecord {
  return {
    id: row.id,
    name: row.name,
    ref: row.ref,
    digest: row.digest,
    source: row.source,
    sourceImp: row.source_imp,
    sizeBytes: row.size_bytes,
    createdAt: new Date(row.created_at),
  };
}

// points an image name at a new build; imps keep their own disks, so the
// old rootfs is no longer needed by them
export async function updateImage(
  db: ImpDatabase,
  id: string,
  image: Readonly<Omit<NewImage, 'name' | 'source'>>,
): Promise<ImageRecord> {
  const row = await db
    .updateTable('images')
    .set({
      ref: image.ref,
      digest: image.digest,
      size_bytes: image.sizeBytes,
      source_imp: image.sourceImp ?? null,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImageRecord(row);
}

export async function countImageRefUses(db: ImpDatabase, ref: string): Promise<number> {
  const row = await db
    .selectFrom('images')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('ref', '=', ref)
    .executeTakeFirstOrThrow();

  return row.count;
}

export async function countImageDigestUses(db: ImpDatabase, digest: string): Promise<number> {
  const row = await db
    .selectFrom('images')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('digest', '=', digest)
    .executeTakeFirstOrThrow();

  return row.count;
}
