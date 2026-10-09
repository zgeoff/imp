import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { buildStubZfs } from './build-stub-zfs';
import { createZfsTestDataset } from './create-zfs-test-dataset';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const parentDir = mkdtempSync(join(tmpdir(), 'zfs-test-dataset-'));

  onTestFinished(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  // the run's pool dataset, mounted on the dir its test datasets go under
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: parentDir });

  return { stack, parentDir, fake };
}

test('it makes a dataset of this run under the parent, mounted on a new dir', async () => {
  const ctx = setupTest();

  const dataset = await createZfsTestDataset(ctx.stack, {
    parent: 'tank/imp',
    parentDir: ctx.parentDir,
    run: ctx.fake.run,
  });

  expect(dataset.dataDir).toStartWith(join(ctx.parentDir, 'dataset-'));
  expect(dataset.root).toBe(`tank/imp/${basename(dataset.dataDir)}`);
  expect(ctx.fake.listDatasets()).toStrictEqual(['tank/imp', dataset.root]);
  expect(ctx.fake.readMountedAt(dataset.dataDir)).toBe(dataset.root);
});

test('it releases every mount under its dir, then the dataset with its children, then the dir', async () => {
  const ctx = setupTest();

  const dataset = await createZfsTestDataset(ctx.stack, {
    parent: 'tank/imp',
    parentDir: ctx.parentDir,
    run: ctx.fake.run,
  });

  // what a backend makes under its root, as impd's own datasets and mounts
  await ctx.fake.run(['zfs', 'create', `${dataset.root}/mem`]);
  await ctx.fake.run(['mount', '-t', 'zfs', `${dataset.root}/mem`, join(dataset.dataDir, 'mem')]);

  const before = ctx.fake.commands.length;

  await ctx.stack.disposeAsync();

  expect(ctx.fake.commands.slice(before)).toStrictEqual([
    `umount -R ${dataset.dataDir}`,
    `zfs destroy -R ${dataset.root}`,
  ]);

  expect(ctx.fake.listDatasets()).toStrictEqual(['tank/imp']);
  expect(ctx.fake.readMountedAt(join(dataset.dataDir, 'mem'))).toBeNull();
  expect(existsSync(dataset.dataDir)).toBeFalse();
});

test('it leaves a sibling dataset under the same parent when it releases its own', async () => {
  const ctx = setupTest();

  // another owner's dataset beside this run's
  await ctx.fake.run(['zfs', 'create', 'tank/imp/other']);

  const dataset = await createZfsTestDataset(ctx.stack, {
    parent: 'tank/imp',
    parentDir: ctx.parentDir,
    run: ctx.fake.run,
  });

  await ctx.fake.run(['zfs', 'snapshot', `${dataset.root}@one`]);
  await ctx.stack.disposeAsync();

  expect(ctx.fake.listDatasets()).toStrictEqual(['tank/imp', 'tank/imp/other']);
  expect(ctx.fake.listSnapshots()).toStrictEqual([]);
});

test('it reports a failed unmount, keeps the mounted dataset and still removes the dir', async () => {
  const ctx = setupTest();

  const dataset = await createZfsTestDataset(ctx.stack, {
    parent: 'tank/imp',
    parentDir: ctx.parentDir,
    run: ctx.fake.run,
  });

  ctx.fake.failOnce((command) => command.startsWith('umount -R'));

  expect(ctx.stack.disposeAsync()).rejects.toMatchObject({
    error: {
      message: `zfs destroy -R ${dataset.root} exited 1: cannot destroy '${dataset.root}': dataset is busy`,
    },
    suppressed: {
      message: `umount -R ${dataset.dataDir} exited 1: fake zfs: umount -R ${dataset.dataDir} failed`,
    },
  });

  expect(ctx.fake.listDatasets()).toStrictEqual(['tank/imp', dataset.root]);
  expect(ctx.fake.readMountedAt(dataset.dataDir)).toBe(dataset.root);
  expect(readdirSync(ctx.parentDir)).toStrictEqual([]);
});

test('it refuses a dataset name zfs already shows and never touches that dataset', async () => {
  const ctx = setupTest();

  // another owner makes the dataset just before the check
  const run = async (argv: readonly string[]) => {
    if (argv[1] === 'list') {
      await ctx.fake.run(['zfs', 'create', argv.at(-1) ?? '']);
    }

    return ctx.fake.run(argv);
  };

  expect(
    createZfsTestDataset(ctx.stack, { parent: 'tank/imp', parentDir: ctx.parentDir, run }),
  ).rejects.toThrow(/^zfs: tank\/imp\/dataset-\w+ exists already, and this run did not make it$/);

  const taken = ctx.fake.listDatasets().find((name) => name !== 'tank/imp');

  invariant(taken);

  await ctx.stack.disposeAsync();

  expect(taken).toStartWith('tank/imp/dataset-');
  expect(ctx.fake.listDatasets()).toStrictEqual(['tank/imp', taken]);

  expect(ctx.fake.commands.filter((command) => command.startsWith('zfs destroy'))).toStrictEqual(
    [],
  );

  expect(readdirSync(ctx.parentDir)).toStrictEqual([]);
});

test('it removes only its dir when the dataset cannot be made', async () => {
  const ctx = setupTest();

  ctx.fake.failOnce((command) => command.startsWith('zfs create'));

  expect(
    createZfsTestDataset(ctx.stack, {
      parent: 'tank/imp',
      parentDir: ctx.parentDir,
      run: ctx.fake.run,
    }),
  ).rejects.toThrow(/^zfs create -o mountpoint=legacy tank\/imp\/dataset-\w+ exited 1: /);

  await ctx.stack.disposeAsync();

  expect(ctx.fake.commands.filter((command) => !command.startsWith('zfs list'))).toStrictEqual([]);
  expect(ctx.fake.listDatasets()).toStrictEqual(['tank/imp']);
  expect(readdirSync(ctx.parentDir)).toStrictEqual([]);
});

test('it destroys its dataset and removes its dir when the mount fails', async () => {
  const ctx = setupTest();

  ctx.fake.failOnce((command) => command.startsWith('mount'));

  expect(
    createZfsTestDataset(ctx.stack, {
      parent: 'tank/imp',
      parentDir: ctx.parentDir,
      run: ctx.fake.run,
    }),
  ).rejects.toThrow(/^mount -t zfs tank\/imp\/dataset-\w+ \S+ exited 1: /);

  const made = ctx.fake.listDatasets();

  await ctx.stack.disposeAsync();

  expect(made).toHaveLength(2);
  expect(ctx.fake.listDatasets()).toStrictEqual(['tank/imp']);
  expect(ctx.fake.commands.filter((command) => command.startsWith('umount'))).toStrictEqual([]);
  expect(readdirSync(ctx.parentDir)).toStrictEqual([]);
});
