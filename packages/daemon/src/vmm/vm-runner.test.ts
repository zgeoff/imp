import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeAgent } from '../agent-client/fake-agent';
import { FRAME_TYPES, encodeJsonFrame } from '../agent-client/frame-codec';
import { deriveSlotAddress, parseSubnet } from '../net/addressing';
import { parsePrefix64 } from '../net/addressing6';
import { readErrorMessage } from '../read-error-message';
import { buildImpPaths } from '../storage/data-layout';
import { isFirecrackerAlive } from './firecracker-process';
import type { Jails } from './jail';
import { buildBootArgs, createVmRunner } from './vm-runner';

// a VM these tests start runs unjailed
const NO_JAILS: Jails = {
  prepare: () => Promise.reject(new Error('no jails here')),
  prepareBuild: () => Promise.reject(new Error('no jails here')),
  setupDiskOwner: () => {},
  release: () => Promise.resolve(),
  sweepRunDir: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  removeOrphans: () => Promise.resolve([]),
  seal: () => {},
};

function buildPlan(isIdentityReset: boolean) {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  return {
    firecrackerBin: 'firecracker',
    kernelPath: '/k',
    systemDrivePath: '/s',
    paths: buildImpPaths('/var/lib/imp', 'id'),
    address,
    impId: 'id',
    hostname: 'dev',
    vcpus: 2,
    memoryMib: 1024,
    dns: ['1.1.1.1', '8.8.8.8'],
    cgroup: null,
    isIdentityReset,
    jail: null,
  };
}

test('it builds the kernel cmdline with the slot addressing', () => {
  const args = buildBootArgs(buildPlan(false));

  expect(args).toContain('root=/dev/vdb rootfstype=squashfs ro init=/imp-agent');
  expect(args).toContain('reboot=k');

  expect(args).toEndWith(
    'imp.id=id imp.hostname=dev imp.ip=10.66.0.14/30 imp.gw=10.66.0.13 imp.dns=1.1.1.1,8.8.8.8',
  );
});

test('it asks for an identity reset only on the first boot of a template copy', () => {
  expect(buildBootArgs(buildPlan(false))).not.toContain('imp.reset_identity');
  expect(buildBootArgs(buildPlan(true))).toEndWith(' imp.reset_identity=1');
});

test('with IPv6, the cmdline names the /128 and the gateway fe80::1', () => {
  const address = deriveSlotAddress(3, {
    subnet: parseSubnet('10.66.0.0/16'),
    portBase: 20_000,
    prefix6: parsePrefix64('fd12:3456:789a::/64'),
  });

  const args = buildBootArgs({ ...buildPlan(false), address, dns: ['1.1.1.1'] });

  expect(args).toContain('imp.ip6=fd12:3456:789a::a42:e/128 imp.gw6=fe80::1 imp.dns=1.1.1.1');
});

// A Firecracker stand-in: a process whose command line names the API socket,
// as the liveness check expects, and an API that fails the pause.
async function setupFailingPause(resumeStatus: number) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-'));
  const paths = buildImpPaths(dir, 'vm');

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.disk, '');

  const calls: string[] = [];

  const server = Bun.serve({
    unix: paths.apiSocket,
    fetch: async (request) => {
      const body: unknown = await request.json();

      calls.push(`${request.method} ${new URL(request.url).pathname} ${JSON.stringify(body)}`);

      const paused = JSON.stringify(body).includes('Paused');

      return new Response('{}', { status: paused ? 500 : resumeStatus });
    },
  });

  const child = Bun.spawn(['bash', '-c', 'sleep 30; true', 'firecracker', paths.apiSocket]);

  // until bash has exec'd, its command line is empty and it looks dead; on a
  // loaded host that takes longer than the test
  const deadline = Date.now() + 10_000;

  while (!isFirecrackerAlive(child.pid, paths.apiSocket)) {
    if (Date.now() > deadline) {
      throw new Error('the stand-in never started');
    }

    await Bun.sleep(1);
  }

  return {
    paths,
    calls,
    child,
    async [Symbol.asyncDispose]() {
      child.kill('SIGKILL');

      await server.stop(true);

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a sleep whose pause fails resumes the VM and leaves it running, its limit back', async () => {
  await using vm = await setupFailingPause(204);

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

  const rejection = await createVmRunner(NO_JAILS)
    .sleepVm(vm.child.pid, vm.paths, cgroup, vm.paths)
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(vm.calls).toEqual(['PATCH /vm {"state":"Paused"}', 'PATCH /vm {"state":"Resumed"}']);
  expect(limits).toEqual(['lifted', 'applied']);
  expect(isFirecrackerAlive(vm.child.pid, vm.paths.apiSocket)).toBe(true);
});

