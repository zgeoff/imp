import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveSlotAddress, parseSubnet } from '../net/addressing';
import { buildImpPaths } from '../storage/data-layout';
import { isFirecrackerAlive } from './firecracker-process';
import { buildBootArgs, createVmRunner } from './vm-runner';

test('it builds the smoke-boot kernel cmdline with the slot addressing', () => {
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
  });

  expect(args).toContain('root=/dev/vdb rootfstype=squashfs ro init=/imp-agent');
  expect(args).toContain('reboot=k');

  expect(args).toEndWith(
    'imp.id=id imp.hostname=dev imp.ip=10.66.0.14/30 imp.gw=10.66.0.13 imp.dns=1.1.1.1,8.8.8.8',
  );
});

// A Firecracker stand-in: a process whose command line names the API socket,
// as the liveness check expects, and an API that fails the pause.
function setupFailingPause(resumeStatus: number) {
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

test('a sleep whose pause fails resumes the VM and leaves it running', async () => {
  await using vm = setupFailingPause(204);

  const rejection = await createVmRunner()
    .sleepVm(vm.child.pid, vm.paths)
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(vm.calls).toEqual(['PATCH /vm {"state":"Paused"}', 'PATCH /vm {"state":"Resumed"}']);
  expect(isFirecrackerAlive(vm.child.pid, vm.paths.apiSocket)).toBe(true);
});

test('a sleep whose pause and resume both fail kills the VM', async () => {
  await using vm = setupFailingPause(500);

  const rejection = await createVmRunner()
    .sleepVm(vm.child.pid, vm.paths)
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(isFirecrackerAlive(vm.child.pid, vm.paths.apiSocket)).toBe(false);
});
