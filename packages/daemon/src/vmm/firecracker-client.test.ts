import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubFirecrackerApi } from '../test-utils/start-stub-firecracker-api';
import { createFirecrackerClient } from './firecracker-client';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { socket: join(dir, 'api.sock') };
}

test('it gives up on a call to a Firecracker that never answers after the request timeout', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, { isWedged: true });

  const client = createFirecrackerClient(ctx.socket, { requestMs: 50, snapshotMs: 100 });

  expect(client.pause()).rejects.toThrowWithMessage(
    Error,
    'firecracker PATCH /vm: no answer within 50 ms',
  );
});

test('it gives up on a snapshot that never finishes after the snapshot timeout', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, { isWedged: true });

  const client = createFirecrackerClient(ctx.socket, { requestMs: 50, snapshotMs: 100 });

  expect(
    client.createSnapshot({ snapshotPath: '/i1/vmstate', memFilePath: '/i1/mem' }),
  ).rejects.toThrowWithMessage(Error, 'firecracker PUT /snapshot/create: no answer within 100 ms');
});

test('it refuses to call a path that is not a socket', () => {
  const ctx = setupTest();

  writeFileSync(ctx.socket, '');

  expect(createFirecrackerClient(ctx.socket).pause()).rejects.toThrowWithMessage(
    Error,
    `${ctx.socket} is not a socket`,
  );
});

test('it refuses to call a socket path that does not exist', () => {
  const ctx = setupTest();

  expect(createFirecrackerClient(ctx.socket).pause()).rejects.toThrow(
    `ENOENT: no such file or directory, lstat '${ctx.socket}'`,
  );
});

test('it rejects a non-2xx answer with its status and body', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: {
      'PUT /actions': { status: 400, body: { fault_message: 'The VM is already running' } },
    },
  });

  expect(createFirecrackerClient(ctx.socket).instanceStart()).rejects.toMatchObject({
    name: 'FirecrackerApiError',
    status: 400,
    message: 'firecracker PUT /actions: 400 {"fault_message":"The VM is already running"}',
  });
});

test('it sends the boot source', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).putBootSource({
    kernelImagePath: '/kernel/vmlinux',
    bootArgs: 'console=ttyS0',
  });

  expect(api.calls).toStrictEqual([
    {
      method: 'PUT',
      path: '/boot-source',
      body: { kernel_image_path: '/kernel/vmlinux', boot_args: 'console=ttyS0' },
    },
  ]);
});

test('it sends the machine config', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).putMachineConfig({ vcpuCount: 2, memSizeMib: 512 });

  expect(api.calls).toStrictEqual([
    { method: 'PUT', path: '/machine-config', body: { vcpu_count: 2, mem_size_mib: 512 } },
  ]);
});

test('it sends a drive under its id', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).putDrive({
    driveId: 'rootfs',
    pathOnHost: '/i1/disk.ext4',
    isRootDevice: true,
    isReadOnly: false,
  });

  expect(api.calls).toStrictEqual([
    {
      method: 'PUT',
      path: '/drives/rootfs',
      body: {
        drive_id: 'rootfs',
        path_on_host: '/i1/disk.ext4',
        is_root_device: true,
        is_read_only: false,
      },
    },
  ]);
});

test('it patches a drive with its id and path, so Firecracker rereads the size', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).patchDrive('rootfs', '/var/lib/imp/imps/a/disk.ext4');

  expect(api.calls).toStrictEqual([
    {
      method: 'PATCH',
      path: '/drives/rootfs',
      body: { drive_id: 'rootfs', path_on_host: '/var/lib/imp/imps/a/disk.ext4' },
    },
  ]);
});

test('it sends a network interface under its id', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).putNetworkInterface({
    ifaceId: 'eth0',
    hostDevName: 'imp-tap3',
    guestMac: '06:00:ac:10:00:02',
  });

  expect(api.calls).toStrictEqual([
    {
      method: 'PUT',
      path: '/network-interfaces/eth0',
      body: { iface_id: 'eth0', host_dev_name: 'imp-tap3', guest_mac: '06:00:ac:10:00:02' },
    },
  ]);
});

