import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { createCheckpoint, listCheckpoints } from '../db/checkpoints';
import { findImageByName } from '../db/images';
import { findImpByName, updateImpState } from '../db/imps';
import { findSecret } from '../db/secrets';
import { createTemplateService } from '../images/template-service';
import { createImpTest } from '../imps/test-imps';
import { createNetworkService } from '../networks/network-service';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockBackupConfig } from '../test-utils/build-mock-backup-config';
import { buildStubRestic } from '../test-utils/build-stub-restic';
import { BackupManifestSchema } from './backup-manifest';
import { buildBackupsOffError, buildDigestTag, createBackupService } from './backup-service';
import type { BackupServiceDeps } from './backup-service';
import { ResticError } from './restic';

// One host's imps and the backup service's deps over a stub restic in a temp
// repository; each test picks its backup settings. `stack` and `repoDir` let
// a test add a second host on that repository, released before it.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const repoDir = mkdtempSync(join(tmpdir(), 'impd-restic-test-'));

  stack.defer(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  // a frozen clock, so a scheduled run is due only once the test advances it
  const host = await createImpTest(stack, { frozenClockMs: Date.UTC(2026, 9, 2) });

  const restic = buildStubRestic({ repoDir, now: () => new Date(host.now()) });

  // the freezer's calls, and the service's log lines
  const freezes: string[] = [];
  const backupLogs: string[] = [];

  const deps: Omit<BackupServiceDeps, 'backup'> = {
    dataDir: host.dataDir,
    db: host.db,
    imps: host.imps,
    grants: host.broker,
    networks: createNetworkService({ db: host.db, egress: host.egress, imps: host.imps }),
    storage: host.storage,
    storageGate: host.storageGate,
    diskBudget: host.diskBudget,
    restic: restic.restic,
    log: (message) => {
      backupLogs.push(message);
    },
    now: () => new Date(host.now()),
    freezer: {
      freeze: () => {
        freezes.push('freeze');

        return Promise.resolve();
      },
      thaw: () => {
        freezes.push('thaw');

        return Promise.resolve();
      },
    },
  };

  return { ...host, stack, repoDir, restic, freezes, backupLogs, deps };
}

test('it freezes a running imp and copies stopped and sleeping imps as they are', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.createImp({ name: 'idle' });
  await ctx.imps.stopImp('idle');
  await ctx.imps.createImp({ name: 'napping' });
  await ctx.imps.sleepImp('napping');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(ctx.freezes).toStrictEqual(['freeze', 'thaw']);
  expect(run.imps).toStrictEqual(['dev', 'idle', 'napping']);
  expect(run.skipped).toStrictEqual([]);

  expect(manifest.imps.map((imp) => [imp.name, imp.state, imp.synced])).toStrictEqual([
    ['dev', 'running', true],
    ['idle', 'stopped', true],
    ['napping', 'sleeping', false],
  ]);
});

test('it tags the snapshot with the run and each imp, then forgets', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.createImp({ name: 'idle' });
  await backups.runBackup();

  const [snapshot] = ctx.restic.readSnapshots();

  expect(snapshot?.tags).toStrictEqual([
    'imp-backup',
    expect.stringMatching(/^run=/v),
    'imp=dev',
    'imp=idle',
  ]);

  expect(ctx.restic.calls).toStrictEqual(['unlock', 'backup', 'forget']);
});

test('it records each imp’s settings, checkpoints and image in the manifest', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev', httpPort: 3000, memoryMib: 256 });
  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(ctx.db, {
    id: 'cp-one',
    impId: dev.id,
    label: 'one',
    sizeBytes: oneBytes,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    diskBytes: 1003,
  });

  const twoBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-two');

  await createCheckpoint(ctx.db, {
    id: 'cp-two',
    impId: dev.id,
    label: 'two',
    sizeBytes: twoBytes,
    createdAt: new Date('2026-09-02T00:00:00Z'),
    diskBytes: 1003,
  });

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));
  const [recorded] = manifest.imps;

  expect(recorded).toMatchObject({
    name: 'dev',
    httpPort: 3000,
    memoryMib: 256,
    imageDigest: 'sha256:base',
  });

  expect(recorded?.checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['one', 'two']);
  expect(manifest.images.map((image) => image.digest)).toStrictEqual(['sha256:base']);
});

