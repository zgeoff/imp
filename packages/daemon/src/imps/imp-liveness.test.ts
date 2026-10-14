import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findImpByName, updateImpState } from '../db/imps';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { createImpTest, writeTestSnapshot } from './test-imps';
import type { ImpTestOptions } from './test-imps';

async function setupTest(options: ImpTestOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // the host's taint mask, as /proc/sys/kernel/tainted; a test writes it
  const taintDir = mkdtempSync(join(tmpdir(), 'imp-taint-'));

  stack.defer(() => {
    rmSync(taintDir, { recursive: true, force: true });
  });

  const taintPath = join(taintDir, 'tainted');

  const harness = await createImpTest(stack, { taintPath, ...options });

  // the image every imp boots from
  await harness.createTestImage('ubuntu');

  return { ...harness, taintPath };
}

test('it finds a VM that died after its sleep wrote the snapshot asleep, not stopped', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // impd stopped between the snapshot and the record update
  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, imp.id),
    imp.lastActiveAt.getTime() + 1000,
    ctx.readIdentity(),
  );

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('sleeping');
});

test('it wakes an imp found asleep after its VM died from the snapshot', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // impd stopped between the snapshot and the record update
  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, imp.id),
    imp.lastActiveAt.getTime() + 1000,
    ctx.readIdentity(),
  );

  ctx.fake.alive.clear();

  await ctx.imps.getImp('dev');

  const woken = await ctx.imps.wakeImp('dev');

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('it finds a dead VM with a snapshot from before its last activity stopped', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // an earlier sleep's snapshot, which the imp ran past
  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, imp.id),
    imp.lastActiveAt.getTime() - 1000,
    ctx.readIdentity(),
  );

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
});

test('it finds a dead VM stopped after a real sleep and wake left the snapshot behind it', async () => {
  const ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.sleepImp('dev');
  await ctx.imps.wakeImp('dev');

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
});

test('it finds a VM that its memory limit killed stopped, and says so', async () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  stub.oomKills.set(imp.id, 1);
  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
  expect(found.error).toBe('its memory limit killed firecracker');
});

test('it finds a VM lost after a kernel oops stopped, and says so', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  // impd's start reads the flag clear
  await ctx.imps.reconcileImps();
  await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(ctx.taintPath, '128\n');

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
  expect(found.error).toBe('a kernel oops killed firecracker');
});

test('it gives the kernel oops as the trigger of the state change', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  // impd's start reads the flag clear
  await ctx.imps.reconcileImps();
  await ctx.imps.createImp({ name: 'dev' });

  const changes: unknown[] = [];

  ctx.imps.events.subscribe((event) => {
    if (event.ev === 'ImpChanged' && event.reason === 'repaired') {
      changes.push(event.detail);
    }
  });

  writeFileSync(ctx.taintPath, '128\n');

  ctx.fake.alive.clear();

  await ctx.imps.getImp('dev');

  expect(changes).toStrictEqual([{ trigger: 'a kernel oops killed firecracker' }]);
});

test('it logs that an imp a kernel oops killed stays off its disk until the host reboots', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  // impd's start reads the flag clear
  await ctx.imps.reconcileImps();
  await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(ctx.taintPath, '128\n');

  ctx.fake.alive.clear();

  await ctx.imps.getImp('dev');

  expect(ctx.logs).toContain(
    'impd: dev: a kernel oops killed firecracker; marked it stopped; it stays off its disk until the host reboots',
  );
});

test('it refuses to start an imp a kernel oops killed until the host reboots', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  // impd's start reads the flag clear
  await ctx.imps.reconcileImps();
  await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(ctx.taintPath, '128\n');

  ctx.fake.alive.clear();

  await ctx.imps.getImp('dev');

  expect(ctx.imps.startImp('dev')).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message:
      'the host needs a reboot: a kernel oops holds the disk of dev; reboot the host, then start it',
  });
});

test('it boots no VM on the disk of an imp a kernel oops killed', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  // impd's start reads the flag clear
  await ctx.imps.reconcileImps();
  await ctx.imps.createImp({ name: 'dev' });

  writeFileSync(ctx.taintPath, '128\n');

  ctx.fake.alive.clear();

  await ctx.imps.getImp('dev');

  const bootsBefore = ctx.fake.boots.length;

  expect(ctx.imps.startImp('dev')).toReject();
  expect(ctx.fake.boots).toHaveLength(bootsBefore);
});

test('it refuses to wake an imp whose VM a kernel oops killed after its sleep wrote the snapshot', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  // impd's start reads the flag clear
  await ctx.imps.reconcileImps();

  const imp = await ctx.imps.createImp({ name: 'dev' });

  // impd stopped between the snapshot and the record update
  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, imp.id),
    imp.lastActiveAt.getTime() + 1000,
    ctx.readIdentity(),
  );

  writeFileSync(ctx.taintPath, '128\n');

  ctx.fake.alive.clear();

  await ctx.imps.getImp('dev');

  expect(ctx.imps.wakeImp('dev')).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message:
      'the host needs a reboot: a kernel oops holds the disk of dev; reboot the host, then start it',
  });
});

test('it gives no kernel oops trigger to a VM that booted after impd saw the oops', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  // impd's start reads the flag clear, then /health reads it set
  await ctx.imps.reconcileImps();

  writeFileSync(ctx.taintPath, '128\n');

  ctx.imps.readRebootReason();
  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  // the API leaves out an error the record does not have
  expect(found.state).toBe('stopped');
  expect(found).not.toContainKey('error');
});

