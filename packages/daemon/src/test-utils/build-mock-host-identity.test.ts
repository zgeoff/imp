import { expect, test } from 'bun:test';
import { buildMockHostIdentity } from './build-mock-host-identity';

test('it builds a default host identity', () => {
  const identity = buildMockHostIdentity();

  expect(identity).toStrictEqual({
    firecrackerVersion: expect.toStartWith('v'),
    snapshotVersion: expect.toStartWith('v'),
    hostKernel: expect.toBeString(),
    guestKernel: expect.toBeString(),
    systemDrive: expect.toBeString(),
    systemDrivePath: `/data/system/drives/${identity.systemDrive}.squashfs`,
    ipv6Prefix: null,
    cpuModel: expect.toBeString(),
    cpuFlags: expect.toBeString(),
  });
});

test('it derives the drive path from an overridden drive', () => {
  expect(buildMockHostIdentity({ systemDrive: 'drive-sha' }).systemDrivePath).toBe(
    '/data/system/drives/drive-sha.squashfs',
  );
});

test('it applies overrides on top of the defaults', () => {
  const identity = buildMockHostIdentity({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: 'kernel-sha',
    systemDrive: 'drive-sha',
    systemDrivePath: '/tmp/drive.squashfs',
    ipv6Prefix: 'fd12:3456:789a::/64',
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });

  expect(identity).toStrictEqual({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: 'kernel-sha',
    systemDrive: 'drive-sha',
    systemDrivePath: '/tmp/drive.squashfs',
    ipv6Prefix: 'fd12:3456:789a::/64',
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  });
});