test('it keeps the database copy and the token out of the snapshot', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  const snapshotDir = join(ctx.repoDir, run.snapshotId);

  expect(readdirSync(snapshotDir)).toIncludeSameMembers(['images', 'imps', 'manifest.json']);
  expect(readFileSync(join(snapshotDir, 'manifest.json'), 'utf8')).not.toContain('token');
});

test('it restores an imp stopped, with its disk and its checkpoints newest first', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev', httpPort: 3000, memoryMib: 256 });

  const devDisk = buildImpPaths(ctx.dataDir, dev.id).disk;

  writeFileSync(devDisk, 'one');

  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(ctx.db, {
    id: 'cp-one',
    impId: dev.id,
    label: 'one',
    sizeBytes: oneBytes,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    diskBytes: 1003,
  });

  writeFileSync(devDisk, 'two');

  const twoBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-two');

  await createCheckpoint(ctx.db, {
    id: 'cp-two',
    impId: dev.id,
    label: 'two',
    sizeBytes: twoBytes,
    createdAt: new Date('2026-09-02T00:00:00Z'),
    diskBytes: 1003,
  });

  writeFileSync(devDisk, 'now');

  await backups.runBackup();
  await ctx.imps.destroyImp('dev');

  const result = await backups.restoreBackup({ name: 'dev' });
  const restored = await findImpByName(ctx.db, 'dev');

  invariant(restored);

  const checkpoints = await listCheckpoints(ctx.db, restored.id);

  const checkpointsDir = buildImpPaths(ctx.dataDir, restored.id).checkpointsDir;

  expect(result.imps).toStrictEqual([
    expect.objectContaining({ name: 'dev', state: 'stopped', httpPort: 3000, memoryMib: 256 }),
  ]);

  expect(readFileSync(buildImpPaths(ctx.dataDir, restored.id).disk, 'utf8')).toBe('now');

  // new ids, with the original times and disk sizes
  expect(checkpoints).toStrictEqual([
    {
      id: expect.not.toBeOneOf(['cp-one', 'cp-two']),
      impId: restored.id,
      label: 'two',
      sizeBytes: expect.toBeNumber(),
      createdAt: new Date('2026-09-02T00:00:00Z'),
      diskBytes: 1003,
    },
    {
      id: expect.not.toBeOneOf(['cp-one', 'cp-two']),
      impId: restored.id,
      label: 'one',
      sizeBytes: expect.toBeNumber(),
      createdAt: new Date('2026-09-01T00:00:00Z'),
      diskBytes: 1003,
    },
  ]);

  expect(readFileSync(join(checkpointsDir, checkpoints[0]?.id ?? '', 'disk.ext4'), 'utf8')).toBe(
    'two',
  );

  expect(readFileSync(join(checkpointsDir, checkpoints[1]?.id ?? '', 'disk.ext4'), 'utf8')).toBe(
    'one',
  );

  expect(readdirSync(join(ctx.dataDir, 'backup', 'restore'))).toStrictEqual([]);
});

test('it restores the newest backup at or before --at that holds the imp', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'early');

  await backups.runBackup();

  const halfway = ctx.now() + 30 * 60 * 1000;

  ctx.advance(60 * 60 * 1000);

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'later');

  await backups.runBackup();

  ctx.advance(60 * 60 * 1000);

  await backups.restoreBackup({ name: 'dev', as: 'back', at: new Date(halfway) });

  const back = await findImpByName(ctx.db, 'back');

  invariant(back);

  expect(readFileSync(buildImpPaths(ctx.dataDir, back.id).disk, 'utf8')).toBe('early');
});