test('it sends the vsock device', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).putVsock({ guestCid: 3, udsPath: '/i1/vsock.sock' });

  expect(api.calls).toStrictEqual([
    { method: 'PUT', path: '/vsock', body: { guest_cid: 3, uds_path: '/i1/vsock.sock' } },
  ]);
});

test('it sends the balloon', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).putBalloon({
    amountMib: 0,
    deflateOnOom: false,
    statsPollingIntervalS: 1,
    freePageReporting: true,
  });

  expect(api.calls).toStrictEqual([
    {
      method: 'PUT',
      path: '/balloon',
      body: {
        amount_mib: 0,
        deflate_on_oom: false,
        stats_polling_interval_s: 1,
        free_page_reporting: true,
      },
    },
  ]);
});

test('it starts the instance', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).instanceStart();

  expect(api.calls).toStrictEqual([
    { method: 'PUT', path: '/actions', body: { action_type: 'InstanceStart' } },
  ]);
});

test('it pauses the VM', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).pause();

  expect(api.calls).toStrictEqual([{ method: 'PATCH', path: '/vm', body: { state: 'Paused' } }]);
});

test('it resumes the VM', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).resume();

  expect(api.calls).toStrictEqual([{ method: 'PATCH', path: '/vm', body: { state: 'Resumed' } }]);
});

test('it takes a full snapshot that syncs its files', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).createSnapshot({
    snapshotPath: '/i1/vmstate',
    memFilePath: '/i1/mem',
  });

  expect(api.calls).toStrictEqual([
    {
      method: 'PUT',
      path: '/snapshot/create',
      body: {
        snapshot_type: 'Full',
        snapshot_path: '/i1/vmstate',
        mem_file_path: '/i1/mem',
        sync_snapshot_files: true,
      },
    },
  ]);
});

test('it loads a snapshot with the tap and vsock socket of the snapshot', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).loadSnapshot(
    { snapshotPath: '/t/vmstate', memFilePath: '/t/mem' },
    { resumeVm: true },
  );

  expect(api.calls).toStrictEqual([
    {
      method: 'PUT',
      path: '/snapshot/load',
      body: {
        snapshot_path: '/t/vmstate',
        mem_backend: { backend_type: 'File', backend_path: '/t/mem' },
        resume_vm: true,
      },
    },
  ]);
});

test('it loads a template with the imp tap and vsock socket in place of the snapshot ones', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).loadSnapshot(
    { snapshotPath: '/t/vmstate', memFilePath: '/t/mem' },
    {
      resumeVm: false,
      overrides: { ifaceId: 'eth0', hostDevName: 'imp-tap3', vsockPath: '/run/imp/a/vsock.sock' },
    },
  );

  expect(api.calls).toStrictEqual([
    {
      method: 'PUT',
      path: '/snapshot/load',
      body: {
        snapshot_path: '/t/vmstate',
        mem_backend: { backend_type: 'File', backend_path: '/t/mem' },
        resume_vm: false,
        network_overrides: [{ iface_id: 'eth0', host_dev_name: 'imp-tap3' }],
        vsock_override: { uds_path: '/run/imp/a/vsock.sock' },
      },
    },
  ]);
});

test('it sends the hot-plug region', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).putHotplugMemory({
    totalSizeMib: 768,
    slotSizeMib: 128,
    blockSizeMib: 2,
  });

  expect(api.calls).toStrictEqual([
    {
      method: 'PUT',
      path: '/hotplug/memory',
      body: { total_size_mib: 768, slot_size_mib: 128, block_size_mib: 2 },
    },
  ]);
});

