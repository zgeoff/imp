import { expect, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockTemplateRestorePlan } from './build-mock-template-restore-plan';

test('it builds a default template restore plan', () => {
  const plan = buildMockTemplateRestorePlan();

  expect(plan).toStrictEqual({
    firecrackerBin: 'firecracker',
    paths: buildImpPaths('/data', plan.paths.impId),
    vmstate: expect.toEndWith('/vmstate'),
    memFile: expect.toEndWith('/mem'),
    systemDrivePath: expect.toEndWith('.squashfs'),
    placeholderPath: expect.toEndWith('/placeholder.ext4'),
    diskPath: plan.paths.disk,
    tap: expect.toStartWith('imp-'),
    cgroup: null,
    jail: null,
    diskReady: plan.diskReady,
    claim: {
      id: plan.paths.impId,
      hostname: expect.toBeString(),
      ip: '10.66.0.2/30',
      gw: '10.66.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: expect.toBeString(),
      seed: new Uint8Array(64),
      isIdentityReset: false,
    },
  });

  expect(plan.diskReady).resolves.toBeNumber();
});

test('it derives the disk path and the claim id from overridden paths', () => {
  const plan = buildMockTemplateRestorePlan({ paths: buildImpPaths('/srv', 'i1') });

  expect(plan.diskPath).toBe('/srv/imps/i1/disk.ext4');
  expect(plan.claim.id).toBe('i1');
});

test('it merges a partial claim override into the default claim', () => {
  const plan = buildMockTemplateRestorePlan({
    paths: buildImpPaths('/srv', 'i1'),
    claim: { hostname: 'dev', isIdentityReset: true },
  });

  expect(plan.claim).toStrictEqual({
    id: 'i1',
    hostname: 'dev',
    ip: '10.66.0.2/30',
    gw: '10.66.0.1',
    ip6: null,
    gw6: null,
    dns: ['1.1.1.1'],
    mac: expect.toBeString(),
    seed: new Uint8Array(64),
    isIdentityReset: true,
  });
});

test('it merges a partial paths override into the paths of its imp id', () => {
  const plan = buildMockTemplateRestorePlan({
    paths: { impId: 'i1', disk: '/elsewhere/disk.ext4' },
  });

  expect(plan.paths).toStrictEqual({
    ...buildImpPaths('/data', 'i1'),
    disk: '/elsewhere/disk.ext4',
  });

  expect(plan.diskPath).toBe('/elsewhere/disk.ext4');
});

test('it applies overrides on top of the defaults', () => {
  const diskReady = Promise.resolve(0);

  const claim = {
    id: 'other',
    hostname: 'dev',
    ip: '10.66.0.6/30',
    gw: '10.66.0.5',
    ip6: null,
    gw6: null,
    dns: ['8.8.8.8'],
    mac: '06:00:0a:42:00:06',
    seed: new Uint8Array(64),
    isIdentityReset: true,
  };

  const plan = buildMockTemplateRestorePlan({
    firecrackerBin: '/usr/local/bin/firecracker',
    paths: buildImpPaths('/srv', 'i1'),
    vmstate: '/t/vmstate',
    memFile: '/t/mem',
    systemDrivePath: '/t/system.squashfs',
    placeholderPath: '/t/placeholder.ext4',
    diskPath: '/t/disk.ext4',
    tap: 'imp-t0',
    cgroup: null,
    jail: { uid: 900_001, gid: 900_001 },
    diskReady,
    claim,
  });

  expect(plan).toStrictEqual({
    firecrackerBin: '/usr/local/bin/firecracker',
    paths: buildImpPaths('/srv', 'i1'),
    vmstate: '/t/vmstate',
    memFile: '/t/mem',
    systemDrivePath: '/t/system.squashfs',
    placeholderPath: '/t/placeholder.ext4',
    diskPath: '/t/disk.ext4',
    tap: 'imp-t0',
    cgroup: null,
    jail: { uid: 900_001, gid: 900_001 },
    diskReady,
    claim,
  });
});