test('it restores the newest backup without --at', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'early');

  await backups.runBackup();

  ctx.advance(60 * 60 * 1000);

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'later');

  await backups.runBackup();
  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const back = await findImpByName(ctx.db, 'back');

  invariant(back);

  expect(readFileSync(buildImpPaths(ctx.dataDir, back.id).disk, 'utf8')).toBe('later');
});

test('it rejects a restore --at before every backup as NOT_FOUND', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  expect(
    backups.restoreBackup({ name: 'dev', as: 'back', at: new Date('2026-10-01T00:00:00Z') }),
  ).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'backup dev at 2026-10-01T00:00:00.000Z not found',
  });
});

test('it rejects a restore over an imp of the same name as CONFLICT', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  expect(backups.restoreBackup({ name: 'dev' })).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'imp', name: 'dev' },
  });
});

test('it rejects a restore of all imps on a host with imps as PRECONDITION_FAILED', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  expect(backups.restoreBackup({ all: true })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: "impd has 1 imps already; restore --all --merge adds the backup's imps to them",
  });
});

test('it rejects a merged restore of all imps over a name in use as CONFLICT', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  expect(backups.restoreBackup({ all: true, merge: true })).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'imp', name: 'dev' },
  });
});

test('it rejects a restore that names neither an imp nor all of them as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  expect(backups.restoreBackup({})).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'restore one imp by name, or all of them',
  });
});

test('it rejects a restore that names an imp and all of them as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  expect(backups.restoreBackup({ name: 'dev', all: true })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'restore one imp by name, or all of them',
  });
});

test('it rejects a restore of all imps under another name as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  expect(backups.restoreBackup({ all: true, as: 'back' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: '`as` renames one imp, not all of them',
  });
});

test('it restores every imp and its image on a fresh host, renaming an image whose name is taken', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'now');

  await ctx.imps.createImp({ name: 'web' });
  await backups.runBackup();

  const fresh = await createImpTest(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() }).restic,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  // a different image under the same name
  await fresh.createTestImage('other');
  await fresh.db.updateTable('images').set({ name: 'base' }).execute();

  const restored = await freshBackups.restoreBackup({ all: true });
  const freshDev = await findImpByName(fresh.db, 'dev');

  invariant(freshDev);

  expect(restored.imps.map((imp) => [imp.name, imp.state, imp.image])).toStrictEqual([
    ['dev', 'stopped', 'base-base'],
    ['web', 'stopped', 'base-base'],
  ]);

  expect(readFileSync(buildImpPaths(fresh.dataDir, freshDev.id).disk, 'utf8')).toBe('now');
});

test('it rejects a restored image as CONFLICT when its name and its tagged name are both taken', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runBackup();

  const fresh = await createImpTest(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() }).restic,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  // other images hold the backup's image name, base, and its tagged one
  await fresh.createTestImage('other');
  await fresh.db.updateTable('images').set({ name: 'base' }).where('name', '=', 'other').execute();
  await fresh.createTestImage('third');

  await fresh.db
    .updateTable('images')
    .set({ name: 'base-base' })
    .where('name', '=', 'third')
    .execute();

  expect(freshBackups.restoreBackup({ name: 'dev' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'images base and base-base both exist; remove one to restore this image',
    data: { kind: 'image', name: 'base-base' },
  });
});

test('it records templates with their source imp and an identity reset still owed', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  const templates = createTemplateService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    storage: ctx.storage,
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.stopImp('dev');
  await templates.createTemplate('dev', 'tools');
  await templates.createTemplate('dev', 'spare');

  // made stopped, so its identity reset is still owed
  await ctx.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.images.map((image) => [image.name, image.source, image.sourceImp])).toStrictEqual(
    [
      ['base', 'oci', null],
      ['spare', 'imp', 'dev'],
      ['tools', 'imp', 'dev'],
    ],
  );

  expect(manifest.imps.map((imp) => [imp.name, imp.identityResetPending])).toStrictEqual([
    ['copy', true],
    ['dev', false],
  ]);
});

