import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { listCheckpoints } from '../db/checkpoints';
import { findImpByName } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { buildImpPaths } from '../storage/data-layout';
import {
  buildCheckpointId,
  createCheckpointService,
  isValidCheckpointLabel,
} from './checkpoint-service';

async function setupTest() {
  // freeze, thaw, clone and stop calls in the order they happen
  const events: string[] = [];
  const state = { failClone: false };

  const createClone = (source: string, target: string): Promise<void> => {
    if (state.failClone) {
      return Promise.reject(new Error('clone failed'));
    }

    events.push(`clone ${source.slice(harness.dataDir.length)}`);

    copyFileSync(source, target);

    return Promise.resolve();
  };

  const harness = await setupImpTest({ cloneDisk: createClone });

  const checkpoints = createCheckpointService({
    config: harness.config,
    db: harness.db,
    imps: harness.imps,
    log: () => {},
    cloneDisk: createClone,
    freezer: {
      freeze: () => {
        events.push('freeze');

        return Promise.resolve();
      },
      thaw: () => {
        events.push('thaw');

        return Promise.resolve();
      },
    },
  });

  await harness.createTestImage('base');

  const findDisk = async (name: string): Promise<string> => {
    const imp = await findImpByName(harness.db, name);

    return buildImpPaths(harness.dataDir, imp?.id ?? '').disk;
  };

  return {
    db: harness.db,
    dataDir: harness.dataDir,
    imps: harness.imps,
    fake: harness.fake,
    checkpoints,
    events,
    state,
    readDisk: async (name: string) => {
      const disk = await findDisk(name);

      return readFileSync(disk, 'utf8');
    },
    writeDisk: async (name: string, content: string) => {
      const disk = await findDisk(name);

      writeFileSync(disk, content);
    },
    [Symbol.asyncDispose]: () => harness[Symbol.asyncDispose](),
  };
}

test('it generates short ids that labels cannot imitate', () => {
  const id = buildCheckpointId();

  expect(id).toMatch(/^cp-[a-km-z2-9]{6}$/);
  expect(buildCheckpointId(() => 0)).toBe('cp-aaaaaa');
  expect(isValidCheckpointLabel(id)).toBe(false);
  expect(isValidCheckpointLabel('clean')).toBe(true);
});

test('it freezes a running imp around the clone and records the checkpoint', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.events.length = 0;

  const checkpoint = await ctx.checkpoints.createCheckpoint('dev', 'clean');

  expect(ctx.events).toEqual(['freeze', `clone /imps/${imp.id}/disk.ext4`, 'thaw']);
  expect(checkpoint).toMatchObject({ label: 'clean' });
  expect(checkpoint.sizeBytes).toBeGreaterThanOrEqual(0);

  const disk = join(buildImpPaths(ctx.dataDir, imp.id).checkpointsDir, checkpoint.id, 'disk.ext4');

  expect(readFileSync(disk, 'utf8')).toBe('rootfs');

  const checkpoints = await ctx.checkpoints.listCheckpoints('dev');

  expect(checkpoints).toEqual([checkpoint]);
});

test('it clones a stopped imp without freezing it', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.stopImp('dev');

  ctx.events.length = 0;

  const checkpoint = await ctx.checkpoints.createCheckpoint('dev', undefined);

  expect(ctx.events).toHaveLength(1);
  expect(ctx.events[0]).toStartWith('clone ');
  expect(checkpoint.label).toBeUndefined();
});

test('it thaws and cleans up when the clone fails', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.events.length = 0;
  ctx.state.failClone = true;

  const rejection = await ctx.checkpoints
    .createCheckpoint('dev', undefined)
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(ctx.events).toEqual(['freeze', 'thaw']);

  const rows = await listCheckpoints(ctx.db, imp.id);

  expect(rows).toEqual([]);
  expect(readdirSync(buildImpPaths(ctx.dataDir, imp.id).checkpointsDir)).toEqual([]);
});

test('it rejects a taken label and a label shaped like an id', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.checkpoints.createCheckpoint('dev', 'clean');

  const taken = await ctx.checkpoints
    .createCheckpoint('dev', 'clean')
    .catch((error: unknown) => error);

  const idLike = await ctx.checkpoints
    .createCheckpoint('dev', 'cp-abc')
    .catch((error: unknown) => error);

  expect(taken).toMatchObject({ code: 'CONFLICT', data: { kind: 'checkpoint', name: 'clean' } });
  expect(idLike).toMatchObject({ code: 'BAD_REQUEST' });
});

