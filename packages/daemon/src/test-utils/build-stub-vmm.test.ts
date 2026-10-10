import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { AgentError } from '../agent-client/agent-connection';
import { deriveSlotAddress, parseSubnet } from '../net/addressing';
import { buildImpPaths, buildSnapshotPaths } from '../storage/data-layout';
import { TemplateRestoreError } from '../vmm/template-vm';
import { STUB_AGENT_VERSION, StubVmError, buildStubBootId, buildStubVmm } from './build-stub-vmm';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-vmm-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // every runner call takes an imp's paths; the fake writes snapshots there
  const paths = buildImpPaths(dir, 'imp-1');
  const fake = buildStubVmm();
  const runner = fake.startGeneration();

  return { dir, paths, fake, runner };
}

test('#STUB_AGENT_VERSION is the agent version a boot reports by default', async () => {
  const ctx = await setupTest();

  const vm = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  expect(vm.agentVersion).toBe(STUB_AGENT_VERSION);
});

test('#StubVmError names itself so a test can tell it from a real bug', () => {
  expect(new StubVmError('boom')).toMatchObject({ name: 'StubVmError', message: 'boom' });
});

test('#buildStubBootId builds a version 4 UUID, as the kernel writes a boot_id', () => {
  expect(buildStubBootId(1001)).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
  );
});

test('#buildStubBootId builds the same id for the same pid', () => {
  expect(buildStubBootId(1001)).toBe(buildStubBootId(1001));
});

test('#buildStubBootId builds different ids for different pids', () => {
  expect(buildStubBootId(1001)).not.toBe(buildStubBootId(1002));
});

test('#buildStubVmm starts a running VM with a boot id from its pid on a boot', async () => {
  const ctx = await setupTest();

  const vm = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  expect(vm).toStrictEqual({
    pid: 1001,
    firecrackerVersion: 'v1.17.0',
    agentVersion: '0.1.0',
    timings: {},
    bootId: buildStubBootId(1001),
  });

  expect(ctx.runner.isVmAlive(1001, ctx.paths)).toBeTrue();
  expect(ctx.fake.readState(1001)).toBe('Running');
  expect(ctx.runner.readPid(ctx.paths)).toBe(1001);
  expect(ctx.fake.boots).toStrictEqual([{ hostname: 'alpha', isIdentityReset: false }]);
});

test('#buildStubVmm reports the agent version a test sets on a boot', async () => {
  const ctx = await setupTest();

  ctx.fake.agent.version = '0.5.0';

  const vm = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  expect(vm.agentVersion).toBe('0.5.0');
});

test('#buildStubVmm rejects a failed boot and leaves no VM', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('boot', 'fail');

  const booting = ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  await expect(booting).toReject();

  expect(ctx.fake.alive).toBeEmpty();
  expect(ctx.runner.listVms()).toStrictEqual([]);
  expect(ctx.runner.readPid(ctx.paths)).toBeNull();
});

test('#buildStubVmm rejects a failed boot with a fake error', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('boot', 'fail');

  const booting = ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  expect(booting).rejects.toThrowWithMessage(StubVmError, /^boot failed/);
});

test('#buildStubVmm returns the pid of a VM that is already gone when a boot dies', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('boot', 'die');

  const vm = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  expect(ctx.runner.isVmAlive(vm.pid, ctx.paths)).toBeFalse();
  expect(ctx.runner.readPid(ctx.paths)).toBe(vm.pid);
  expect(ctx.runner.listVms()).toStrictEqual([]);
});

test('#buildStubVmm reports the identity reset result on a boot that asks for one', async () => {
  const ctx = await setupTest();

  ctx.fake.setIdentityReset('failed');

  const vm = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: true,
    jail: null,
  });

  expect(vm.identityReset).toBe('failed');
});

test('#buildStubVmm reports an ok identity reset by default', async () => {
  const ctx = await setupTest();

  const vm = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: true,
    jail: null,
  });

  expect(vm.identityReset).toBe('ok');
});

test('#buildStubVmm reports an absent identity reset for an agent that leaves it out', async () => {
  const ctx = await setupTest();

  ctx.fake.setIdentityReset(undefined);

  const vm = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: true,
    jail: null,
  });

  expect(vm).toStrictEqual({
    pid: 1001,
    firecrackerVersion: 'v1.17.0',
    agentVersion: '0.1.0',
    timings: {},
    bootId: buildStubBootId(1001),
    identityReset: undefined,
  });
});

test('#buildStubVmm leaves the boot id out once guests stop reporting one', async () => {
  const ctx = await setupTest();

  ctx.fake.setGuestBootId(false);

  const vm = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  expect(vm.bootId).toBeUndefined();
});

test('#buildStubVmm keeps the boot id of the socket last boot on a wake', async () => {
  const ctx = await setupTest();

  const booted = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  await ctx.runner.sleepVm(booted.pid, ctx.paths, null, ctx.paths);

  const woken = await ctx.runner.wakeVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    cgroup: null,
    jail: null,
    readOnlyFiles: ['/images/system.ext4'],
  });

  expect(woken).toStrictEqual({
    pid: 1002,
    firecrackerVersion: 'v1.17.0',
    agentVersion: '0.1.0',
    timings: {},
    bootId: buildStubBootId(1001),
  });
});