test('it restores unused templates with all imps, tagging one whose name is taken', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  const templates = createTemplateService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    storage: ctx.storage,
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'now');

  await ctx.imps.stopImp('dev');
  await templates.createTemplate('dev', 'tools');
  await templates.createTemplate('dev', 'spare');
  await ctx.imps.createImp({ name: 'copy', image: 'tools', start: false });
  await backups.runBackup();

  const tools = await findImageByName(ctx.db, 'tools');

  invariant(tools);

  const fresh = await createImpTest(ctx.stack);

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    restic: buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() }).restic,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  // a docker image named tools
  await fresh.createTestImage('tools');

  const restored = await freshBackups.restoreBackup({ all: true });
  const spare = await findImageByName(fresh.db, 'spare');
  const copy = await findImpByName(fresh.db, 'copy');

  invariant(copy);

  expect(restored.imps.map((imp) => [imp.name, imp.image])).toStrictEqual([
    ['copy', `tools-${tools.digest.slice(-8)}`],
    ['dev', 'base'],
  ]);

  expect(spare).toMatchObject({ source: 'imp', sourceImp: 'dev' });
  expect(copy.isIdentityResetPending).toBeTrue();
  expect(readFileSync(buildImpPaths(fresh.dataDir, copy.id).disk, 'utf8')).toBe('now');
});

test.each([
  ['sha256:9f2c1a0b77', '9f2c1a0b'],
  ['imp-0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b', '3e4f5a6b'],
])('#buildDigestTag tags %s as %s', (digest, tag) => {
  expect(buildDigestTag(digest)).toBe(tag);
});

test('#buildBackupsOffError tells the caller to set a repository', () => {
  expect(buildBackupsOffError()).toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'backups are off: set IMP_BACKUP_REPOSITORY (docs/guides/configuration.md)',
  });
});

test('it leaves no imp behind when a restore fails part way', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });
  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(ctx.db, {
    id: 'cp-one',
    impId: dev.id,
    label: 'one',
    sizeBytes: oneBytes,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    diskBytes: 1003,
  });

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  // a pack restic could not read: the newest disk is missing, after the
  // checkpoint restored
  rmSync(join(ctx.repoDir, run.snapshotId, manifest.imps[0]?.disk ?? ''));

  expect(backups.restoreBackup({ name: 'dev', as: 'copy' })).rejects.toThrow('ENOENT');

  const copy = await findImpByName(ctx.db, 'copy');
  const checkpoints = await ctx.db.selectFrom('checkpoints').select('id').execute();

  expect(ctx.restic.restores).toContain(`imps/${dev.id}/checkpoints/cp-one`);
  expect(copy).toBeUndefined();
  expect(checkpoints).toStrictEqual([{ id: 'cp-one' }]);
  expect(readdirSync(join(ctx.dataDir, 'backup', 'restore'))).toStrictEqual([]);
});

test('it rejects a restore of a backup that holds no copy of the imp’s image', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  const manifestPath = join(ctx.repoDir, run.snapshotId, 'manifest.json');
  const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  writeFileSync(manifestPath, JSON.stringify({ ...manifest, images: [] }));

  expect(backups.restoreBackup({ name: 'dev', as: 'copy' })).rejects.toThrow(
    'the backup holds no image sha256:base',
  );
});

test('it prunes and checks on the first scheduled run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runScheduled();

  expect(ctx.restic.calls).toStrictEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'check',
  ]);
});

test('it runs nothing before the interval has passed', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(30 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([]);
});

test('it backs up without a prune or a check once the interval has passed', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(60 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual(['unlock', 'backup', 'forget']);
});

