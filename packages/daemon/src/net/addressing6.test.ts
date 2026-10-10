import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import {
  buildUlaPrefix,
  deriveGuestIp6,
  formatCidr6,
  formatIpv6,
  isInPrefix,
  parseIpv6,
  parsePrefix64,
} from './addressing6';

test.each([
  ['2001:0DB8:0:0:0:0:0:1', (0x20_01_0d_b8n << 96n) + 1n],
  ['::', 0n],
  ['::ffff:10.0.0.1', (0xff_ffn << 32n) + 0x0a_00_00_01n],
])('it reads %s as a number', (text, value) => {
  expect(parseIpv6(text)).toBe(value);
});

test('it writes an address in its canonical form', () => {
  expect(formatIpv6((0x20_01_0d_b8n << 96n) + 1n)).toBe('2001:db8::1');
});

test.each(['10.0.0.1', '1::2::3', 'fe80::1%eth0', '[::1]', 'example.com', '1:2:3:4:5:6:7:8:9'])(
  'it refuses %p as an IPv6 address',
  (text) => {
    expect(parseIpv6(text)).toBeNull();
  },
);

test('it reads a /64 with no host bits as the prefix', () => {
  expect(parsePrefix64('2001:db8:c:0::/64')).toStrictEqual({
    network: 0x20_01_0d_b8_00_0c_00_00n << 64n,
    text: '2001:db8:c::/64',
  });
});

test.each([
  ['2001:db8:c::/48', 'a /48'],
  ['2001:db8:c::1/64', 'a /64 with host bits'],
  ['2001:db8:c::', 'no prefix'],
  ['2001:db8:c::/64/1', 'two prefixes'],
  ['10.0.0.0/8', 'an IPv4 CIDR'],
])('it refuses %s, %s, as a /64', (cidr) => {
  expect(parsePrefix64(cidr)).toBeNull();
});

test('it builds a ULA prefix of fd, the 40-bit global ID and subnet 0', () => {
  const prefix = buildUlaPrefix(Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xff]));

  expect(prefix.text).toBe('fd12:3456:789a::/64');
});

test('it rejects fewer than 5 random bytes for a ULA global ID', () => {
  expect(() => buildUlaPrefix(Uint8Array.from([0x12, 0x34, 0x56, 0x78]))).toThrowWithMessage(
    Error,
    'a ULA global ID needs 5 random bytes',
  );
});

test('it gives an imp the prefix and its IPv4 address as the interface ID', () => {
  const prefix = parsePrefix64('fd12:3456:789a::/64');

  invariant(prefix);

  expect(deriveGuestIp6(prefix, 0x0a_42_00_02)).toBe('fd12:3456:789a::a42:2');
});

test.each([
  ['fd12:3456:789a::a42:2', true],
  ['fd12:3456:789b::a42:2', false],
  ['10.66.0.2', false],
])('it reads %s as in fd12:3456:789a::/64: %p', (address, isIn) => {
  const prefix = parsePrefix64('fd12:3456:789a::/64');

  invariant(prefix);

  expect(isInPrefix(prefix, address)).toBe(isIn);
});

test.each([
  ['2001:0DB8:000A::0001/64', '2001:db8:a::/64'],
  ['2001:db8::1', '2001:db8::1/128'],
  ['::/0', '::/0'],
])('it writes %s canonically as %s', (text, cidr) => {
  expect(formatCidr6(text)).toBe(cidr);
});

test.each(['2001:db8::/129', '2001:db8::/-1', '2001:db8::/1.5', '2001:db8::/64/1', '10.0.0.0/8'])(
  'it gives no CIDR for %p',
  (text) => {
    expect(formatCidr6(text)).toBeNull();
  },
);