test('#buildStubVmm starts a running VM and marks its snapshot used on a wake', async () => {
  const ctx = await setupTest();

  const vm = await ctx.runner.wakeVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    cgroup: null,
    jail: null,
    readOnlyFiles: ['/images/system.ext4'],
  });

  expect(ctx.fake.wakes).toStrictEqual([vm.pid]);
  expect(ctx.fake.readState(vm.pid)).toBe('Running');
  expect([...ctx.fake.usedSnapshots]).toStrictEqual([ctx.paths.snapshotDir]);
});

test('#buildStubVmm marks the snapshot used and leaves no VM when a wake fails', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('wake', 'fail');

  await expect(
    ctx.runner.wakeVm({
      firecrackerBin: '/usr/bin/firecracker',
      paths: ctx.paths,
      cgroup: null,
      jail: null,
      readOnlyFiles: ['/images/system.ext4'],
    }),
  ).toReject();

  expect([...ctx.fake.usedSnapshots]).toStrictEqual([ctx.paths.snapshotDir]);
  expect(ctx.fake.alive).toBeEmpty();
  expect(ctx.fake.wakes).toStrictEqual([]);
});

test('#buildStubVmm returns the pid of a VM that is already gone when a wake dies', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('wake', 'die');

  const vm = await ctx.runner.wakeVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    cgroup: null,
    jail: null,
    readOnlyFiles: ['/images/system.ext4'],
  });

  expect(ctx.runner.isVmAlive(vm.pid, ctx.paths)).toBeFalse();
});

test('#buildStubVmm records the jail user and the snapshot files present when a wake begins', async () => {
  const ctx = await setupTest();

  mkdirSync(ctx.paths.snapshotDir, { recursive: true });
  writeFileSync(ctx.paths.disk, 'disk');
  writeFileSync(ctx.paths.vmstate, 'vmstate');

  await ctx.runner.wakeVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    cgroup: null,
    jail: { uid: 30_001, gid: 30_001 },
    readOnlyFiles: ['/images/system.ext4'],
  });

  expect(ctx.fake.wakeJails).toStrictEqual([
    { jail: { uid: 30_001, gid: 30_001 }, files: [ctx.paths.disk, ctx.paths.vmstate] },
  ]);
});

test('#buildStubVmm pauses the VM while its snapshot is taken', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });
  const seen: { state: string | undefined; isAlive: boolean }[] = [];

  ctx.fake.setPace(() => {
    seen.push({ state: ctx.fake.readState(pid), isAlive: ctx.runner.isVmAlive(pid, ctx.paths) });

    return Promise.resolve();
  });

  await ctx.runner.sleepVm(pid, ctx.paths, null, ctx.paths);

  expect(seen).toStrictEqual([{ state: 'Paused', isAlive: true }]);
});

test('#buildStubVmm writes the snapshot by rename and frees the VM on a sleep', async () => {
  const ctx = await setupTest();

  const vm = await ctx.runner.wakeVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    cgroup: null,
    jail: null,
    readOnlyFiles: ['/images/system.ext4'],
  });

  const result = await ctx.runner.sleepVm(vm.pid, ctx.paths, null, ctx.paths);

  expect(result).toStrictEqual({});
  expect(readdirSync(ctx.paths.snapshotDir)).toIncludeSameMembers(['vmstate', 'mem']);
  expect(readFileSync(ctx.paths.vmstate, 'utf8')).toBe('vmstate');
  expect(readFileSync(ctx.paths.memFile, 'utf8')).toBe('mem');
  expect(ctx.runner.isVmAlive(vm.pid, ctx.paths)).toBeFalse();
  expect(ctx.fake.readState(vm.pid)).toBe('Paused');
  expect(ctx.fake.usedSnapshots).toBeEmpty();
});

test('#buildStubVmm writes the snapshot into the target a sleep names', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });
  const target = buildSnapshotPaths(join(ctx.dir, 'watchdog'));

  await ctx.runner.sleepVm(pid, ctx.paths, null, target);

  expect(readdirSync(target.snapshotDir)).toIncludeSameMembers(['vmstate', 'mem']);
  expect(existsSync(ctx.paths.snapshotDir)).toBeFalse();
});

test('#buildStubVmm resumes the VM and writes no snapshot when a sleep fails', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });

  ctx.fake.queue('sleep', 'fail');

  await expect(ctx.runner.sleepVm(pid, ctx.paths, null, ctx.paths)).toReject();

  expect(ctx.fake.readState(pid)).toBe('Running');
  expect(ctx.runner.isVmAlive(pid, ctx.paths)).toBeTrue();
  expect(existsSync(ctx.paths.snapshotDir)).toBeFalse();
});

test('#buildStubVmm rejects a failed sleep with a fake error', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });

  ctx.fake.queue('sleep', 'fail');

  expect(ctx.runner.sleepVm(pid, ctx.paths, null, ctx.paths)).rejects.toThrowWithMessage(
    StubVmError,
    'snapshot failed',
  );
});

test('#buildStubVmm kills the VM and writes no snapshot when a sleep dies', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });

  ctx.fake.queue('sleep', 'die');

  await expect(ctx.runner.sleepVm(pid, ctx.paths, null, ctx.paths)).toReject();

  expect(ctx.runner.isVmAlive(pid, ctx.paths)).toBeFalse();
  expect(existsSync(ctx.paths.snapshotDir)).toBeFalse();
});

