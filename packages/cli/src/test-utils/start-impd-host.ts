import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { createIdleLoop } from '@imp/daemon/src/idle/idle-loop';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { invariant } from '@imp/test-utils/invariant';
import { createImpClient } from '@zgeoff/imp-client';

interface ImpdHostOptions {
  // impd settings over the boot values, such as IMP_KSM
  readonly env: Readonly<Record<string, string>>;
}

// One real impd a CLI child saves as a host, on the stub VMM with its own
// data dir, database, loopback port and generated root token; `ksm` sets
// each awake VM's KSM saving. Releases go into `stack`, the listener first.
export async function startImpdHost(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<ImpdHostOptions>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'imp-cli-host-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    ...options.env,
  });

  // the system drive impd boots imps with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();
  const ksm = { profitMib: 0 };

  // held a minute past every span a test opens, so an imp's awake time reads
  // the same on every call
  const clock = { nowMs: Date.now() + 60_000 };
  const rootToken = faker.string.alphanumeric(32);

  const impd = await createImpd(config, {
    db,
    rootToken,
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
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
    now: () => clock.nowMs,
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

    // the VMs' memory and KSM saving as /proc would show them
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      readUnsharedRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      checkGuestMerge: () => Promise.resolve(true),
      readKsmProfitMib: (pid) => {
        const profitMib = vmm.alive.has(pid) ? ksm.profitMib : null;

        return Promise.resolve(profitMib);
      },
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

  const app = impd.api.app.listen({ port: 0, hostname: '127.0.0.1' });

  stack.defer(async () => {
    await app.stop(true);
  });

  invariant(app.server?.port);

  const sendRequest = (request: Request) => impd.api.app.handle(request);

  // main.ts runs it on a ticker; a test runs one pass when it needs one
  const idle = createIdleLoop({ config, db, imps: impd.imps, log: () => {} });

  return {
    url: `http://127.0.0.1:${String(app.server.port)}`,
    rootToken,
    dataDir,
    db,
    ksm,
    sendRequest,
    runIdleCheck: idle.runCheck,

    // the root token's client, in process
    client: createImpClient({ url: 'http://impd.test', token: rootToken, fetch: sendRequest }),
  };
}
