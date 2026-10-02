import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFirecrackerClient } from './firecracker-client';

test('a call to a Firecracker that never answers fails after its timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));
  const socket = join(dir, 'api.sock');

  // accepts every request and never answers, like a wedged VMM
  const server = Bun.serve({
    unix: socket,
    fetch: () => new Promise<Response>(() => {}),
  });

  try {
    const client = createFirecrackerClient(socket, { requestMs: 50, snapshotMs: 100 });

    const paused = await client.pause().catch((error: unknown) => error);

    const snapshot = await client
      .createSnapshot({ snapshotPath: 'a', memFilePath: 'b' })
      .catch((error: unknown) => error);

    expect(paused).toMatchObject({ message: 'firecracker PATCH /vm: no answer within 50 ms' });

    expect(snapshot).toMatchObject({
      message: 'firecracker PUT /snapshot/create: no answer within 100 ms',
    });
  } finally {
    await server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  }
});

test('a drive patch sends the drive id and its path, so Firecracker rereads the size', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));
  const socket = join(dir, 'api.sock');
  const seen: { method: string; path: string; body: unknown }[] = [];

  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.json(),
      });

      return new Response(null, { status: 204 });
    },
  });

  try {
    await createFirecrackerClient(socket).patchDrive('rootfs', '/var/lib/imp/imps/a/disk.ext4');

    expect(seen).toEqual([
      {
        method: 'PATCH',
        path: '/drives/rootfs',
        body: { drive_id: 'rootfs', path_on_host: '/var/lib/imp/imps/a/disk.ext4' },
      },
    ]);
  } finally {
    await server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  }
});

test('a template load names the imp tap and vsock socket in place of the snapshot ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));
  const socket = join(dir, 'api.sock');
  const seen: { method: string; path: string; body: unknown }[] = [];

  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.json(),
      });

      return new Response(null, { status: 204 });
    },
  });

  try {
    const api = createFirecrackerClient(socket);
    const files = { snapshotPath: '/t/vmstate', memFilePath: '/t/mem' };

    await api.loadSnapshot(files, {
      resumeVm: false,
      overrides: { ifaceId: 'eth0', hostDevName: 'imp-tap3', vsockPath: '/run/imp/a/vsock.sock' },
    });

    await api.loadSnapshot(files, { resumeVm: true });

    const mem = { backend_type: 'File', backend_path: '/t/mem' };

    expect(seen.map((call) => call.body)).toEqual([
      {
        snapshot_path: '/t/vmstate',
        mem_backend: mem,
        resume_vm: false,
        network_overrides: [{ iface_id: 'eth0', host_dev_name: 'imp-tap3' }],
        vsock_override: { uds_path: '/run/imp/a/vsock.sock' },
      },
      { snapshot_path: '/t/vmstate', mem_backend: mem, resume_vm: true },
    ]);
  } finally {
    await server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hot-plug calls send and read Firecracker’s fields, the stats in MiB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));
  const socket = join(dir, 'api.sock');
  const seen: { method: string; path: string; body: unknown }[] = [];

  // what Firecracker v1.17 answered on the dev box
  const answers: Readonly<Record<string, unknown>> = {
    '/hotplug/memory': {
      block_size_mib: 2,
      total_size_mib: 768,
      slot_size_mib: 128,
      plugged_size_mib: 256,
      requested_size_mib: 0,
    },
    '/balloon/statistics': {
      target_mib: 0,
      actual_mib: 0,
      total_memory: 1_033_113_600,
      available_memory: 128_856_064,
      free_memory: 197_984_256,
    },
  };

  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;

      seen.push({
        method: request.method,
        path,
        body: request.method === 'GET' ? null : await request.json(),
      });

      return request.method === 'GET'
        ? Response.json(answers[path])
        : new Response(null, { status: 204 });
    },
  });

  try {
    const client = createFirecrackerClient(socket);

    await client.putHotplugMemory({ totalSizeMib: 768, slotSizeMib: 128, blockSizeMib: 2 });
    await client.patchHotplugMemory(512);

    const hotplug = await client.getHotplugMemory();
    const stats = await client.getBalloonStats();

    expect(hotplug).toEqual({ pluggedMib: 256, requestedMib: 0 });
    expect(stats).toEqual({ totalMib: 985, availableMib: 122 });

    expect(seen.slice(0, 2)).toEqual([
      {
        method: 'PUT',
        path: '/hotplug/memory',
        body: { total_size_mib: 768, slot_size_mib: 128, block_size_mib: 2 },
      },
      { method: 'PATCH', path: '/hotplug/memory', body: { requested_size_mib: 512 } },
    ]);
  } finally {
    await server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  }
});
