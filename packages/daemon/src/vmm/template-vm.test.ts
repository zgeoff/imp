import { expect, onTestFinished, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockTemplateBuildPlan } from '../test-utils/build-mock-template-build-plan';
import { buildMockTemplateRestorePlan } from '../test-utils/build-mock-template-restore-plan';
import { buildStubJails } from '../test-utils/build-stub-jails';
import { buildStubFirecrackerArgv } from '../test-utils/start-stub-firecracker';
import { startStubParkedAgent } from '../test-utils/start-stub-parked-agent';
import { isFirecrackerAlive, stopProcess } from './firecracker-process';
import { TemplateRestoreError, buildTemplateVm, loadTemplateVm } from './template-vm';

// A temp dir with one log that the stub VMM and the stub jails both append
// to, so the order of their calls shows.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-tpl-vm-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, logPath: join(dir, 'calls.log') };
}

test('it owns the disk of a jailed restore once the clone is done, before it patches the drive', async () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.dir, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: paths.apiSocket, logPath: ctx.logPath }),
    onNote: (note) => {
      appendFileSync(ctx.logPath, `${note}\n`);
    },
  });

  const clone = Promise.withResolvers<number>();

  const plan = buildMockTemplateRestorePlan({
    paths,
    jail: { uid: 900_001, gid: 900_001 },
    diskReady: clone.promise,
  });

  const restoring = loadTemplateVm(plan, stub.jails);

  await waitFor(() => {
    expect(existsSync(paths.apiSocket)).toBeTrue();
  });

  const pid = Number(readFileSync(paths.pidFile, 'utf8'));

  onTestFinished(() => {
    stopProcess(pid);
  });

  await startStubParkedAgent(paths.vsockSocket);

  // the clone lands once the restore has resumed the parked guest
  await waitFor(() => {
    expect(readFileSync(ctx.logPath, 'utf8')).toInclude('PATCH /vm\n');
  });

  writeFileSync(paths.disk, '');

  clone.resolve(0);

  await restoring;

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'prepare i1 late=true disk=false',
    'PUT /snapshot/load',
    'seal',
    'PATCH /vm',
    'own disk=true',
    'PATCH /drives/rootfs',
    'GET /version',
  ]);

  // without the drive the snapshot names, every jailed load fails
  expect(stub.plans).toStrictEqual([
    {
      impId: 'i1',
      user: { uid: 900_001, gid: 900_001 },
      paths,
      readOnlyFiles: [plan.vmstate, plan.memFile, plan.systemDrivePath],
      scratchFiles: [plan.placeholderPath],
      isDiskLate: true,
    },
  ]);
});

test('it fails a restore whose load fails as a fault of the template', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.dir, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT /snapshot/load'],
    }),
  });

  const restoring = loadTemplateVm(
    buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
    stub.jails,
  );

  expect(restoring).rejects.toBeInstanceOf(TemplateRestoreError);
  expect(restoring).rejects.toMatchObject({ isTemplateFault: true });
  expect(restoring).rejects.toThrow(/^template restore failed: /);
});

test('it fails a restore whose drive patch fails as a fault of the imp', async () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.dir, 'i1');

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.disk, '');

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PATCH /drives'],
    }),
  });

  const restoring = loadTemplateVm(
    buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
    stub.jails,
  );

  await waitFor(() => {
    expect(existsSync(paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(paths.vsockSocket);

  expect(restoring).rejects.toBeInstanceOf(TemplateRestoreError);
  expect(restoring).rejects.toMatchObject({ isTemplateFault: false });
});

test('it kills the VM and releases the jail of a restore that fails', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.dir, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT /snapshot/load'],
    }),
  });

  expect(
    loadTemplateVm(
      buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
      stub.jails,
    ),
  ).rejects.toThrow();

  const pid = Number(readFileSync(paths.pidFile, 'utf8'));

  expect(isFirecrackerAlive(pid, paths.apiSocket)).toBeFalse();
  expect(stub.notes.at(-1)).toBe('release i1');
});

