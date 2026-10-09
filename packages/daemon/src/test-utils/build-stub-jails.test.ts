import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubJails } from './build-stub-jails';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-jails-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it hands a prepare the command it was given, and keeps the plan', async () => {
  const stub = buildStubJails({ argv: ['firecracker', '--api-sock', '/a.sock'] });

  const plan = {
    impId: 'i1',
    user: { uid: 900_001, gid: 900_001 },
    paths: buildImpPaths('/nonexistent', 'i1'),
    readOnlyFiles: [],
    scratchFiles: [],
    isDiskLate: true,
  };

  const argv = await stub.jails.prepare(plan);

  expect(argv).toStrictEqual(['firecracker', '--api-sock', '/a.sock']);
  expect(stub.plans).toStrictEqual([plan]);
});

test('it notes whether the disk is there when a prepare comes', async () => {
  const ctx = setupTest();
  const stub = buildStubJails({ argv: [] });
  const paths = buildImpPaths(ctx.dir, 'i1');

  await stub.jails.prepare({
    impId: 'i1',
    user: { uid: 900_001, gid: 900_001 },
    paths,
    readOnlyFiles: [],
    scratchFiles: [],
    isDiskLate: true,
  });

  expect(stub.notes).toStrictEqual(['prepare i1 late=true disk=false']);
});

test('it notes whether the disk is there when it takes the disk', () => {
  const ctx = setupTest();
  const stub = buildStubJails();
  const paths = buildImpPaths(ctx.dir, 'i1');

  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.disk, '');

  stub.jails.setupDiskOwner(paths, { uid: 900_001, gid: 900_001 });

  expect(stub.notes).toStrictEqual(['own disk=true']);
});

test('it rejects a prepare when no command was given', () => {
  const stub = buildStubJails();

  expect(
    stub.jails.prepareBuild({
      id: 'tpl',
      user: { uid: 900_001, gid: 900_001 },
      workDir: '/w',
      paths: {
        runDir: '/w/run',
        apiSocket: '/w/run/api.sock',
        vsockSocket: '/w/run/vsock.sock',
        logFile: '/w/run/firecracker.log',
        pidFile: '/w/run/pid',
      },
      readOnlyFiles: [],
      scratchFiles: [],
    }),
  ).rejects.toThrowWithMessage(Error, 'no jail command given');
});

test('it rejects each prepare once told to refuse them', () => {
  const stub = buildStubJails({ argv: [] });

  stub.refusePrepare(new Error('mount --rbind: no space'));

  expect(
    stub.jails.prepare({
      impId: 'i1',
      user: { uid: 900_001, gid: 900_001 },
      paths: buildImpPaths('/nonexistent', 'i1'),
      readOnlyFiles: [],
      scratchFiles: [],
      isDiskLate: false,
    }),
  ).rejects.toThrowWithMessage(Error, 'mount --rbind: no space');
});

test('it throws from each seal once told to refuse them, after noting it', () => {
  const stub = buildStubJails();

  stub.refuseSeal(new Error('run/ is planted'));

  expect(() => {
    stub.jails.seal(buildImpPaths('/nonexistent', 'i1'), 1);
  }).toThrowWithMessage(Error, 'run/ is planted');

  expect(stub.notes).toStrictEqual(['seal']);
});

test('it notes each release, sweep and remove in order, and hands each note on', async () => {
  const handed: string[] = [];

  const stub = buildStubJails({
    onNote: (note) => {
      handed.push(note);
    },
  });

  await stub.jails.sweepRunDir(buildImpPaths('/nonexistent', 'i1'));
  await stub.jails.release('i1');
  await stub.jails.remove('i1');

  expect(stub.notes).toStrictEqual(['sweep i1', 'release i1', 'remove i1']);
  expect(handed).toStrictEqual(stub.notes);
});

test('it finds no orphan jails', async () => {
  const stub = buildStubJails();

  const removed = await stub.jails.removeOrphans(new Set(['i1']));

  expect(removed).toStrictEqual([]);
});