test('#buildStubVmm records a stop and frees the VM', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });

  await ctx.runner.stopVm(pid, ctx.paths, true);

  expect(ctx.fake.stops).toStrictEqual([{ pid, graceful: true }]);
  expect(ctx.runner.isVmAlive(pid, ctx.paths)).toBeFalse();
});

test.each(['fail', 'die'] as const)(
  '#buildStubVmm keeps the VM alive when a stop takes outcome %s',
  async (outcome) => {
    const ctx = await setupTest();

    const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });

    ctx.fake.queue('stop', outcome);

    await expect(ctx.runner.stopVm(pid, ctx.paths, false)).toReject();

    expect(ctx.runner.isVmAlive(pid, ctx.paths)).toBeTrue();
    expect(ctx.fake.stops).toStrictEqual([]);
  },
);

test('#buildStubVmm rejects a failed stop as a VM that survived SIGKILL', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });

  ctx.fake.queue('stop', 'fail');

  expect(ctx.runner.stopVm(pid, ctx.paths, false)).rejects.toThrowWithMessage(
    StubVmError,
    /survived SIGKILL/,
  );
});

test('#buildStubVmm stops a VM that already exited even when the stop fails', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('stop', 'fail');

  await ctx.runner.stopVm(4242, ctx.paths, false);

  expect(ctx.fake.stops).toStrictEqual([{ pid: 4242, graceful: false }]);
});

test('#buildStubVmm records a grow of the disk', async () => {
  const ctx = await setupTest();

  await ctx.runner.growDrive(ctx.paths, 4_294_967_296);

  expect(ctx.fake.grows).toStrictEqual([{ disk: ctx.paths.disk, diskBytes: 4_294_967_296 }]);
});

test('#buildStubVmm rejects a failed grow with a fake error', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('grow', 'fail');

  expect(ctx.runner.growDrive(ctx.paths, 4_294_967_296)).rejects.toThrowWithMessage(
    StubVmError,
    'grow failed',
  );
});

test('#buildStubVmm rejects a grow that dies as an agent from before grow', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('grow', 'die');

  expect(ctx.runner.growDrive(ctx.paths, 4_294_967_296)).rejects.toThrowWithMessage(
    AgentError,
    /no online disk grow/,
  );
});

test('#buildStubVmm reports the agent ready by default', async () => {
  const ctx = await setupTest();
  const isReady = await ctx.runner.isAgentReady(ctx.paths);

  expect(isReady).toBeTrue();
});

test('#buildStubVmm reports the agent not ready when the step fails', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('agentReady', 'fail');

  const isReady = await ctx.runner.isAgentReady(ctx.paths);

  expect(isReady).toBeFalse();
});

test('#buildStubVmm finishes a wake with the agent version and the socket boot id', async () => {
  const ctx = await setupTest();

  const booted = await ctx.runner.startVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    paths: ctx.paths,
    address: deriveSlotAddress(1, { subnet: parseSubnet('10.100.0.0/16'), portBase: 20_000 }),
    impId: 'imp-1',
    hostname: 'alpha',
    vcpus: 1,
    memoryMib: 512,
    maxMemoryMib: 512,
    dns: ['1.1.1.1'],
    cgroup: null,
    isIdentityReset: false,
    jail: null,
  });

  const finished = await ctx.runner.finishWake(ctx.paths);

  expect(finished).toStrictEqual({
    agentVersion: '0.1.0',
    firecrackerVersion: 'v1.17.0',
    bootId: buildStubBootId(booted.pid),
  });
});

test('#buildStubVmm rejects finishing a wake when the agent step fails', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('agentReady', 'fail');

  expect(ctx.runner.finishWake(ctx.paths)).rejects.toThrowWithMessage(
    StubVmError,
    /did not answer/,
  );
});

test('#buildStubVmm reports the guest uptime a test sets', async () => {
  const ctx = await setupTest();

  ctx.fake.setGuestUptime(1500);

  const uptimeMs = await ctx.runner.readGuestUptimeMs(ctx.paths);

  expect(uptimeMs).toBe(1500);
});

test('#buildStubVmm reports a guest old enough to sleep by default', async () => {
  const ctx = await setupTest();
  const uptimeMs = await ctx.runner.readGuestUptimeMs(ctx.paths);

  expect(uptimeMs).toBe(60_000);
});

test('#buildStubVmm reports the state of the VM serving the socket', async () => {
  const ctx = await setupTest();

  ctx.fake.spawnOrphan({ paths: ctx.paths, state: 'Paused' });

  const state = await ctx.runner.readVmState(ctx.paths);

  expect(state).toBe('Paused');
});

test('#buildStubVmm answers the state from the newest live VM on the socket', async () => {
  const ctx = await setupTest();

  ctx.fake.spawnOrphan({ paths: ctx.paths, state: 'Paused' });
  ctx.fake.spawnOrphan({ paths: ctx.paths, state: 'Running' });

  const state = await ctx.runner.readVmState(ctx.paths);

  expect(state).toBe('Running');
});

test('#buildStubVmm reports no state when no VM serves the socket', async () => {
  const ctx = await setupTest();
  const state = await ctx.runner.readVmState(ctx.paths);

  expect(state).toBeNull();
});

test('#buildStubVmm reports no state when the state step fails', async () => {
  const ctx = await setupTest();

  ctx.fake.spawnOrphan({ paths: ctx.paths });
  ctx.fake.queue('vmState', 'fail');

  const state = await ctx.runner.readVmState(ctx.paths);

  expect(state).toBeNull();
});