test('it releases the jail of a restore whose prepare fails, and passes the error on', () => {
  const ctx = setupTest();
  const paths = buildImpPaths(ctx.dir, 'i1');
  const stub = buildStubJails({ argv: [] });

  stub.refusePrepare(new Error('mount --rbind: no space'));

  expect(
    loadTemplateVm(
      buildMockTemplateRestorePlan({ paths, jail: { uid: 900_001, gid: 900_001 } }),
      stub.jails,
    ),
  ).rejects.toThrowWithMessage(Error, 'mount --rbind: no space');

  expect(stub.notes).toStrictEqual(['prepare i1 late=true disk=false', 'release i1']);
});

test('it releases the jail of a build before its files go to root, readable by all', async () => {
  const ctx = setupTest();

  // a build chowns its snapshot files to its uid: the test's own, without root
  const user = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.dir, '.build-1'),
    jailId: 'tpl-build',
    jail: user,
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: plan.paths.apiSocket, logPath: ctx.logPath }),
    onNote: (note) => {
      appendFileSync(ctx.logPath, `${note}\n`);
    },
  });

  // the release kills the build uid: the files are still the VM's then
  const memModes: string[] = [];

  const building = buildTemplateVm(plan, {
    ...stub.jails,
    release: (id) => {
      memModes.push((lstatSync(plan.memFile).mode & 0o777).toString(8));

      return stub.jails.release(id);
    },
  });

  await waitFor(() => {
    expect(existsSync(plan.paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(plan.paths.vsockSocket);
  await building;

  const calls = readFileSync(ctx.logPath, 'utf8').trim().split('\n');

  expect(calls[0]).toBe('prepare build tpl-build');
  expect(calls.indexOf('seal')).toBeLessThan(calls.indexOf('PUT /actions'));
  expect(calls.at(-1)).toBe('release tpl-build');
  expect(memModes).toStrictEqual(['600']);
  expect(lstatSync(plan.memFile).mode & 0o777).toBe(0o644);
  expect(lstatSync(plan.vmstate).mode & 0o777).toBe(0o644);
});

test('it binds the kernel and the system drive into a jailed build read-only', async () => {
  const ctx = setupTest();
  const user = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.dir, '.build-1'),
    jailId: 'tpl-build',
    jail: user,
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({ apiSocket: plan.paths.apiSocket, logPath: ctx.logPath }),
  });

  const building = buildTemplateVm(plan, stub.jails);

  await waitFor(() => {
    expect(existsSync(plan.paths.apiSocket)).toBeTrue();
  });

  await startStubParkedAgent(plan.paths.vsockSocket);
  await building;

  expect(stub.plans).toStrictEqual([
    {
      id: 'tpl-build',
      user,
      workDir: plan.workDir,
      paths: plan.paths,
      readOnlyFiles: [plan.kernelPath, plan.systemDrivePath],
      scratchFiles: [plan.placeholderPath],
    },
  ]);
});

test('it fails a build whose VM refuses its config', () => {
  const ctx = setupTest();

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.dir, '.build-1'),
    jailId: 'tpl-build',
    jail: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: plan.paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT '],
    }),
  });

  expect(buildTemplateVm(plan, stub.jails)).rejects.toThrow(/^template build failed: /);
});

test('it releases the jail of a build that fails, and leaves no snapshot', () => {
  const ctx = setupTest();

  const plan = buildMockTemplateBuildPlan({
    workDir: join(ctx.dir, '.build-1'),
    jailId: 'tpl-build',
    jail: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  });

  mkdirSync(plan.paths.runDir, { recursive: true });

  const stub = buildStubJails({
    argv: buildStubFirecrackerArgv({
      apiSocket: plan.paths.apiSocket,
      logPath: ctx.logPath,
      failures: ['PUT '],
    }),
  });

  expect(buildTemplateVm(plan, stub.jails)).rejects.toThrow();
  expect(stub.notes.at(-1)).toBe('release tpl-build');
  expect(existsSync(plan.snapshotDir)).toBeFalse();
});
