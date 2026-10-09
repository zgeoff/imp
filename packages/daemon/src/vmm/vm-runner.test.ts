import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_TYPES, encodeJsonFrame } from '../agent-client/frame-codec';
import { deriveSlotAddress, parseSubnet } from '../net/addressing';
import { parsePrefix64 } from '../net/addressing6';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubJails } from '../test-utils/build-stub-jails';
import { createStubKsmExec } from '../test-utils/create-stub-ksm-exec';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { startStubFirecracker } from '../test-utils/start-stub-firecracker';
import { isFirecrackerAlive, stopProcess } from './firecracker-process';
import { buildJailerCommand } from './jail';
import { buildBootArgs, createVmRunner } from './vm-runner';

// A temp dir with the run/ and the disk of imp `vm`, which a sleep needs for
// its snapshot's owner, and the log the stub VMM appends its calls to.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const paths = buildImpPaths(dir, 'vm');

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.disk, '');

  return { dir, paths, logPath: join(dir, 'calls.log') };
}

test('#buildBootArgs builds the kernel cmdline with the slot addressing', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1', '8.8.8.8'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).toBe(
    'console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd root=/dev/vdb rootfstype=squashfs ro init=/imp-agent imp.id=id imp.hostname=dev imp.ip=10.66.0.14/30 imp.gw=10.66.0.13 imp.dns=1.1.1.1,8.8.8.8',
  );
});

test('#buildBootArgs asks for no identity reset on a later boot', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).not.toInclude('imp.reset_identity');
});

test('#buildBootArgs asks for an identity reset on the first boot of a template copy', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: true,
      jail: null,
    }),
  ).toEndWith(' imp.dns=1.1.1.1 imp.reset_identity=1');
});

test('#buildBootArgs names the /128 and the gateway fe80::1 with IPv6', () => {
  const prefix6 = parsePrefix64('fd12:3456:789a::/64');
  const subnet = parseSubnet('10.66.0.0/16');
  const address = deriveSlotAddress(3, { subnet, portBase: 20_000, prefix6 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 1024,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).toEndWith(
    ' imp.ip=10.66.0.14/30 imp.gw=10.66.0.13 imp.ip6=fd12:3456:789a::a42:e/128 imp.gw6=fe80::1 imp.dns=1.1.1.1',
  );
});

test('#buildBootArgs onlines hot-plugged memory movable for an elastic imp', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 256,
      maxMemoryMib: 1024,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).toEndWith(' imp.dns=1.1.1.1 memhp_default_state=online_movable');
});

test('#buildBootArgs leaves hot-plugged memory alone for an imp that does not grow', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  expect(
    buildBootArgs({
      firecrackerBin: 'firecracker',
      kernelPath: '/k',
      systemDrivePath: '/s',
      paths: buildImpPaths('/var/lib/imp', 'id'),
      address,
      impId: 'id',
      hostname: 'dev',
      vcpus: 2,
      memoryMib: 256,
      maxMemoryMib: 256,
      dns: ['1.1.1.1'],
      cgroup: null,
      isIdentityReset: false,
      jail: null,
    }),
  ).not.toInclude('memhp_default_state');
});

test('#sleepVm resumes a VM whose pause fails and leaves it running, its limit back', async () => {
  const ctx = setupTest();

  const vm = await startStubFirecracker({
    apiSocket: ctx.paths.apiSocket,
    logPath: ctx.logPath,
    failures: ['PATCH /vm {"state":"Paused"}'],
    isLoggingBodies: true,
  });

  const limits: string[] = [];

  const cgroup = {
    procsPath: '/nonexistent',
    liftLimit: () => {
      limits.push('lifted');
    },
    applyLimit: () => {
      limits.push('applied');
    },
  };

  const sleeping = createVmRunner(buildStubJails().jails).sleepVm(
    vm.pid,
    ctx.paths,
    cgroup,
    ctx.paths,
  );

  expect(sleeping).rejects.toThrow('refused PATCH /vm');

  expect(readFileSync(ctx.logPath, 'utf8').trim().split('\n')).toStrictEqual([
    'PATCH /vm {"state":"Paused"}',
    'PATCH /vm {"state":"Resumed"}',
  ]);

  expect(limits).toStrictEqual(['lifted', 'applied']);
  expect(isFirecrackerAlive(vm.pid, ctx.paths.apiSocket)).toBeTrue();
});

test('#sleepVm kills a VM whose pause and resume both fail', async () => {
  const ctx = setupTest();

  const vm = await startStubFirecracker({
    apiSocket: ctx.paths.apiSocket,
    logPath: ctx.logPath,
    failures: ['PATCH /vm'],
  });

  expect(
    createVmRunner(buildStubJails().jails).sleepVm(vm.pid, ctx.paths, null, ctx.paths),
  ).rejects.toThrow('refused PATCH /vm');

  expect(isFirecrackerAlive(vm.pid, ctx.paths.apiSocket)).toBeFalse();
});