test('#buildStubVmm resumes the paused VM serving the socket', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths, state: 'Paused' });

  await ctx.runner.resumeVm(pid, ctx.paths);

  expect(ctx.fake.readState(pid)).toBe('Running');
});

test('#buildStubVmm takes queued outcomes in order then succeeds', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('agentReady', 'fail', 'ok');
  ctx.fake.queue('agentReady', 'fail');

  const results = [
    await ctx.runner.isAgentReady(ctx.paths),
    await ctx.runner.isAgentReady(ctx.paths),
    await ctx.runner.isAgentReady(ctx.paths),
    await ctx.runner.isAgentReady(ctx.paths),
  ];

  expect(results).toStrictEqual([false, true, false, true]);
});

test('#buildStubVmm succeeds after the queues are cleared', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('agentReady', 'fail');
  ctx.fake.clearQueues();

  const isReady = await ctx.runner.isAgentReady(ctx.paths);

  expect(isReady).toBeTrue();
});

test('#buildStubVmm keeps a held call pending once it reaches the hold', async () => {
  const ctx = await setupTest();

  const hold = ctx.fake.hold('agentReady');

  onTestFinished(() => {
    hold.release();
  });

  const call = ctx.runner.isAgentReady(ctx.paths);

  await hold.reached;

  expect(Bun.peek.status(call)).toBe('pending');
});

test('#buildStubVmm lets a held call through on release', async () => {
  const ctx = await setupTest();

  const hold = ctx.fake.hold('agentReady');
  const call = ctx.runner.isAgentReady(ctx.paths);

  await hold.reached;

  hold.release();

  expect(call).resolves.toBeTrue();
});

test('#buildStubVmm stops holding a step after release', async () => {
  const ctx = await setupTest();

  ctx.fake.hold('agentReady').release();

  const isReady = await ctx.runner.isAgentReady(ctx.paths);

  expect(isReady).toBeTrue();
});

test('#buildStubVmm keeps a hung call pending until the hangs are released', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('agentReady', 'hang');

  onTestFinished(() => {
    ctx.fake.releaseHangs();
  });

  const call = ctx.runner.isAgentReady(ctx.paths);

  await waitFor(() => {
    expect(ctx.fake.countHungCalls()).toBe(1);
  });

  expect(Bun.peek.status(call)).toBe('pending');
});

test('#buildStubVmm counts no hung call once the hangs are released', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('agentReady', 'hang');

  const call = ctx.runner.isAgentReady(ctx.paths);

  await waitFor(() => {
    expect(ctx.fake.countHungCalls()).toBe(1);
  });

  ctx.fake.releaseHangs();

  await call;

  expect(ctx.fake.countHungCalls()).toBe(0);
});

test('#buildStubVmm lets a hung call succeed when the hangs are released', async () => {
  const ctx = await setupTest();

  const paced = Promise.withResolvers<void>();

  ctx.fake.setPace(() => {
    paced.resolve();

    return Promise.resolve();
  });

  ctx.fake.queue('agentReady', 'hang');

  const call = ctx.runner.isAgentReady(ctx.paths);

  await paced.promise;

  ctx.fake.releaseHangs();

  expect(call).resolves.toBeTrue();
});

test('#buildStubVmm hangs a later call again after the hangs are released', async () => {
  const ctx = await setupTest();

  ctx.fake.releaseHangs();
  ctx.fake.queue('agentReady', 'hang');

  onTestFinished(() => {
    ctx.fake.releaseHangs();
  });

  const call = ctx.runner.isAgentReady(ctx.paths);

  await waitFor(() => {
    expect(ctx.fake.countHungCalls()).toBe(1);
  });

  expect(Bun.peek.status(call)).toBe('pending');
});

test('#buildStubVmm never settles a call of a runner whose impd was replaced', async () => {
  const ctx = await setupTest();

  ctx.fake.startGeneration();

  const call = ctx.runner.isAgentReady(ctx.paths);

  await waitFor(() => {
    expect(ctx.fake.countParkedCalls()).toBe(1);
  });

  expect(Bun.peek.status(call)).toBe('pending');
});

test('#buildStubVmm parks no call of the current runner', async () => {
  const ctx = await setupTest();

  await ctx.runner.isAgentReady(ctx.paths);

  expect(ctx.fake.countParkedCalls()).toBe(0);
});

test('#buildStubVmm never settles an in-flight call once its impd is replaced', async () => {
  const ctx = await setupTest();

  const hold = ctx.fake.hold('agentReady');
  const call = ctx.runner.isAgentReady(ctx.paths);

  await hold.reached;

  ctx.fake.startGeneration();
  hold.release();

  await waitFor(() => {
    expect(ctx.fake.countParkedCalls()).toBe(1);
  });

  expect(Bun.peek.status(call)).toBe('pending');
});

test('#buildStubVmm never settles an in-flight call that fails once its impd is replaced', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('grow', 'fail');

  const hold = ctx.fake.hold('grow');
  const call = ctx.runner.growDrive(ctx.paths, 1024);

  await hold.reached;

  ctx.fake.startGeneration();
  hold.release();

  await waitFor(() => {
    expect(ctx.fake.countParkedCalls()).toBe(1);
  });

  expect(Bun.peek.status(call)).toBe('pending');
});