test('it logs a failed weekly check loudly and reports it in the status', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.restic.state.failCheck = true;

  ctx.advance(7 * 24 * 60 * 60 * 1000);

  await backups.runScheduled();

  const status = await backups.readStatus();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'check',
  ]);

  expect(ctx.backupLogs).toContain(
    'impd: backup: CHECK FAILED, the repository may be damaged: Fatal: pack 9f2c: ciphertext verification failed',
  );

  expect(status.lastCheck?.error).toContain('ciphertext verification failed');

  // both runs stay restore points, oldest first
  expect(status.points).toStrictEqual([
    { id: expect.toBeString(), time: new Date('2026-10-02T00:00:00Z'), imps: ['dev'] },
    { id: expect.toBeString(), time: new Date('2026-10-09T00:00:00Z'), imps: ['dev'] },
  ]);
});

test('it tries a prune that met a lock again on the next tick, not the next run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    new ResticError(
      'restic prune exited 11: unable to create lock in backend: repository is already locked exclusively by PID 7 on imp-host by root (UID 0, GID 0)',
      11,
    ),
  );

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  // the next tick, well inside the interval
  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  const status = await backups.readStatus();

  expect(ctx.backupLogs).toContain(
    'impd: backup: PRUNE FAILED: restic prune exited 11: unable to create lock in backend: repository is already locked exclusively by PID 7 on imp-host by root (UID 0, GID 0)',
  );

  expect(ctx.restic.calls.slice(before)).toStrictEqual(['unlock', 'prune']);
  expect(status.lastPruneAt).toBeValidDate();
});

test('it runs nothing on the tick after a prune it tried again succeeded', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    new ResticError('restic prune exited 11: unable to create lock in backend', 11),
  );

  await backups.runScheduled();

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([]);
});

test('it stops trying a prune again after six in a row meet a lock', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    ...Array.from(
      { length: 7 },
      () => new ResticError('restic prune exited 11: unable to create lock in backend', 11),
    ),
  );

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  // six ticks after the run's prune
  for (let tick = 0; tick < 6; tick += 1) {
    ctx.advance(5 * 60 * 1000);

    await backups.runScheduled();
  }

  expect(ctx.restic.calls.slice(before).filter((call) => call === 'prune')).toHaveLength(5);
});

test('it starts a new series of prune tries with the next run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    ...Array.from(
      { length: 7 },
      () => new ResticError('restic prune exited 11: unable to create lock in backend', 11),
    ),
  );

  // the run's prune and five ticks' meet six locks; the sixth tick tries none
  await backups.runScheduled();

  for (let tick = 0; tick < 6; tick += 1) {
    ctx.advance(5 * 60 * 1000);

    await backups.runScheduled();
  }

  const before = ctx.restic.calls.length;

  // the next run's prune meets the seventh lock, and the tick after succeeds
  ctx.advance(60 * 60 * 1000);

  await backups.runScheduled();

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  const status = await backups.readStatus();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'prune',
  ]);

  expect(status.lastPruneAt).toBeValidDate();
});

test('it leaves a prune that failed for another reason to the next run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    new ResticError('restic prune exited 1: Fatal: bucket full', 1),
  );

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([]);
});

test('it prunes again with the next run after a prune failed for another reason', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  ctx.restic.state.pruneErrors.push(
    new ResticError('restic prune exited 1: Fatal: bucket full', 1),
  );

  await backups.runScheduled();

  const before = ctx.restic.calls.length;

  ctx.advance(60 * 60 * 1000);

  await backups.runScheduled();

  expect(ctx.restic.calls.slice(before)).toStrictEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
  ]);
});

test('it leaves an imp being created out of the run', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  await updateImpState(ctx.db, dev.id, { reason: 'failed', state: 'creating' });

  const run = await backups.runBackup();

  expect(run.imps).toStrictEqual([]);
  expect(run.skipped).toStrictEqual([{ name: 'dev', reason: 'being created' }]);
});

