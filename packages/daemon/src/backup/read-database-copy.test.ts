import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { createCheckpoint } from '../db/checkpoints';
import { createImage } from '../db/images';
import { createImp } from '../db/imps';
import { writeMember, writeNetwork } from '../db/networks';
import { createCheckedGrant, createSecret } from '../db/secrets';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createTestDatabase } from '../test-utils/create-test-database';
import { readDatabaseCopy } from './read-database-copy';

async function setupTest() {
  const database = await createTestDatabase();
  const dir = await mkdtemp(join(tmpdir(), 'imp-db-copy-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { db: database.db, dir };
}

test('it copies the user imps and leaves out image builders', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());

  const newDev = buildMockNewImp({
    imageId: image.id,
    vcpus: 2,
    memoryMib: 1024,
    maxMemoryMib: 2048,
    slot: 1,
    ip: '10.66.0.3',
    httpPort: 8080,
    diskBytes: 4096,
    egress: { mode: 'box', allow: ['github.com'] },
    isIdentityResetPending: true,
  });

  const dev = await createImp(ctx.db, newDev);

  await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, slot: 2, ip: '10.66.0.4', kind: 'builder' }),
  );

  const copy = await readDatabaseCopy(ctx.db, join(ctx.dir, 'copy.sqlite'));

  expect(copy.imps).toStrictEqual([
    {
      id: dev.id,
      name: newDev.name,
      imageId: image.id,
      state: 'creating',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 2048,
      httpPort: 8080,
      egressPolicy: 'box',
      diskBytes: 4096,
      egressAllow: '["github.com"]',
      identityResetPending: 1,
    },
  ]);
});

test('it copies the checkpoints oldest first', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await createCheckpoint(ctx.db, {
    id: 'cp-newer',
    impId: imp.id,
    label: null,
    sizeBytes: 10,
    diskBytes: 8192,
    createdAt: new Date('2026-10-02T00:00:00Z'),
  });

  await createCheckpoint(ctx.db, {
    id: 'cp-older',
    impId: imp.id,
    label: 'clean',
    sizeBytes: 10,
    diskBytes: 4096,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });

  const copy = await readDatabaseCopy(ctx.db, join(ctx.dir, 'copy.sqlite'));

  expect(copy.checkpoints).toStrictEqual([
    {
      id: 'cp-older',
      impId: imp.id,
      label: 'clean',
      createdAt: Date.parse('2026-10-01T00:00:00Z'),
      diskBytes: 4096,
    },
    {
      id: 'cp-newer',
      impId: imp.id,
      label: null,
      createdAt: Date.parse('2026-10-02T00:00:00Z'),
      diskBytes: 8192,
    },
  ]);
});

test('it copies the images by name', async () => {
  const ctx = await setupTest();

  const newUbuntu = buildMockNewImage({ name: 'ubuntu' });
  const newSaved = buildMockNewImage({ name: 'saved', source: 'imp', sourceImp: 'dev' });

  const ubuntu = await createImage(ctx.db, newUbuntu);
  const saved = await createImage(ctx.db, newSaved);
  const copy = await readDatabaseCopy(ctx.db, join(ctx.dir, 'copy.sqlite'));

  expect(copy.images).toStrictEqual([
    {
      id: saved.id,
      name: 'saved',
      ref: newSaved.ref,
      digest: newSaved.digest,
      source: 'imp',
      sourceImp: 'dev',
      sizeBytes: newSaved.sizeBytes,
    },
    {
      id: ubuntu.id,
      name: 'ubuntu',
      ref: newUbuntu.ref,
      digest: newUbuntu.digest,
      source: 'oci',
      sourceImp: null,
      sizeBytes: newUbuntu.sizeBytes,
    },
  ]);
});

test('it copies the grants by secret name', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await createSecret(ctx.db, { name: 'npm', kind: 'github', rules: [], valueFile: 'npm' });
  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });
  await createCheckedGrant(ctx.db, imp.id, 'npm', null);
  await createCheckedGrant(ctx.db, imp.id, 'gh', null);

  const copy = await readDatabaseCopy(ctx.db, join(ctx.dir, 'copy.sqlite'));

  expect(copy.grants).toStrictEqual([
    { impId: imp.id, secretName: 'gh' },
    { impId: imp.id, secretName: 'npm' },
  ]);
});

test('it copies the network members by network name', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const web = await writeNetwork(ctx.db, 'web');
  const db = await writeNetwork(ctx.db, 'db');

  invariant(web);
  invariant(db);

  await writeMember(ctx.db, web.id, imp.id);
  await writeMember(ctx.db, db.id, imp.id);

  const copy = await readDatabaseCopy(ctx.db, join(ctx.dir, 'copy.sqlite'));

  expect(copy.members).toStrictEqual([
    { impId: imp.id, network: 'db' },
    { impId: imp.id, network: 'web' },
  ]);
});
