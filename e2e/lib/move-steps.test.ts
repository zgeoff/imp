import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { updateEnv } from '@imp/test-utils/update-env';
import { createImpClient } from '../../packages/client/src/index';
import { loadConfig } from '../../packages/daemon/src/config';
import { createImpd } from '../../packages/daemon/src/create-impd';
import { createImage } from '../../packages/daemon/src/db/images';
import { openDatabase } from '../../packages/daemon/src/db/open-database';
import {
  buildImagePaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../../packages/daemon/src/storage/data-layout';
import { createXfsBackend } from '../../packages/daemon/src/storage/xfs-backend';
import { buildMockNewImage } from '../../packages/daemon/src/test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from '../../packages/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../../packages/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '../../packages/daemon/src/test-utils/find-free-ports';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { createInstance } from './instance';
import {
  buildUpstreamsPath,
  parseHostListing,
  parseNftSetAddresses,
  parseRpcAnswer,
  readAllowSet,
  readJailOwners,
  startMoveSend,
} from './move-steps';

// impd's real app on the stub VMM, listening on loopback as a host's API,
// and the client the test reads it back with
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'move-steps-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const dataDir = join(dir, 'data');

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    }),

    // a new disk stays the size of its image: the plain-copy clone copies
    // every byte
    defaultDiskBytes: 0,
  };

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // impd boots with a root token, the bearer the host's token file holds
  const rootToken = faker.string.alphanumeric(32);

  const impd = await createImpd(config, {
    db,
    rootToken,
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),

    // what system.info reports; the drive's hash names the drive file above
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // Firecracker, the kernel and the CPU as this host reports them, which a
    // snapshot must match to load
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => impd.api.app.handle(request),
  });

  stack.defer(() => server.stop(true));

  const client = createImpClient({
    url: 'http://impd.test',
    token: rootToken,
    fetch: (request) => impd.api.app.handle(request),
  });

  // the image an imp boots from when it names none, as impd's image
  // service leaves it: its rootfs under its digest
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  // a move's plan counts the image's config beside its rootfs
  await Bun.write(buildImagePaths(dataDir, image.digest).config, '{}');

  await createImage(db, image);

  return { dir, client, rootToken, apiUrl: `http://127.0.0.1:${String(server.port)}` };
}

test('#buildUpstreamsPath names the upstreams file in the host’s data dir', () => {
  const host = createInstance({
    container: 'imp-e2e-mv-b',
    dataDir: '/srv/imp/.data/e2e-mv-b',
    network: 'imp-e2e-mv',
    ip: '10.100.0.11',
  });

  expect(buildUpstreamsPath(host)).toBe('/srv/imp/.data/e2e-mv-b/broker-test-upstreams.json');
});

test('#parseRpcAnswer reads the json of an answer', () => {
  expect(parseRpcAnswer(false, { json: { code: 'LEASED', message: 'held' } })).toStrictEqual({
    ok: false,
    body: { code: 'LEASED', message: 'held' },
  });
});

test('#parseRpcAnswer rejects an answer without json', () => {
  expect(() => parseRpcAnswer(true, { result: 1 })).toThrow(
    expect.objectContaining({
      issues: expect.toPartiallyContain({ path: ['json'], code: 'invalid_type' }),
    }),
  );
});

test('#parseHostListing keeps the rows and imps that name the imp on each host', () => {
  const table = [
    'HOST  NAME        STATE    MOVE',
    'a     e2e-mv-seen stopped  sending',
    'a     e2e-mv-other running',
    'b     e2e-mv-seen-2 running',
    '',
  ].join('\n');

  const json = JSON.stringify({
    imps: [
      { host: 'a', name: 'e2e-mv-seen', move: 'sending', state: 'stopped' },
      { host: 'a', name: 'e2e-mv-other', state: 'running' },
      { host: 'b', name: 'e2e-mv-seen-2', state: 'running' },
    ],
  });

  expect(parseHostListing(table, json, 'e2e-mv-seen')).toStrictEqual({
    rows: ['a     e2e-mv-seen stopped  sending'],
    imps: [{ host: 'a', name: 'e2e-mv-seen', move: 'sending' }],
  });
});