test('it puts no secret, key, password or token of the host in a backup', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_never_backed_up' });
  await ctx.broker.addGrant('dev', 'gh');

  mkdirSync(join(ctx.dataDir, 'tls'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'tls', 'account.json'), 'acme-account-key-text');
  writeFileSync(join(ctx.dataDir, 'restic-password'), 'restic-password-text');
  writeFileSync(join(ctx.dataDir, 'token'), 'api-token-text');

  const run = await backups.runBackup();

  const snapshotDir = join(ctx.repoDir, run.snapshotId);

  const files = readdirSync(snapshotDir, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );

  const texts = files
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'))
    .join('\n');

  expect(files.map((entry) => join(entry.parentPath, entry.name))).not.toSatisfyAny(
    (path: string) =>
      /secrets|broker|tls|password|token|db\.sqlite/v.test(path.slice(snapshotDir.length)),
  );

  expect(texts).not.toMatch(
    /ghp_never_backed_up|acme-account-key-text|restic-password-text|api-token-text|PRIVATE KEY/v,
  );
});

test('it records an imp’s grants by secret name only', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_never_backed_up' });
  await ctx.broker.addGrant('dev', 'gh');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  expect(manifest.imps[0]?.grants).toStrictEqual(['gh']);
});

test('it regrants a restored imp by name and skips a secret that is gone', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addSecret({ name: 'npm-old', kind: 'npm', value: 'npm_value' });
  await ctx.broker.addGrant('dev', 'gh');
  await ctx.broker.addGrant('dev', 'npm-old');
  await backups.runBackup();
  await ctx.broker.deleteSecret('npm-old');

  const result = await backups.restoreBackup({ name: 'dev', as: 'back' });
  const grants = await ctx.broker.listGrants('back');

  expect(grants).toStrictEqual(['gh']);

  expect(result.skippedGrants).toStrictEqual([
    { imp: 'back', secret: 'npm-old', reason: expect.toInclude('npm-old') },
  ]);
});

test('it restores an imp’s egress policy and its allow list', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.egress.setPolicy('dev', { mode: 'box', allow: ['github.com', '*.npmjs.org'] });
  await backups.runBackup();
  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const policy = await ctx.egress.readPolicy('back');

  expect(policy).toStrictEqual({ mode: 'box', allow: ['github.com', '*.npmjs.org'] });
});

test('it puts a restored imp back on its networks, made again when gone', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const networks = createNetworkService({ db: ctx.db, egress: ctx.egress, imps: ctx.imps });

  await networks.createNetwork('lab');
  await networks.joinNetwork('lab', 'dev');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  await networks.deleteNetwork('lab');
  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const restored = await networks.listNetworks();

  expect(manifest.imps[0]?.networks).toStrictEqual(['lab']);

  expect(restored.map((network) => [network.name, network.imps])).toStrictEqual([
    ['lab', ['back']],
  ]);
});

test('it restores an egress policy this impd cannot read as none, never more open', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });

  const run = await backups.runBackup();

  // a policy from a newer impd
  const manifestPath = join(ctx.repoDir, run.snapshotId, 'manifest.json');
  const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      imps: [{ ...manifest.imps[0], egressPolicy: 'granted-only' }],
    }),
  );

  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const policy = await ctx.egress.readPolicy('back');

  expect(policy).toStrictEqual({ mode: 'none', allow: [] });

  expect(ctx.backupLogs).toContain(
    'impd: backup: back: unknown egress policy "granted-only"; restored as none',
  );
});

test('it restores one file at a time and leaves none behind', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });
  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(ctx.db, {
    id: 'cp-one',
    impId: dev.id,
    label: 'one',
    sizeBytes: oneBytes,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    diskBytes: 1003,
  });

  await backups.runBackup();

  const before = ctx.restic.restores.length;

  await backups.restoreBackup({ name: 'dev', as: 'copy' });

  expect(ctx.restic.restores.slice(before)).toStrictEqual([
    `imps/${dev.id}/checkpoints/cp-one`,
    `imps/${dev.id}/disk`,
  ]);

  expect(readdirSync(join(ctx.dataDir, 'backup', 'restore'))).toStrictEqual([]);
});

