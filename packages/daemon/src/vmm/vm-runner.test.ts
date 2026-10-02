import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeAgent } from '../agent-client/fake-agent';
import { FRAME_TYPES, encodeJsonFrame } from '../agent-client/frame-codec';
import { deriveSlotAddress, parseSubnet } from '../net/addressing';
import { buildImpPaths } from '../storage/data-layout';
import { isFirecrackerAlive } from './firecracker-process';
import { buildBootArgs, createVmRunner } from './vm-runner';

test('it builds the kernel cmdline with the slot addressing', () => {
  const address = deriveSlotAddress(3, { subnet: parseSubnet('10.66.0.0/16'), portBase: 20_000 });

  const args = buildBootArgs({
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
  });

  expect(args).toContain('root=/dev/vdb rootfstype=squashfs ro init=/imp-agent');
  expect(args).toContain('reboot=k');

  expect(args).toEndWith(
    'imp.id=id imp.hostname=dev imp.ip=10.66.0.14/30 imp.gw=10.66.0.13 imp.dns=1.1.1.1,8.8.8.8',
  );
});

// A Firecracker stand-in: a process whose command line names the API socket,
// as the liveness check expects, and an API that fails the pause.
async function setupFailingPause(resumeStatus: number) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-'));
  const paths = buildImpPaths(dir, 'vm');

  mkdirSync(paths.runDir, { recursive: true });

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

  const rejection = await createVmRunner()
    .sleepVm(vm.child.pid, vm.paths, cgroup, vm.paths)
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(vm.calls).toEqual(['PATCH /vm {"state":"Paused"}', 'PATCH /vm {"state":"Resumed"}']);
  expect(limits).toEqual(['lifted', 'applied']);
  expect(isFirecrackerAlive(vm.child.pid, vm.paths.apiSocket)).toBe(true);
});

test('a sleep whose pause and resume both fail kills the VM', async () => {
  await using vm = await setupFailingPause(500);

  const rejection = await createVmRunner()
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

    const uptime = await createVmRunner().readGuestUptimeMs(paths);

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
    const uptime = await createVmRunner().readGuestUptimeMs(paths);

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
    const runner = createVmRunner();

    const state = await runner.readVmState(paths);

    await runner.resumeVm(paths);
    await server.stop(true);

    const gone = await runner.readVmState(paths);

    expect([state, gone]).toEqual(['Paused', null]);
    expect(calls).toEqual(['GET / ', 'PATCH /vm {"state":"Resumed"}']);
  } finally {
    await server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  }
});