test('#parseNftSetAddresses reads the IPv4 elements of a set', () => {
  const listed = [
    'table inet imp_egress {',
    '\tset allow4 {',
    '\t\ttype ipv4_addr',
    '\t\telements = { 93.184.215.14, 140.82.112.5,',
    '\t\t\t     140.82.112.6 }',
    '\t}',
    '}',
  ].join('\n');

  expect(parseNftSetAddresses(listed)).toStrictEqual([
    '93.184.215.14',
    '140.82.112.5',
    '140.82.112.6',
  ]);
});

test('#parseNftSetAddresses reads a set without elements as none', () => {
  expect(parseNftSetAddresses('table inet imp_egress {\n\tset allow4 {\n\t}\n}')).toStrictEqual([]);
});

test('#startMoveSend marks the imp sending on the source host', async () => {
  const ctx = await setupTest();

  // scripts/dev/dev.sh token reads the host's token through docker exec
  const docker = createStubBin(ctx.dir, 'docker', `echo ${ctx.rootToken}`);

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  await ctx.client.imps.create({ name: 'e2e-mv-seen' });
  await ctx.client.imps.stop({ name: 'e2e-mv-seen' });

  const host = {
    ...createInstance({ container: 'imp-e2e-a', dataDir: ctx.dir, network: 'n', ip: '127.0.0.1' }),
    apiUrl: ctx.apiUrl,
  };

  await startMoveSend(host, 'e2e-mv-seen');

  const imp = await ctx.client.imps.get({ name: 'e2e-mv-seen' });

  expect(imp.move).toBe('sending');
});

test('#startMoveSend rejects with the host’s error when the source refuses the move', async () => {
  const ctx = await setupTest();

  // scripts/dev/dev.sh token reads the host's token through docker exec
  const docker = createStubBin(ctx.dir, 'docker', `echo ${ctx.rootToken}`);

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const host = {
    ...createInstance({ container: 'imp-e2e-a', dataDir: ctx.dir, network: 'n', ip: '127.0.0.1' }),
    apiUrl: ctx.apiUrl,
  };

  expect(startMoveSend(host, 'e2e-mv-none')).rejects.toThrowWithMessage(
    Error,
    /^moves\/prepare for e2e-mv-none failed: .*"code":"NOT_FOUND"/v,
  );
});

test('#readAllowSet reads the addresses of the slot’s allow set in the host’s container', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    String.raw`printf 'table inet imp_egress {\n\tset allow7 {\n\t\telements = { 93.184.215.14, 140.82.112.5 }\n\t}\n}\n'`,
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const host = createInstance({
    container: 'imp-e2e-mv-b',
    dataDir: ctx.dir,
    network: 'n',
    ip: '10.100.0.11',
  });

  const allowed = await readAllowSet(host, 7);
  const calls = await readFile(docker.calls, 'utf8');

  expect(allowed).toStrictEqual(['93.184.215.14', '140.82.112.5']);
  expect(calls).toBe('docker exec imp-e2e-mv-b nft list set inet imp_egress allow7\n');
});

test('#readJailOwners reads the jail uid, then the owners of the disk and the tap, in the host’s container', async () => {
  const ctx = await setupTest();

  // the script, as the container's sh gets it, beside the stub's answer
  const docker = createStubBin(
    ctx.dir,
    'docker',
    `printf '%s' "$5" > '${join(ctx.dir, 'script')}'\nprintf '900007\\n900007\\n900007\\n'`,
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const host = createInstance({
    container: 'imp-e2e-mv-b',
    dataDir: ctx.dir,
    network: 'n',
    ip: '10.100.0.11',
  });

  const owners = await readJailOwners(host, 'imp-id-1', 7);
  const script = await readFile(join(ctx.dir, 'script'), 'utf8');

  expect(owners).toStrictEqual(['900007', '900007', '900007']);
  expect(script).toInclude("pgrep -f 'firecracker.*imps/imp-id-1/'");
  expect(script).toInclude('/var/lib/imp/imps/imp-id-1/disk.ext4');
  expect(script).toInclude('cat /sys/class/net/imp7/owner');
});