test('#buildStubVmm never settles a jail sweep by a runner whose impd was replaced', async () => {
  const ctx = await setupTest();

  ctx.fake.startGeneration();

  const call = ctx.runner.removeOrphanJails(new Set());

  await waitFor(() => {
    expect(ctx.fake.countParkedCalls()).toBe(1);
  });

  expect(Bun.peek.status(call)).toBe('pending');
  expect(ctx.fake.sweeps).toStrictEqual([]);
});

test('#buildStubVmm throws on a VM listing by a runner whose impd was replaced', async () => {
  const ctx = await setupTest();

  ctx.fake.startGeneration();

  expect(() => ctx.runner.listVms()).toThrowWithMessage(Error, 'this impd was replaced');
});

test('#buildStubVmm throws on a liveness check by a runner whose impd was replaced', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });

  ctx.fake.startGeneration();

  expect(() => ctx.runner.isVmAlive(pid, ctx.paths)).toThrowWithMessage(
    Error,
    'this impd was replaced',
  );
});

test('#buildStubVmm shares live VMs with the runner of the next impd', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });
  const next = ctx.fake.startGeneration();

  expect(next.isVmAlive(pid, ctx.paths)).toBeTrue();
});

test('#buildStubVmm reports a guest no test set up as 512 MiB with nothing plugged', async () => {
  const ctx = await setupTest();
  const memory = await ctx.runner.readGuestMemory(ctx.paths);

  expect(memory).toStrictEqual({
    pluggedMib: 0,
    requestedMib: 0,
    totalMib: 512,
    availableMib: 412,
  });
});

test('#buildStubVmm plugs the memory a request asks for', async () => {
  const ctx = await setupTest();

  await ctx.runner.requestPluggedMib(ctx.paths, 256);

  const memory = await ctx.runner.readGuestMemory(ctx.paths);

  expect(memory).toStrictEqual({
    pluggedMib: 256,
    requestedMib: 256,
    totalMib: 768,
    availableMib: 668,
  });
});

test.each([
  [0, 128],
  [64, 128],
  [200, 200],
])(
  '#buildStubVmm unplugs a request for %d MiB to %d MiB above a 128 MiB floor',
  async (requestedMib, pluggedMib) => {
    const ctx = await setupTest();

    ctx.fake.guestMemory.set(ctx.paths.dir, {
      baseMib: 512,
      pluggedMib: 256,
      requestedMib: 256,
      usedMib: 100,
      unplugFloorMib: 128,
    });

    await ctx.runner.requestPluggedMib(ctx.paths, requestedMib);

    expect(ctx.fake.guestMemory.get(ctx.paths.dir)).toStrictEqual({
      baseMib: 512,
      pluggedMib,
      requestedMib,
      usedMib: 100,
      unplugFloorMib: 128,
    });
  },
);

test('#buildStubVmm never plugs memory up to the unplug floor', async () => {
  const ctx = await setupTest();

  ctx.fake.guestMemory.set(ctx.paths.dir, {
    baseMib: 512,
    pluggedMib: 64,
    requestedMib: 64,
    usedMib: 100,
    unplugFloorMib: 128,
  });

  await ctx.runner.requestPluggedMib(ctx.paths, 0);

  expect(ctx.fake.guestMemory.get(ctx.paths.dir)?.pluggedMib).toBe(64);
});

test('#buildStubVmm spawns an orphan that serves the imp socket with a pid file', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths, owner: { uid: 30_001, cgroup: null } });

  expect(ctx.runner.listVms()).toStrictEqual([
    { pid, apiSocket: ctx.paths.apiSocket, owner: { uid: 30_001, cgroup: null } },
  ]);

  expect(ctx.runner.readPid(ctx.paths)).toBe(pid);
  expect(ctx.fake.readState(pid)).toBe('Running');
});

test('#buildStubVmm spawns an orphan without a pid file when its start died first', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths, pidFile: false });

  expect(ctx.runner.isVmAlive(pid, ctx.paths)).toBeTrue();
  expect(ctx.runner.readPid(ctx.paths)).toBeNull();
});

test('#buildStubVmm spawns a live process that serves no socket without paths', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan();

  expect(ctx.runner.isVmAlive(pid, ctx.paths)).toBeTrue();
  expect(ctx.runner.listVms()).toStrictEqual([]);
  expect(ctx.fake.readState(pid)).toBeUndefined();
});

test('#buildStubVmm reports the owner a test sets for a VM', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: ctx.paths });

  ctx.fake.setOwner(pid, { uid: 30_002, cgroup: '/imps/imp-2' });

  expect(ctx.runner.readVmOwner(pid)).toStrictEqual({ uid: 30_002, cgroup: '/imps/imp-2' });
});

test('#buildStubVmm reports impd itself as the owner of an unknown pid', async () => {
  const ctx = await setupTest();

  const owner = ctx.runner.readVmOwner(4242);

  expect(owner).toStrictEqual({ uid: process.getuid?.() ?? 0, cgroup: null });
});

test('#buildStubVmm lists only the live VMs', async () => {
  const ctx = await setupTest();

  const stopped = ctx.fake.spawnOrphan({ paths: ctx.paths });
  const other = buildImpPaths(ctx.dir, 'imp-2');
  const live = ctx.fake.spawnOrphan({ paths: other, owner: { uid: 30_002, cgroup: null } });

  await ctx.runner.stopVm(stopped, ctx.paths, false);

  expect(ctx.runner.listVms()).toStrictEqual([
    { pid: live, apiSocket: other.apiSocket, owner: { uid: 30_002, cgroup: null } },
  ]);
});