test('it gives no kernel oops trigger to a VM lost while the flag stays as impd found it at start', async () => {
  const ctx = await setupTest();

  // the oops came before this impd started, and this VM outlived it
  writeFileSync(ctx.taintPath, '128\n');

  await ctx.imps.reconcileImps();
  await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  // the API leaves out an error the record does not have
  expect(found.state).toBe('stopped');
  expect(found).not.toContainKey('error');
});

test('it logs at start that the host needs a reboot when the kernel has oopsed', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.taintPath, '128\n');

  await ctx.imps.reconcileImps();

  expect(ctx.logs).toContain(
    'impd: the kernel oopsed since the host booted (taint flag D); the host needs a reboot',
  );
});

test('it starts an imp a kernel oops killed once the host has rebooted', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  // the record an oops left before the reboot, which cleared the flag
  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    pid: null,
    error: 'a kernel oops killed firecracker',
  });

  writeFileSync(ctx.taintPath, '0\n');

  const started = await ctx.imps.startImp('dev');
  const record = await findImpByName(ctx.db, 'dev');

  expect(started.state).toBe('running');
  expect(record?.error).toBeNull();
});

test('it starts an imp held by an oops of an earlier boot after a new oops in another task', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  // the record an oops left before the reboot, which cleared the flag
  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    pid: null,
    error: 'a kernel oops killed firecracker',
  });

  writeFileSync(ctx.taintPath, '0\n');

  // impd's start after the reboot reads the flag clear; then another task oopses
  await ctx.imps.reconcileImps();

  writeFileSync(ctx.taintPath, '128\n');

  const started = await ctx.imps.startImp('dev');

  expect(started.state).toBe('running');
});

test('it keeps the hold of an imp a kernel oops killed when impd starts with the flag still set', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  // the record an oops of this boot left before impd restarted
  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    pid: null,
    error: 'a kernel oops killed firecracker',
  });

  writeFileSync(ctx.taintPath, '128\n');

  await ctx.imps.reconcileImps();

  expect(ctx.imps.startImp('dev')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});

test('it clears the hold of an imp a kernel oops killed when impd starts with flag D clear', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  // the record an oops left before the reboot, which cleared the flag
  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    pid: null,
    error: 'a kernel oops killed firecracker',
  });

  writeFileSync(ctx.taintPath, '0\n');

  await ctx.imps.reconcileImps();

  const record = await findImpByName(ctx.db, 'dev');

  expect(record?.error).toBeNull();
  expect(ctx.logs).toContain('impd: dev: the host rebooted since a kernel oops held its disk');
});

test('it keeps the record of a hold when impd starts with flag D set', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  // the record an oops of this boot left before impd restarted
  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    pid: null,
    error: 'a kernel oops killed firecracker',
  });

  writeFileSync(ctx.taintPath, '128\n');

  await ctx.imps.reconcileImps();

  const record = await findImpByName(ctx.db, 'dev');

  expect(record?.error).toBe('a kernel oops killed firecracker');
});

test('it keeps every hold when impd starts without the taint file', async () => {
  const ctx = await setupTest();
  const first = await ctx.imps.createImp({ name: 'dev' });
  const second = await ctx.imps.createImp({ name: 'build' });

  await ctx.imps.stopImp('dev');
  await ctx.imps.stopImp('build');

  // the records an oops left; nothing proves the host rebooted since
  for (const impId of [first.id, second.id]) {
    await updateImpState(ctx.db, impId, {
      reason: 'repaired',
      state: 'stopped',
      pid: null,
      error: 'a kernel oops killed firecracker',
    });
  }

  await ctx.imps.reconcileImps();

  const records = await Promise.all(['dev', 'build'].map((name) => findImpByName(ctx.db, name)));

  expect(records.map((record) => record?.error)).toEqual([
    'a kernel oops killed firecracker',
    'a kernel oops killed firecracker',
  ]);

  expect(ctx.imps.startImp('dev')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(ctx.imps.startImp('build')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});

test('it keeps the hold when impd starts with a taint file it cannot read', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  // the record an oops left; nothing proves the host rebooted since
  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    pid: null,
    error: 'a kernel oops killed firecracker',
  });

  // a directory where the file should be: the read fails with EISDIR
  mkdirSync(ctx.taintPath);

  await ctx.imps.reconcileImps();

  const record = await findImpByName(ctx.db, 'dev');

  expect(record?.error).toBe('a kernel oops killed firecracker');
  expect(ctx.imps.startImp('dev')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});

test('it keeps the hold when impd starts with a malformed taint file', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  // the record an oops left; nothing proves the host rebooted since
  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    pid: null,
    error: 'a kernel oops killed firecracker',
  });

  writeFileSync(ctx.taintPath, 'tainted\n');

  await ctx.imps.reconcileImps();

  const record = await findImpByName(ctx.db, 'dev');

  expect(record?.error).toBe('a kernel oops killed firecracker');
});

test('it logs at start that held imps stay held when it cannot read the taint flag', async () => {
  const ctx = await setupTest();

  await ctx.imps.reconcileImps();

  expect(ctx.logs).toContain(
    'impd: cannot read the kernel taint flag; imps a kernel oops held stay held',
  );
});
