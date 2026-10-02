import { expect, test } from 'bun:test';
import { BLOCKED_RANGES6, createRangeChecker6, readMappedIpv4 } from './ranges6';

const isBlocked = createRangeChecker6(BLOCKED_RANGES6);

test('the blocklist covers local, special and translated IPv6 ranges', () => {
  for (const address of [
    'fd7a:115c:a1e0::1',
    'fd00:ec2::254',
    'fe80::1',
    'ff02::1',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::a9fe:a9fe',
    '::ffff:0:a9fe:a9fe',
    '100::1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:a9fe:a9fe::1',
    '2001:0:4136:e378::1',
  ]) {
    expect(isBlocked(address)).toBeTrue();
  }
});

test('a public IPv6 address passes, and anything else is blocked', () => {
  expect(isBlocked('2606:4700:4700::1111')).toBeFalse();
  expect(isBlocked('2001:db8:b::1')).toBeFalse();
  expect(isBlocked('8.8.8.8')).toBeTrue();
  expect(isBlocked('example.com')).toBeTrue();
});

test('an IPv4-mapped address reads as the IPv4 address it holds', () => {
  expect(readMappedIpv4('::ffff:169.254.169.254')).toBe('169.254.169.254');
  expect(readMappedIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
  expect(readMappedIpv4('2001:db8::1')).toBeNull();
});