test('#buildStubVmm records a jail sweep that finds no orphan jails', async () => {
  const ctx = await setupTest();
  const removed = await ctx.runner.removeOrphanJails(new Set(['imp-1']));

  expect(removed).toStrictEqual([]);
  expect(ctx.fake.sweeps).toStrictEqual(['jails']);
});

test('#buildStubVmm writes the snapshot files on a template build', async () => {
  const ctx = await setupTest();

  const snapshot = buildSnapshotPaths(join(ctx.dir, 'templates', 'shape-1'));

  await ctx.runner.buildTemplateVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    bootArgs: 'console=ttyS0',
    vcpus: 2,
    memoryMib: 1024,
    workDir: join(ctx.dir, 'build'),
    paths: {
      runDir: join(ctx.dir, 'build', 'run'),
      apiSocket: join(ctx.dir, 'build', 'run', 'api.sock'),
      vsockSocket: join(ctx.dir, 'build', 'run', 'vsock.sock'),
      logFile: join(ctx.dir, 'build', 'run', 'firecracker.log'),
      pidFile: join(ctx.dir, 'build', 'run', 'pid'),
    },
    placeholderPath: join(ctx.dir, 'build', 'placeholder.ext4'),
    tap: 'imptpl0',
    guestMac: '06:00:0a:64:00:02',
    jailId: 'template-1',
    jail: null,
    cgroup: null,
    minGuestUptimeMs: 0,
    snapshotDir: snapshot.snapshotDir,
    vmstate: snapshot.vmstate,
    memFile: snapshot.memFile,
  });

  expect(readFileSync(snapshot.vmstate, 'utf8')).toBe('vmstate');
  expect(readFileSync(snapshot.memFile, 'utf8')).toBe('mem');
  expect(ctx.fake.templateBuilds).toStrictEqual([{ vcpus: 2, memoryMib: 1024 }]);
});

test('#buildStubVmm rejects a failed template build with a fake error', async () => {
  const ctx = await setupTest();

  const snapshot = buildSnapshotPaths(join(ctx.dir, 'templates', 'shape-1'));

  ctx.fake.queue('template', 'fail');

  expect(
    ctx.runner.buildTemplateVm({
      firecrackerBin: '/usr/bin/firecracker',
      kernelPath: '/images/vmlinux',
      systemDrivePath: '/images/system.ext4',
      bootArgs: 'console=ttyS0',
      vcpus: 2,
      memoryMib: 1024,
      workDir: join(ctx.dir, 'build'),
      paths: {
        runDir: join(ctx.dir, 'build', 'run'),
        apiSocket: join(ctx.dir, 'build', 'run', 'api.sock'),
        vsockSocket: join(ctx.dir, 'build', 'run', 'vsock.sock'),
        logFile: join(ctx.dir, 'build', 'run', 'firecracker.log'),
        pidFile: join(ctx.dir, 'build', 'run', 'pid'),
      },
      placeholderPath: join(ctx.dir, 'build', 'placeholder.ext4'),
      tap: 'imptpl0',
      guestMac: '06:00:0a:64:00:02',
      jailId: 'template-1',
      jail: null,
      cgroup: null,
      minGuestUptimeMs: 0,
      snapshotDir: snapshot.snapshotDir,
      vmstate: snapshot.vmstate,
      memFile: snapshot.memFile,
    }),
  ).rejects.toThrowWithMessage(StubVmError, 'template build failed');
});

test('#buildStubVmm writes no snapshot when a template build fails', async () => {
  const ctx = await setupTest();

  const snapshot = buildSnapshotPaths(join(ctx.dir, 'templates', 'shape-1'));

  ctx.fake.queue('template', 'fail');

  await expect(
    ctx.runner.buildTemplateVm({
      firecrackerBin: '/usr/bin/firecracker',
      kernelPath: '/images/vmlinux',
      systemDrivePath: '/images/system.ext4',
      bootArgs: 'console=ttyS0',
      vcpus: 2,
      memoryMib: 1024,
      workDir: join(ctx.dir, 'build'),
      paths: {
        runDir: join(ctx.dir, 'build', 'run'),
        apiSocket: join(ctx.dir, 'build', 'run', 'api.sock'),
        vsockSocket: join(ctx.dir, 'build', 'run', 'vsock.sock'),
        logFile: join(ctx.dir, 'build', 'run', 'firecracker.log'),
        pidFile: join(ctx.dir, 'build', 'run', 'pid'),
      },
      placeholderPath: join(ctx.dir, 'build', 'placeholder.ext4'),
      tap: 'imptpl0',
      guestMac: '06:00:0a:64:00:02',
      jailId: 'template-1',
      jail: null,
      cgroup: null,
      minGuestUptimeMs: 0,
      snapshotDir: snapshot.snapshotDir,
      vmstate: snapshot.vmstate,
      memFile: snapshot.memFile,
    }),
  ).toReject();

  expect(existsSync(snapshot.snapshotDir)).toBeFalse();
});