test('it ends the backoff of a failed scheduled run with a manual run that succeeds', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  ctx.restic.state.failBackup = true;

  const failed = await backups.runScheduled().catch((error: unknown) => error);

  ctx.restic.state.failBackup = false;

  ctx.advance(60 * 1000);

  await backups.runBackup();

  const before = ctx.restic.calls.length;

  // with the backoff left, the retry would be due 5 minutes after the failure
  ctx.advance(5 * 60 * 1000);

  await backups.runScheduled();

  expect(failed).toBeInstanceOf(Error);
  expect(ctx.restic.calls.slice(before)).toStrictEqual([]);
});

test('it waits twice as long after each failed scheduled run, up to the interval', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({
    ...ctx.deps,
    backup: buildMockBackupConfig({ intervalS: 3600 }),
  });

  // whether each tick, the given minutes after the last, started a run
  const failingTicks: boolean[] = [];
  const passingTicks: boolean[] = [];

  ctx.restic.state.failBackup = true;

  for (const minutes of [0, 4, 1, 9, 1, 20, 40, 59, 1]) {
    ctx.advance(minutes * 60 * 1000);

    const before = ctx.restic.calls.length;

    await backups.runScheduled().catch(() => {});

    failingTicks.push(ctx.restic.calls.length > before);
  }

  ctx.restic.state.failBackup = false;

  for (const minutes of [60, 30]) {
    ctx.advance(minutes * 60 * 1000);

    const before = ctx.restic.calls.length;

    await backups.runScheduled();

    passingTicks.push(ctx.restic.calls.length > before);
  }

  // the first failure, then 5, 10, 20 and 40 minutes, then the hour's interval
  expect(failingTicks).toStrictEqual([true, false, true, false, true, true, true, false, true]);

  // after a success, the interval again
  expect(passingTicks).toStrictEqual([true, false]);
});

test('it holds the storage gate for a restored image and disk room for each restored file', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'one');

  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(ctx.db, {
    id: 'cp-one',
    impId: dev.id,
    label: 'one',
    sizeBytes: oneBytes,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    diskBytes: 1003,
  });

  writeFileSync(buildImpPaths(ctx.dataDir, dev.id).disk, 'now');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));
  const [recorded] = manifest.imps;

  invariant(recorded);

  const [checkpoint] = recorded.checkpoints;

  invariant(checkpoint);

  const usedBytes = recorded.usedBytes ?? -1;
  const checkpointUsedBytes = checkpoint.usedBytes ?? -1;

  const fresh = await createImpTest(ctx.stack);

  const freshRestic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  const freshBackups = createBackupService({
    dataDir: fresh.dataDir,
    backup: buildMockBackupConfig(),
    db: fresh.db,
    imps: fresh.imps,
    grants: fresh.broker,
    networks: createNetworkService({ db: fresh.db, egress: fresh.egress, imps: fresh.imps }),
    storage: fresh.storage,
    storageGate: fresh.storageGate,
    diskBudget: fresh.diskBudget,
    restic: freshRestic.restic,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  // what each restore of a dir sees as it starts; a GC would wait for each
  const seen: { dir: string; isJoined: boolean; pendingBytes: number }[] = [];

  freshRestic.state.onRestore = async (dir) => {
    const status = await fresh.diskBudget.readStatus();

    seen.push({
      dir,
      isJoined: fresh.storageGate.countInFlight() > 0,
      pendingBytes: status.pendingBytes,
    });
  };

  await freshBackups.restoreBackup({ name: 'dev' });

  // what each disk file held in the tree, not its 32 GiB apparent size
  expect(usedBytes).toBeWithin(1, 1024 ** 2);
  expect(checkpointUsedBytes).toBeWithin(1, 1024 ** 2);

  expect(seen).toStrictEqual([
    {
      dir: 'images/base',
      isJoined: true,
      pendingBytes: expect.toSatisfy((bytes: number) => bytes > 0),
    },

    // twice each file's blocks: restic's sparse copy, then the disk
    { dir: dirname(checkpoint.disk), isJoined: true, pendingBytes: 2 * checkpointUsedBytes },
    { dir: dirname(recorded.disk), isJoined: true, pendingBytes: 2 * usedBytes },
  ]);
});