test('a sleep whose pause and resume both fail kills the VM', async () => {
  await using vm = await setupFailingPause(500);

  const rejection = await createVmRunner(NO_JAILS)
    .sleepVm(vm.child.pid, vm.paths, null, vm.paths)
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(isFirecrackerAlive(vm.child.pid, vm.paths.apiSocket)).toBe(false);
});

test('a wedged agent gives no guest uptime within a short timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-'));
  const paths = buildImpPaths(dir, 'vm');

  mkdirSync(paths.runDir, { recursive: true });

  // accepts the connection and never answers
  const agent = await startFakeAgent(paths.vsockSocket, () => {});

  try {
    const started = performance.now();

    const uptime = await createVmRunner(NO_JAILS).readGuestUptimeMs(paths);

    expect(uptime).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  } finally {
    agent.close();

    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent that cannot read its clock gives no guest uptime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-'));
  const paths = buildImpPaths(dir, 'vm');

  mkdirSync(paths.runDir, { recursive: true });

  const agent = await startFakeAgent(paths.vsockSocket, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true, version: '0.1.0' }));
  });

  try {
    const uptime = await createVmRunner(NO_JAILS).readGuestUptimeMs(paths);

    expect(uptime).toBeNull();
  } finally {
    agent.close();

    rmSync(dir, { recursive: true, force: true });
  }
});

test('the VM state comes from GET /, and a resume patches the VM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-'));
  const paths = buildImpPaths(dir, 'vm');
  const calls: string[] = [];

  mkdirSync(paths.runDir, { recursive: true });

  const server = Bun.serve({
    unix: paths.apiSocket,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;

      calls.push(`${request.method} ${path} ${await request.text()}`);

      const body = path === '/' ? '{"id":"vm","state":"Paused"}' : '';

      return new Response(body, { status: 200 });
    },
  });

  try {
    const runner = createVmRunner(NO_JAILS);

    const state = await runner.readVmState(paths);

    await runner.resumeVm(process.pid, paths);
    await server.stop(true);

    const gone = await runner.readVmState(paths);

    expect([state, gone]).toEqual(['Paused', null]);
    expect(calls).toEqual(['GET / ', 'PATCH /vm {"state":"Resumed"}']);
  } finally {
    await server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  }
});

test('a resume whose seal finds anything planted in run/ kills the VM, never resumes it', async () => {
  await using vm = await setupFailingPause(204);

  const released: string[] = [];

  const jails: Jails = {
    ...NO_JAILS,
    seal: () => {
      throw new Error(
        'jail vm: the VM left planted in run/; a VM that writes there is compromised',
      );
    },
    release: (impId) => {
      released.push(impId);

      return Promise.resolve();
    },
  };

  const rejection = await createVmRunner(jails)
    .resumeVm(vm.child.pid, vm.paths)
    .catch((error: unknown) => error);

  expect(readErrorMessage(rejection)).toContain('compromised');
  expect(vm.calls).toEqual([]);
  expect(isFirecrackerAlive(vm.child.pid, vm.paths.apiSocket)).toBeFalse();
  expect(released).toEqual(['vm']);
});

test('a hard stop, as a checkpoint restore asks, still releases the jail', async () => {
  await using vm = await setupFailingPause(204);

  const released: string[] = [];

  const jails: Jails = {
    ...NO_JAILS,
    release: (impId) => {
      released.push(impId);

      return Promise.resolve();
    },
  };

  await createVmRunner(jails).stopVm(vm.child.pid, vm.paths, false);

  expect(isFirecrackerAlive(vm.child.pid, vm.paths.apiSocket)).toBeFalse();
  expect(released).toEqual(['vm']);
});

test('a jail prepare that fails partway releases its mounts and restores the limit', async () => {
  const calls: string[] = [];

  const jails: Jails = {
    ...NO_JAILS,
    prepare: () => Promise.reject(new Error('mount --rbind: no space')),
    release: (impId) => {
      calls.push(`release ${impId}`);

      return Promise.resolve();
    },
  };

  const cgroup = {
    procsPath: '/nonexistent',
    liftLimit: () => {
      calls.push('lifted');
    },
    applyLimit: () => {
      calls.push('applied');
    },
  };

  const rejection = await createVmRunner(jails)
    .wakeVm({
      firecrackerBin: 'firecracker',
      paths: buildImpPaths('/nonexistent', 'vm'),
      cgroup,
      jail: { uid: 900_000, gid: 900_000 },
      readOnlyFiles: [],
    })
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(calls).toEqual(['lifted', 'release vm', 'applied']);
});
