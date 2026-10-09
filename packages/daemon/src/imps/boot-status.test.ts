import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpState } from '@imp/api';
import { writeVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';
import { countBootStatuses, readBootStatus } from './boot-status';
import type { BootStatus } from './boot-status';
import { writeTestSnapshot } from './test-imps';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-boot-status-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const paths = buildImpPaths(dir, 'imp-a');

  // vm.json sits in the imp's dir, which a create makes
  mkdirSync(paths.dir, { recursive: true });

  // the agent drive a snapshot reopens by path; a snapshot whose drive is
  // missing boots cold
  const systemDrivePath = join(dir, 'system-drive.squashfs');

  writeFileSync(systemDrivePath, 'drive');

  return { paths, systemDrivePath };
}

test('#readBootStatus says a sleeping imp with no snapshot boots cold', () => {
  const ctx = setupTest();

  const status = readBootStatus({ state: 'sleeping' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({ coldBootReason: 'no snapshot it can load' });
});

test('#readBootStatus says a sleeping imp boots cold on a newer firecracker, and why', () => {
  const ctx = setupTest();

  writeTestSnapshot(ctx.paths, 1000, {
    firecrackerVersion: 'v1.16.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
  });

  const status = readBootStatus({ state: 'sleeping' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({
    coldBootReason: 'firecrackerVersion changed (v1.16.0 → v1.17.0)',
  });
});

test('#readBootStatus lists the parts a sleeping imp whose snapshot still loads predates', () => {
  const ctx = setupTest();

  writeTestSnapshot(ctx.paths, 1000, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-0',
    systemDrive: 'drive-0',
    systemDrivePath: ctx.systemDrivePath,
  });

  const status = readBootStatus({ state: 'sleeping' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({ outdated: ['kernel', 'agent'] });
});

test('#readBootStatus says nothing of a sleeping imp whose snapshot matches the host', () => {
  const ctx = setupTest();

  writeTestSnapshot(ctx.paths, 1000, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
  });

  const status = readBootStatus({ state: 'sleeping' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({});
});

test('#readBootStatus says a running imp booted without a recorded identity is outdated by impd', () => {
  const ctx = setupTest();

  const status = readBootStatus({ state: 'running' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({ outdated: ['impd'] });
});

test('#readBootStatus keeps the reason a running imp last booted cold', () => {
  const ctx = setupTest();

  writeVmIdentity(ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    agentVersion: '0.15.0',
    bootReason: 'no snapshot it can load',
  });

  const status = readBootStatus({ state: 'running' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({ coldBootReason: 'no snapshot it can load' });
});

test('#readBootStatus lists the parts a running imp booted before the host had them', () => {
  const ctx = setupTest();

  writeVmIdentity(ctx.paths, {
    firecrackerVersion: 'v1.16.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    agentVersion: '0.15.0',
    bootReason: null,
  });

  const status = readBootStatus({ state: 'running' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({ outdated: ['firecracker'] });
});

test('#readBootStatus says a running imp booted without the host IPv6 prefix is outdated by ipv6', () => {
  const ctx = setupTest();

  writeVmIdentity(ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    agentVersion: '0.15.0',
    bootReason: null,
    ipv6Prefix: null,
  });

  const status = readBootStatus({ state: 'running' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    ipv6Prefix: '2001:db8:a::/64',
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({ outdated: ['ipv6'] });
});

test('#readBootStatus says nothing of a stopped imp, even with a snapshot on disk', () => {
  const ctx = setupTest();

  writeTestSnapshot(ctx.paths, 1000, {
    firecrackerVersion: 'v1.16.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
  });

  const status = readBootStatus({ state: 'stopped' }, ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.1.0',
    guestKernel: 'kernel-1',
    systemDrive: 'drive-1',
    systemDrivePath: ctx.systemDrivePath,
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(status).toStrictEqual({});
});

test('#countBootStatuses counts each sleeping imp with a reason as a cold boot, and the old parts of the rest', () => {
  const counts = countBootStatuses<{ state: ImpState; status: BootStatus }>(
    [
      { state: 'sleeping', status: { coldBootReason: 'firecrackerVersion changed' } },
      { state: 'sleeping', status: { coldBootReason: 'no snapshot it can load' } },
      { state: 'sleeping', status: { outdated: ['agent', 'kernel'] } },
      { state: 'sleeping', status: {} },
    ],
    (imp) => imp.status,
  );

  expect(counts).toStrictEqual({
    coldBoots: 2,
    outdated: { firecracker: 0, kernel: 1, agent: 1 },
  });
});

test('#countBootStatuses counts a running imp on an older firecracker or with no identity as a cold boot', () => {
  const counts = countBootStatuses<{ state: ImpState; status: BootStatus }>(
    [
      { state: 'running', status: { outdated: ['firecracker'] } },
      { state: 'running', status: { outdated: ['impd'] } },
      { state: 'running', status: { outdated: ['agent'] } },
      { state: 'running', status: { outdated: ['kernel', 'agent'] } },
    ],
    (imp) => imp.status,
  );

  expect(counts).toStrictEqual({
    coldBoots: 2,
    outdated: { firecracker: 1, kernel: 1, agent: 2 },
  });
});

test('#countBootStatuses does not count a running imp again for the reason its last boot was cold', () => {
  const counts = countBootStatuses<{ state: ImpState; status: BootStatus }>(
    [{ state: 'running', status: { coldBootReason: 'its agent drive d1d1d1d1d1d1 is gone' } }],
    (imp) => imp.status,
  );

  expect(counts).toStrictEqual({
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 0, agent: 0 },
  });
});

test('#countBootStatuses counts the imps without IPv6 apart from the outdated parts', () => {
  const counts = countBootStatuses<{ state: ImpState; status: BootStatus }>(
    [
      { state: 'running', status: { outdated: ['ipv6'] } },
      { state: 'sleeping', status: { outdated: ['agent', 'ipv6'] } },
    ],
    (imp) => imp.status,
  );

  expect(counts).toStrictEqual({
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 0, agent: 1, ipv6: 2 },
  });
});

test('#countBootStatuses never reads a stopped, failed or creating imp', () => {
  const imps = [
    { state: 'stopped', status: { coldBootReason: 'no snapshot it can load' } },
    { state: 'error', status: { coldBootReason: 'no snapshot it can load' } },
    { state: 'creating', status: { outdated: ['firecracker'] } },
  ] as const;

  const read = mock((imp: (typeof imps)[number]) => imp.status);

  countBootStatuses(imps, read);

  expect(read).not.toHaveBeenCalled();
});

test('#countBootStatuses counts nothing for stopped, failed or creating imps', () => {
  const counts = countBootStatuses<{ state: ImpState; status: BootStatus }>(
    [
      { state: 'stopped', status: { coldBootReason: 'no snapshot it can load' } },
      { state: 'error', status: { coldBootReason: 'no snapshot it can load' } },
      { state: 'creating', status: { outdated: ['firecracker'] } },
    ],
    (imp) => imp.status,
  );

  expect(counts).toStrictEqual({
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 0, agent: 0 },
  });
});