// the ping's own deadline is 250 ms, far below a ping's default of 2 s
test('#readGuestUptimeMs reads no uptime from a wedged agent within a short timeout', async () => {
  const ctx = setupTest();

  // accepts the connection and never answers
  await startStubAgent(ctx.paths.vsockSocket, () => {});

  const started = performance.now();

  const uptime = await createVmRunner(buildStubJails().jails).readGuestUptimeMs(ctx.paths);

  const elapsedMs = performance.now() - started;

  expect(uptime).toBeNull();
  expect(elapsedMs).toBeLessThan(1000);
});

test('#readGuestUptimeMs reads no uptime from an agent that cannot read its clock', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.paths.vsockSocket, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true, version: '0.1.0' }));
  });

  const uptime = await createVmRunner(buildStubJails().jails).readGuestUptimeMs(ctx.paths);

  expect(uptime).toBeNull();
});

test('#readVmState reads the VM state from the API', async () => {
  const ctx = setupTest();

  await startStubFirecracker({ apiSocket: ctx.paths.apiSocket, logPath: ctx.logPath });

  const state = await createVmRunner(buildStubJails().jails).readVmState(ctx.paths);

  expect(state).toBe('Running');
});

test('#readVmState reads no state once the API is gone', async () => {
  const ctx = setupTest();

  const vm = await startStubFirecracker({ apiSocket: ctx.paths.apiSocket, logPath: ctx.logPath });

  stopProcess(vm.pid);

  await vm.exited;

  const state = await createVmRunner(buildStubJails().jails).readVmState(ctx.paths);

  expect(state).toBeNull();
});

test('#resumeVm seals the run dir, then patches the VM to resumed', async () => {
  const ctx = setupTest();

  const vm = await startStubFirecracker({
    apiSocket: ctx.paths.apiSocket,
    logPath: ctx.logPath,
    isLoggingBodies: true,
  });

  const stub = buildStubJails();

  await createVmRunner(stub.jails).resumeVm(vm.pid, ctx.paths);

  expect(stub.notes).toStrictEqual(['seal']);
  expect(readFileSync(ctx.logPath, 'utf8')).toBe('PATCH /vm {"state":"Resumed"}\n');
});

test('#resumeVm kills a VM whose seal finds anything planted in run/, and never resumes it', async () => {
  const ctx = setupTest();

  const vm = await startStubFirecracker({ apiSocket: ctx.paths.apiSocket, logPath: ctx.logPath });

  const stub = buildStubJails();

  stub.refuseSeal(
    new Error('jail vm: the VM left planted in run/; a VM that writes there is compromised'),
  );

  expect(createVmRunner(stub.jails).resumeVm(vm.pid, ctx.paths)).rejects.toThrow(
    'a VM that writes there is compromised',
  );

  expect(existsSync(ctx.logPath)).toBeFalse();
  expect(isFirecrackerAlive(vm.pid, ctx.paths.apiSocket)).toBeFalse();
  expect(stub.notes).toStrictEqual(['seal', 'release vm']);
});

test('#stopVm releases the jail on a hard stop, as a checkpoint restore asks', async () => {
  const ctx = setupTest();

  const vm = await startStubFirecracker({ apiSocket: ctx.paths.apiSocket, logPath: ctx.logPath });

  const stub = buildStubJails();

  await createVmRunner(stub.jails).stopVm(vm.pid, ctx.paths, false);

  expect(isFirecrackerAlive(vm.pid, ctx.paths.apiSocket)).toBeFalse();
  expect(stub.notes).toStrictEqual(['release vm']);
});

test('#wakeVm releases the mounts of a jail prepare that fails partway, and restores the limit', () => {
  const ctx = setupTest();
  const calls: string[] = [];

  const stub = buildStubJails({
    onNote: (note) => {
      calls.push(note);
    },
  });

  stub.refusePrepare(new Error('mount --rbind: no space'));

  expect(
    createVmRunner(stub.jails).wakeVm({
      firecrackerBin: 'firecracker',
      paths: ctx.paths,
      cgroup: {
        procsPath: '/nonexistent',
        liftLimit: () => {
          calls.push('lifted');
        },
        applyLimit: () => {
          calls.push('applied');
        },
      },
      jail: { uid: 900_000, gid: 900_000 },
      readOnlyFiles: [],
    }),
  ).rejects.toThrowWithMessage(Error, 'mount --rbind: no space');

  expect(calls).toStrictEqual([
    'lifted',
    'prepare vm late=false disk=true',
    'release vm',
    'applied',
  ]);
});

test('#wakeVm starts a jailed VM through the merge wrapper, which runs the jailer outside the chroot', () => {
  const ctx = setupTest();
  const wrapper = createStubKsmExec(ctx.dir);

  const command = buildJailerCommand({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: join(ctx.dir, 'jail'),
    impId: 'vm',
    user: { uid: 900_000, gid: 900_000 },
    apiSocket: ctx.paths.apiSocket,
  });

  expect(
    createVmRunner(buildStubJails({ argv: command }).jails, wrapper.path).wakeVm({
      firecrackerBin: 'firecracker',
      paths: ctx.paths,
      cgroup: null,
      jail: { uid: 900_000, gid: 900_000 },
      readOnlyFiles: [],
    }),
  ).rejects.toThrow('did not open its API socket');

  expect(wrapper.readArgv()).toStrictEqual([...command]);
});
