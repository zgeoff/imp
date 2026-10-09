import { expect, test } from 'bun:test';
import { buildMockHostIdentity } from '../test-utils/build-mock-host-identity';
import { findOutdatedParts } from './vm-identity';

test('it finds nothing outdated in a VM booted as the host boots now', () => {
  const host = buildMockHostIdentity();

  expect(findOutdatedParts(host, host)).toStrictEqual([]);
});

test('it names each part the host has a newer one of', () => {
  const host = buildMockHostIdentity();

  expect(
    findOutdatedParts(
      { firecrackerVersion: 'v0.0.1', guestKernel: 'old', systemDrive: 'old' },
      host,
    ),
  ).toStrictEqual(['firecracker', 'kernel', 'agent']);
});

test.each([
  ['no prefix', null],
  ['a prefix left out by an older impd', undefined],
])('it names ipv6 for a VM with %s on a host with IPv6', (_label, ipv6Prefix) => {
  const host = buildMockHostIdentity({ ipv6Prefix: 'fd12:3456:789a::/64' });

  expect(findOutdatedParts({ ...host, ipv6Prefix }, host)).toStrictEqual(['ipv6']);
});

test('it names no ipv6 when the host has IPv6 off', () => {
  const host = buildMockHostIdentity({ ipv6Prefix: null });

  expect(findOutdatedParts(host, host)).toStrictEqual([]);
});