test('it grants a restored imp against the secret as it is now', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addGrant('dev', 'gh');
  await backups.runBackup();

  await ctx.broker.addSecret({
    name: 'gh',
    kind: 'custom',
    value: 'ghp_other',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  await backups.restoreBackup({ name: 'dev', as: 'back' });

  const back = await findImpByName(ctx.db, 'back');
  const secret = await findSecret(ctx.db, 'gh');

  invariant(back);
  invariant(secret);

  const rows = await ctx.db.selectFrom('grants').selectAll().execute();
  const isGranted = await ctx.broker.isGranted(back.id, 'api.github.com');

  expect(rows).toStrictEqual([
    { imp_id: back.id, secret_name: 'gh', secret_generation: secret.generation },
  ]);

  expect(isGranted).toBeTrue();
});

test('it refuses a revoke of a restored grant by a token’s list entry from before a rebind', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addGrant('dev', 'gh');

  // a token for back* that may grant gh as it is before the rebind
  const made = await ctx.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['back*'],
    grantable: ['gh'],
  });

  const caller = ctx.tokens.authenticate(made.secret);

  invariant(caller);

  const tokenId = caller.tokenId;
  const [entry] = caller.grantable;
  const generation = entry?.generation;

  invariant(tokenId);
  invariant(generation);

  await backups.runBackup();

  await ctx.broker.addSecret({
    name: 'gh',
    kind: 'custom',
    value: 'ghp_other',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  await backups.restoreBackup({ name: 'dev', as: 'back' });

  expect(ctx.broker.removeGrant('back', 'gh', { tokenId, generation })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it leaves the host’s imps, secrets and grants as they were when a restore fails', async () => {
  const ctx = await setupTest();

  const backups = createBackupService({ ...ctx.deps, backup: buildMockBackupConfig() });

  await ctx.createTestImage('base');

  writeFileSync(join(ctx.dataDir, 'images', 'base', 'config.json'), '{}');

  const dev = await ctx.imps.createImp({ name: 'dev' });
  const oneBytes = await ctx.storage.createCheckpoint(dev.id, 'cp-one');

  await createCheckpoint(ctx.db, {
    id: 'cp-one',
    impId: dev.id,
    label: 'one',
    sizeBytes: oneBytes,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    diskBytes: 1003,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addGrant('dev', 'gh');

  const run = await backups.runBackup();

  const manifestText = readFileSync(join(ctx.repoDir, run.snapshotId, 'manifest.json'), 'utf8');
  const manifest = BackupManifestSchema.parse(JSON.parse(manifestText));

  const checkpointsBefore = await ctx.db.selectFrom('checkpoints').selectAll().execute();

  const impsBefore = await ctx.db
    .selectFrom('imps')
    .select(['id', 'name'])
    .orderBy('name')
    .execute();

  const secretsBefore = await ctx.db.selectFrom('secrets').selectAll().execute();
  const grantsBefore = await ctx.db.selectFrom('grants').selectAll().execute();

  rmSync(join(ctx.repoDir, run.snapshotId, manifest.imps[0]?.disk ?? ''));

  expect(backups.restoreBackup({ name: 'dev', as: 'copy' })).rejects.toThrow('ENOENT');

  const impsAfter = await ctx.db
    .selectFrom('imps')
    .select(['id', 'name'])
    .orderBy('name')
    .execute();

  const secretsAfter = await ctx.db.selectFrom('secrets').selectAll().execute();
  const grantsAfter = await ctx.db.selectFrom('grants').selectAll().execute();
  const checkpointsAfter = await ctx.db.selectFrom('checkpoints').selectAll().execute();

  expect(ctx.restic.restores).toContain(`imps/${dev.id}/checkpoints/cp-one`);
  expect(impsAfter).toStrictEqual(impsBefore);
  expect(secretsAfter).toStrictEqual(secretsBefore);
  expect(grantsAfter).toStrictEqual(grantsBefore);
  expect(checkpointsAfter).toStrictEqual(checkpointsBefore);
});
