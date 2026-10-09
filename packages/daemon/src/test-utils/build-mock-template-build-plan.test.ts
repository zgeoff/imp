import { expect, test } from 'bun:test';
import { buildMockTemplateBuildPlan } from './build-mock-template-build-plan';

test('it builds a default template build plan', () => {
  const plan = buildMockTemplateBuildPlan();

  expect(plan).toStrictEqual({
    firecrackerBin: 'firecracker',
    kernelPath: '/data/system/vmlinux',
    systemDrivePath: expect.toEndWith('.squashfs'),
    bootArgs: 'console=ttyS0 imp.template=1',
    vcpus: expect.toBeNumber(),
    memoryMib: expect.toBeNumber(),
    workDir: expect.toStartWith('/data/templates/.build-'),
    paths: {
      runDir: `${plan.workDir}/run`,
      apiSocket: `${plan.workDir}/run/api.sock`,
      vsockSocket: `${plan.workDir}/run/vsock.sock`,
      logFile: `${plan.workDir}/run/firecracker.log`,
      pidFile: `${plan.workDir}/run/pid`,
    },
    placeholderPath: `${plan.workDir}/placeholder.ext4`,
    tap: 'imp-tpl',
    guestMac: '06:00:a9:fe:ff:fe',
    jailId: expect.toStartWith('tpl-'),
    jail: null,
    cgroup: null,
    minGuestUptimeMs: 0,
    snapshotDir: `${plan.workDir}/snapshot`,
    vmstate: `${plan.workDir}/snapshot/vmstate`,
    memFile: `${plan.workDir}/snapshot/mem`,
  });
});

test('it derives the run paths and the snapshot from an overridden work dir', () => {
  const plan = buildMockTemplateBuildPlan({ workDir: '/tmp/b' });

  expect(plan.paths.apiSocket).toBe('/tmp/b/run/api.sock');
  expect(plan.memFile).toBe('/tmp/b/snapshot/mem');
});

test('it applies overrides on top of the defaults', () => {
  const paths = {
    runDir: '/w/run',
    apiSocket: '/w/run/api.sock',
    vsockSocket: '/w/run/vsock.sock',
    logFile: '/w/run/firecracker.log',
    pidFile: '/w/run/pid',
  };

  const plan = buildMockTemplateBuildPlan({
    firecrackerBin: '/usr/local/bin/firecracker',
    kernelPath: '/k',
    systemDrivePath: '/s.squashfs',
    bootArgs: 'console=ttyS0',
    vcpus: 2,
    memoryMib: 1024,
    workDir: '/w',
    paths,
    placeholderPath: '/p.ext4',
    tap: 'imp-x',
    guestMac: '06:00:00:00:00:01',
    jailId: 'tpl-build',
    jail: { uid: 900_001, gid: 900_001 },
    cgroup: null,
    minGuestUptimeMs: 1500,
    snapshotDir: '/s',
    vmstate: '/s/v',
    memFile: '/s/m',
  });

  expect(plan).toStrictEqual({
    firecrackerBin: '/usr/local/bin/firecracker',
    kernelPath: '/k',
    systemDrivePath: '/s.squashfs',
    bootArgs: 'console=ttyS0',
    vcpus: 2,
    memoryMib: 1024,
    workDir: '/w',
    paths,
    placeholderPath: '/p.ext4',
    tap: 'imp-x',
    guestMac: '06:00:00:00:00:01',
    jailId: 'tpl-build',
    jail: { uid: 900_001, gid: 900_001 },
    cgroup: null,
    minGuestUptimeMs: 1500,
    snapshotDir: '/s',
    vmstate: '/s/v',
    memFile: '/s/m',
  });
});