test('#buildStubVmm settles the parked-build signal once a template build of a replaced runner parks', async () => {
  const ctx = await setupTest();

  const snapshot = buildSnapshotPaths(join(ctx.dir, 'templates', 'shape-1'));
  const hold = ctx.fake.hold('template');

  void ctx.runner.buildTemplateVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    bootArgs: 'console=ttyS0',
    vcpus: 2,
    memoryMib: 1024,
    workDir: join(ctx.dir, 'build'),
    paths: {
      runDir: join(ctx.dir, 'build', 'run'),
      apiSocket: join(ctx.dir, 'build', 'run', 'api.sock'),
      vsockSocket: join(ctx.dir, 'build', 'run', 'vsock.sock'),
      logFile: join(ctx.dir, 'build', 'run', 'firecracker.log'),
      pidFile: join(ctx.dir, 'build', 'run', 'pid'),
    },
    placeholderPath: join(ctx.dir, 'build', 'placeholder.ext4'),
    tap: 'imptpl0',
    guestMac: '06:00:0a:64:00:02',
    jailId: 'template-1',
    jail: null,
    cgroup: null,
    minGuestUptimeMs: 0,
    snapshotDir: snapshot.snapshotDir,
    vmstate: snapshot.vmstate,
    memFile: snapshot.memFile,
  });

  await hold.reached;

  ctx.fake.startGeneration();
  hold.release();

  await expect(ctx.fake.whenTemplateBuildParks(ctx.runner)).toResolve();
});

test('#buildStubVmm leaves the parked-build signal pending for a template build that got past its VM call', async () => {
  const ctx = await setupTest();

  const snapshot = buildSnapshotPaths(join(ctx.dir, 'templates', 'shape-1'));

  await ctx.runner.buildTemplateVm({
    firecrackerBin: '/usr/bin/firecracker',
    kernelPath: '/images/vmlinux',
    systemDrivePath: '/images/system.ext4',
    bootArgs: 'console=ttyS0',
    vcpus: 2,
    memoryMib: 1024,
    workDir: join(ctx.dir, 'build'),
    paths: {
      runDir: join(ctx.dir, 'build', 'run'),
      apiSocket: join(ctx.dir, 'build', 'run', 'api.sock'),
      vsockSocket: join(ctx.dir, 'build', 'run', 'vsock.sock'),
      logFile: join(ctx.dir, 'build', 'run', 'firecracker.log'),
      pidFile: join(ctx.dir, 'build', 'run', 'pid'),
    },
    placeholderPath: join(ctx.dir, 'build', 'placeholder.ext4'),
    tap: 'imptpl0',
    guestMac: '06:00:0a:64:00:02',
    jailId: 'template-1',
    jail: null,
    cgroup: null,
    minGuestUptimeMs: 0,
    snapshotDir: snapshot.snapshotDir,
    vmstate: snapshot.vmstate,
    memFile: snapshot.memFile,
  });

  ctx.fake.startGeneration();

  // a call other than a template build parks, and settles nothing
  void ctx.runner.isAgentReady(ctx.paths);

  await waitFor(() => {
    expect(ctx.fake.countParkedCalls()).toBe(1);
  });

  expect(Bun.peek.status(ctx.fake.whenTemplateBuildParks(ctx.runner))).toBe('pending');
});

test('#buildStubVmm rejects the parked-build signal of a runner from another fake', () => {
  const runner = buildStubVmm().startGeneration();

  expect(buildStubVmm().whenTemplateBuildParks(runner)).rejects.toThrowWithMessage(
    Error,
    'not a runner of this fake',
  );
});

test('#buildStubVmm starts a running VM and records the claim on a template restore', async () => {
  const ctx = await setupTest();

  const plan = {
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    vmstate: '/templates/shape-1/vmstate',
    memFile: '/templates/shape-1/mem',
    systemDrivePath: '/images/system.ext4',
    placeholderPath: '/templates/shape-1/placeholder.ext4',
    diskPath: ctx.paths.disk,
    tap: 'imp1',
    cgroup: null,
    jail: null,
    diskReady: Promise.resolve(4_294_967_296),
    claim: {
      id: 'imp-1',
      hostname: 'alpha',
      ip: '10.100.0.2',
      gw: '10.100.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: '06:00:0a:64:00:02',
      seed: new Uint8Array(32),
      isIdentityReset: false,
    },
  };

  const vm = await ctx.runner.loadTemplateVm(plan);

  expect(vm).toStrictEqual({
    pid: 1001,
    firecrackerVersion: 'v1.17.0',
    agentVersion: '0.1.0',
    timings: {},
  });

  expect(ctx.runner.isVmAlive(1001, ctx.paths)).toBeTrue();

  expect(ctx.fake.restores).toStrictEqual([
    { hostname: 'alpha', isIdentityReset: false, memFile: '/templates/shape-1/mem' },
  ]);

  expect(ctx.fake.restorePlans).toStrictEqual([plan]);
});

test('#buildStubVmm reports the identity reset on a template restore whose claim asks for one', async () => {
  const ctx = await setupTest();

  const vm = await ctx.runner.loadTemplateVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    vmstate: '/templates/shape-1/vmstate',
    memFile: '/templates/shape-1/mem',
    systemDrivePath: '/images/system.ext4',
    placeholderPath: '/templates/shape-1/placeholder.ext4',
    diskPath: ctx.paths.disk,
    tap: 'imp1',
    cgroup: null,
    jail: null,
    diskReady: Promise.resolve(4_294_967_296),
    claim: {
      id: 'imp-1',
      hostname: 'alpha',
      ip: '10.100.0.2',
      gw: '10.100.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: '06:00:0a:64:00:02',
      seed: new Uint8Array(32),
      isIdentityReset: true,
    },
  });

  expect(vm.identityReset).toBe('ok');
});