test('it asks the guest for a plugged size', async () => {
  const ctx = setupTest();
  const api = startStubFirecrackerApi(ctx.socket);

  await createFirecrackerClient(ctx.socket).patchHotplugMemory(512);

  expect(api.calls).toStrictEqual([
    { method: 'PATCH', path: '/hotplug/memory', body: { requested_size_mib: 512 } },
  ]);
});

test('it reads what the guest holds plugged and was asked for', async () => {
  const ctx = setupTest();

  // what Firecracker v1.17 answered on the dev box
  startStubFirecrackerApi(ctx.socket, {
    answers: {
      'GET /hotplug/memory': {
        status: 200,
        body: {
          block_size_mib: 2,
          total_size_mib: 768,
          slot_size_mib: 128,
          plugged_size_mib: 256,
          requested_size_mib: 0,
        },
      },
    },
  });

  const hotplug = await createFirecrackerClient(ctx.socket).getHotplugMemory();

  expect(hotplug).toStrictEqual({ pluggedMib: 256, requestedMib: 0 });
});

test('it rejects a hot-plug answer that is not an object', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'GET /hotplug/memory': { status: 200, body: null } },
  });

  expect(createFirecrackerClient(ctx.socket).getHotplugMemory()).rejects.toThrowWithMessage(
    Error,
    'firecracker GET /hotplug/memory: unexpected body null',
  );
});

test('it rejects a hot-plug answer without the plugged size', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'GET /hotplug/memory': { status: 200, body: { requested_size_mib: 0 } } },
  });

  expect(createFirecrackerClient(ctx.socket).getHotplugMemory()).rejects.toThrowWithMessage(
    TypeError,
    'firecracker: no number plugged_size_mib in {"requested_size_mib":0}',
  );
});

test('it reads the balloon statistics in whole MiB', async () => {
  const ctx = setupTest();

  // what Firecracker v1.17 answered on the dev box
  startStubFirecrackerApi(ctx.socket, {
    answers: {
      'GET /balloon/statistics': {
        status: 200,
        body: {
          target_mib: 0,
          actual_mib: 0,
          total_memory: 1_033_113_600,
          available_memory: 128_856_064,
          free_memory: 197_984_256,
        },
      },
    },
  });

  const stats = await createFirecrackerClient(ctx.socket).getBalloonStats();

  expect(stats).toStrictEqual({ totalMib: 985, availableMib: 122 });
});

test('it rejects balloon statistics without the available memory', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'GET /balloon/statistics': { status: 200, body: { total_memory: 1_048_576 } } },
  });

  expect(createFirecrackerClient(ctx.socket).getBalloonStats()).rejects.toThrowWithMessage(
    TypeError,
    'firecracker: no number available_memory in {"total_memory":1048576}',
  );
});

test('it reads the Firecracker version', async () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'GET /version': { status: 200, body: { firecracker_version: '1.17.0' } } },
  });

  const version = await createFirecrackerClient(ctx.socket).getVersion();

  expect(version).toBe('1.17.0');
});

test('it rejects a version answer without the version', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'GET /version': { status: 200, body: { version: 1 } } },
  });

  expect(createFirecrackerClient(ctx.socket).getVersion()).rejects.toThrowWithMessage(
    Error,
    'firecracker GET /version: unexpected body {"version":1}',
  );
});

test('it reads the state of the instance', async () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'GET /': { status: 200, body: { id: 'i1', state: 'Paused' } } },
  });

  const state = await createFirecrackerClient(ctx.socket).getInstanceState();

  expect(state).toBe('Paused');
});

test('it rejects an instance state Firecracker does not have', () => {
  const ctx = setupTest();

  startStubFirecrackerApi(ctx.socket, {
    answers: { 'GET /': { status: 200, body: { id: 'i1', state: 'Sleeping' } } },
  });

  expect(createFirecrackerClient(ctx.socket).getInstanceState()).rejects.toMatchObject({
    name: 'ZodError',
  });
});