test('it restores a running imp: stop, swap the disk, drop the snapshot, boot', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  await ctx.writeDisk('dev', 'a=1');
  await ctx.checkpoints.createCheckpoint('dev', 'v1');
  await ctx.writeDisk('dev', 'a=2');

  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(join(paths.snapshotDir, 'memory'), 'old');

  ctx.events.length = 0;

  const restored = await ctx.checkpoints.restoreCheckpoint('dev', 'v1');

  expect(restored.state).toBe('running');
  expect(ctx.fake.stops[0]).toEqual({ pid: 1001, graceful: true });

  const devDisk = await ctx.readDisk('dev');

  expect(devDisk).toBe('a=1');
  expect(existsSync(paths.snapshotDir)).toBe(false);
  expect(existsSync(`${paths.disk}.new`)).toBe(false);

  const record = await findImpByName(ctx.db, 'dev');

  expect(record?.pid).toBe(1002);
});

test('it restores a stopped imp and leaves it stopped', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });

  const checkpoint = await ctx.checkpoints.createCheckpoint('dev', undefined);

  await ctx.imps.stopImp('dev');
  await ctx.writeDisk('dev', 'changed');

  const restored = await ctx.checkpoints.restoreCheckpoint('dev', checkpoint.id);

  expect(restored.state).toBe('stopped');

  const devDisk = await ctx.readDisk('dev');

  expect(devDisk).toBe('rootfs');
});

test('it forks from a checkpoint and from the live disk into a new slot', async () => {
  await using ctx = await setupTest();

  const source = await ctx.imps.createImp({ name: 'dev', vcpus: 3, memoryMib: 1024 });

  await ctx.writeDisk('dev', 'a=1');
  await ctx.checkpoints.createCheckpoint('dev', 'v1');
  await ctx.writeDisk('dev', 'a=2');

  const fromCheckpoint = await ctx.checkpoints.forkImp({
    source: 'dev',
    name: 'old',
    checkpoint: 'v1',
  });

  ctx.events.length = 0;

  const fromLive = await ctx.checkpoints.forkImp({ source: 'dev', name: 'now' });

  expect(ctx.events.slice(0, 3)).toEqual(['freeze', `clone /imps/${source.id}/disk.ext4`, 'thaw']);
  expect(fromCheckpoint).toMatchObject({ state: 'running', vcpus: 3, memoryMib: 1024, slot: 1 });
  expect(fromLive).toMatchObject({ state: 'running', image: 'base', slot: 2 });

  const oldDisk = await ctx.readDisk('old');

  expect(oldDisk).toBe('a=1');

  const nowDisk = await ctx.readDisk('now');

  expect(nowDisk).toBe('a=2');

  const nowCheckpoints = await ctx.checkpoints.listCheckpoints('now');

  expect(nowCheckpoints).toEqual([]);
});

test('it creates no imp when the fork source or checkpoint is unknown', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });

  const noCheckpoint = await ctx.checkpoints
    .forkImp({ source: 'dev', name: 'copy', checkpoint: 'nope' })
    .catch((error: unknown) => error);

  const noSource = await ctx.checkpoints
    .forkImp({ source: 'gone', name: 'copy' })
    .catch((error: unknown) => error);

  expect(noCheckpoint).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'checkpoint' } });
  expect(noSource).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'imp' } });

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy).toBeUndefined();
});

test('it deletes a checkpoint by label, and destroy removes the rest', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const first = await ctx.checkpoints.createCheckpoint('dev', 'one');
  const second = await ctx.checkpoints.createCheckpoint('dev', 'two');

  await ctx.checkpoints.deleteCheckpoint('dev', 'one');

  expect(existsSync(join(paths.checkpointsDir, first.id))).toBe(false);

  const remaining = await ctx.checkpoints.listCheckpoints('dev');

  expect(remaining).toEqual([second]);

  await ctx.imps.destroyImp('dev');

  expect(existsSync(paths.dir)).toBe(false);

  const rows = await listCheckpoints(ctx.db, imp.id);

  expect(rows).toEqual([]);
});

test('a restore whose clone fails leaves a sleeping imp asleep with its memory', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  await ctx.checkpoints.createCheckpoint('dev', 'v1');
  await ctx.imps.sleepImp('dev');

  ctx.state.failClone = true;

  const rejection = await ctx.checkpoints
    .restoreCheckpoint('dev', 'v1')
    .catch((error: unknown) => error);

  const record = await findImpByName(ctx.db, 'dev');

  expect(rejection).toMatchObject({ message: 'clone failed' });
  expect(record?.state).toBe('sleeping');
  expect(existsSync(paths.memFile)).toBe(true);
  expect(existsSync(`${paths.disk}.new`)).toBe(false);
});