test('#buildStubVmm rejects a failed template restore as the template fault', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('restore', 'fail');

  const restoring = ctx.runner.loadTemplateVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    vmstate: '/templates/shape-1/vmstate',
    memFile: '/templates/shape-1/mem',
    systemDrivePath: '/images/system.ext4',
    placeholderPath: '/templates/shape-1/placeholder.ext4',
    diskPath: ctx.paths.disk,
    tap: 'imp1',
    cgroup: null,
    jail: null,
    diskReady: Promise.resolve(4_294_967_296),
    claim: {
      id: 'imp-1',
      hostname: 'alpha',
      ip: '10.100.0.2',
      gw: '10.100.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: '06:00:0a:64:00:02',
      seed: new Uint8Array(32),
      isIdentityReset: false,
    },
  });

  expect(restoring).rejects.toThrowWithMessage(TemplateRestoreError, 'restore failed');

  expect(restoring).rejects.toMatchObject({
    isTemplateFault: true,
    cause: expect.toSatisfy((cause: unknown) => cause instanceof StubVmError),
  });
});

test('#buildStubVmm rejects a disk failure on a template restore as the imp fault', async () => {
  const ctx = await setupTest();

  const disk = Promise.withResolvers<number>();

  disk.reject(new Error('clone failed'));

  const restoring = ctx.runner.loadTemplateVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    vmstate: '/templates/shape-1/vmstate',
    memFile: '/templates/shape-1/mem',
    systemDrivePath: '/images/system.ext4',
    placeholderPath: '/templates/shape-1/placeholder.ext4',
    diskPath: ctx.paths.disk,
    tap: 'imp1',
    cgroup: null,
    jail: null,
    diskReady: disk.promise,
    claim: {
      id: 'imp-1',
      hostname: 'alpha',
      ip: '10.100.0.2',
      gw: '10.100.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: '06:00:0a:64:00:02',
      seed: new Uint8Array(32),
      isIdentityReset: false,
    },
  });

  expect(restoring).rejects.toThrowWithMessage(TemplateRestoreError, 'disk failed');
  expect(restoring).rejects.toMatchObject({ isTemplateFault: false });
});

test('#buildStubVmm ends the VM when the disk fails on a template restore', async () => {
  const ctx = await setupTest();

  const disk = Promise.withResolvers<number>();

  disk.reject(new Error('clone failed'));

  const restoring = ctx.runner.loadTemplateVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    vmstate: '/templates/shape-1/vmstate',
    memFile: '/templates/shape-1/mem',
    systemDrivePath: '/images/system.ext4',
    placeholderPath: '/templates/shape-1/placeholder.ext4',
    diskPath: ctx.paths.disk,
    tap: 'imp1',
    cgroup: null,
    jail: null,
    diskReady: disk.promise,
    claim: {
      id: 'imp-1',
      hostname: 'alpha',
      ip: '10.100.0.2',
      gw: '10.100.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: '06:00:0a:64:00:02',
      seed: new Uint8Array(32),
      isIdentityReset: false,
    },
  });

  await expect(restoring).toReject();

  expect(ctx.fake.alive).toBeEmpty();
});

test('#buildStubVmm rejects a failed claim on a template restore as the imp fault', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('claim', 'fail');

  const restoring = ctx.runner.loadTemplateVm({
    firecrackerBin: '/usr/bin/firecracker',
    paths: ctx.paths,
    vmstate: '/templates/shape-1/vmstate',
    memFile: '/templates/shape-1/mem',
    systemDrivePath: '/images/system.ext4',
    placeholderPath: '/templates/shape-1/placeholder.ext4',
    diskPath: ctx.paths.disk,
    tap: 'imp1',
    cgroup: null,
    jail: null,
    diskReady: Promise.resolve(4_294_967_296),
    claim: {
      id: 'imp-1',
      hostname: 'alpha',
      ip: '10.100.0.2',
      gw: '10.100.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: '06:00:0a:64:00:02',
      seed: new Uint8Array(32),
      isIdentityReset: false,
    },
  });

  expect(restoring).rejects.toThrowWithMessage(TemplateRestoreError, 'claim failed');
  expect(restoring).rejects.toMatchObject({ isTemplateFault: false });
});

test('#buildStubVmm ends the VM and records no restore when the claim fails on a template restore', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('claim', 'fail');

  await expect(
    ctx.runner.loadTemplateVm({
      firecrackerBin: '/usr/bin/firecracker',
      paths: ctx.paths,
      vmstate: '/templates/shape-1/vmstate',
      memFile: '/templates/shape-1/mem',
      systemDrivePath: '/images/system.ext4',
      placeholderPath: '/templates/shape-1/placeholder.ext4',
      diskPath: ctx.paths.disk,
      tap: 'imp1',
      cgroup: null,
      jail: null,
      diskReady: Promise.resolve(4_294_967_296),
      claim: {
        id: 'imp-1',
        hostname: 'alpha',
        ip: '10.100.0.2',
        gw: '10.100.0.1',
        ip6: null,
        gw6: null,
        dns: ['1.1.1.1'],
        mac: '06:00:0a:64:00:02',
        seed: new Uint8Array(32),
        isIdentityReset: false,
      },
    }),
  ).toReject();

  expect(ctx.fake.alive).toBeEmpty();
  expect(ctx.fake.restores).toStrictEqual([]);
});
